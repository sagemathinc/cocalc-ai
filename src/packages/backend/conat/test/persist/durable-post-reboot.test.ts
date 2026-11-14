/*
Finding 028 B-2: the durable post-reboot poison record (DESIGN v1.21
§3.2.5 (b), §3.2.6 POST-REBOOT).

The tmpfs records vanish at a reboot, together with the page cache they are
about; the disk is then the truth, but the device may have damaged the file.
So a poison also writes a durable record on the persistent state directory
(temp, fsync, rename, directory fsync), and after the reboot the stream is
opened only after a full integrity_check passes (off the main thread); only
then is that record removed.  Failing to write it is not fatal: it is
retried, with an alert.
*/

import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import {
  integrityCheckClosedDatabase,
  persistDurabilityRecords,
  persistStateDir,
  sha256Hex,
} from "@cocalc/backend/conat/persist-durability";
import * as context from "@cocalc/conat/persist/context";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  clearOpenBarrierPass,
  prepareDurableOpen,
} from "@cocalc/conat/persist/storage";

const msg = (s: string) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
});

const postRebootPath = (id: string) =>
  join(persistStateDir()!, "poisoned", sha256Hex(id));

// a reboot, as far as the records are concerned: the tmpfs ones are gone
function simulateReboot(id: string) {
  const records = persistDurabilityRecords();
  fs.rmSync(records.poisonedPath(id), { force: true });
  fs.rmSync(records.dirtyPath(id), { force: true });
}

describe("028 B-2: the post-reboot record and integrity_check", () => {
  let dir: string;
  let streams: any[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-reboot-"));
    streams = [];
  });
  afterEach(async () => {
    for (const s of streams) {
      try {
        if (!s.isPoisoned?.()) s.close();
      } catch {}
    }
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  // a closed stream with one message, then a poison of its records (as a
  // sync error in an earlier boot would have left them)
  function poisonedClosedStream(name: string): string {
    const path = join(dir, name);
    const s = pstream({ path });
    s.set(msg("committed"));
    s.close();
    const records = persistDurabilityRecords();
    records.arm(path);
    records.poison(path, { where: "test", errcode: 1034 });
    return path;
  }

  it("a poison writes the durable record, outside the stream's directory", () => {
    const path = poisonedClosedStream("written");
    const record = postRebootPath(path);
    expect(fs.existsSync(record)).toBe(true);
    expect(record.startsWith(dir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(record, "utf8"))).toMatchObject({
      kind: "poisoned",
      id: path,
    });
  });

  it("after a reboot the stream is refused until its integrity_check passes; then the record is removed and it is served", async () => {
    const path = poisonedClosedStream("reboot-ok");
    simulateReboot(path);
    const records = persistDurabilityRecords();
    expect(records.check(path)).toBe("needs-check");
    // a direct construction can't run the check: refused
    expect(() => pstream({ path })).toThrow("not verified yet");
    await prepareDurableOpen(path, "host");
    const s = pstream({ path });
    streams.push(s);
    clearOpenBarrierPass(path);
    expect(fs.existsSync(postRebootPath(path))).toBe(false);
    expect(records.check(path)).toBe("ok");
    expect(Buffer.from(s.get({ seq: 1 })!.raw).toString()).toBe("committed");
  });

  it("a failed integrity_check keeps refusing and keeps the record", async () => {
    const path = poisonedClosedStream("reboot-bad");
    simulateReboot(path);
    // damage the file the way a device might: garbage over a page
    const fd = fs.openSync(`${path}.db`, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096);
    fs.closeSync(fd);
    await expect(prepareDurableOpen(path, "host")).rejects.toThrow(
      "not verified yet",
    );
    expect(fs.existsSync(postRebootPath(path))).toBe(true);
    expect(persistDurabilityRecords().check(path)).toBe("needs-check");
  });

  it("the integrity_check runs in a child process and reports damage", async () => {
    const path = join(dir, "direct");
    const s = pstream({ path });
    s.set(msg("x"));
    s.close();
    expect(await integrityCheckClosedDatabase(`${path}.db`)).toEqual({
      ok: true,
    });
    fs.writeFileSync(`${path}.db`, Buffer.alloc(8192, 0xcd));
    expect((await integrityCheckClosedDatabase(`${path}.db`)).ok).toBe(false);
  });

  it("maintenance opens refuse a stream whose post-reboot check is pending", () => {
    const path = poisonedClosedStream("maint");
    simulateReboot(path);
    const {
      assertPersistMaintenanceOpenAllowed,
    } = require("@cocalc/backend/conat/persist-durability");
    expect(() => assertPersistMaintenanceOpenAllowed(`${path}.db`)).toThrow(
      "needs-check",
    );
  });

  it("if the record can't be written, the poison still stands (tmpfs) and the write is retried", () => {
    const records = persistDurabilityRecords();
    const stateDir = persistStateDir()!;
    const poisonedDir = join(stateDir, "poisoned");
    fs.mkdirSync(poisonedDir, { recursive: true });
    fs.chmodSync(poisonedDir, 0o500); // not writable
    try {
      const path = join(dir, "unwritable");
      records.arm(path);
      records.poison(path, { where: "test" });
      expect(records.check(path)).toBe("poisoned");
      expect(records.postRebootPending()).toBeGreaterThan(0);
      fs.chmodSync(poisonedDir, 0o700);
      expect(records.retryPostReboot()).toBe(0);
      expect(fs.existsSync(postRebootPath(path))).toBe(true);
    } finally {
      fs.chmodSync(poisonedDir, 0o700);
    }
  });

  it("without an integrity check configured, a needs-check stream stays refused", async () => {
    const path = poisonedClosedStream("no-checker");
    simulateReboot(path);
    const ctx = context as any;
    const real = ctx.integrityCheck;
    ctx.integrityCheck = undefined;
    try {
      await expect(prepareDurableOpen(path, "host")).rejects.toThrow(
        "not verified yet",
      );
    } finally {
      ctx.integrityCheck = real;
    }
  });
});
