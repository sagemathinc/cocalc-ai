/*
Finding 028 B-3a: the start-up preconditions of disk-stream service (DESIGN
v1.21 §3.2.5 start-up rule, §3.2.1 SA T3, vanta R1 / N-3, Q9).

If the records root is not a per-boot tmpfs directory owned by us and not
group/other-writable, or the NOFILE limit is too low, DISK-stream service is
refused with code persist_unavailable (and a page); ephemeral streams still
run.
*/

import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import {
  MIN_NOFILE,
  checkNofile,
  checkPersistRunDir,
} from "@cocalc/backend/conat/persist-durability";
import * as context from "@cocalc/conat/persist/context";
import { DataEncoding } from "@cocalc/conat/core/client";

describe("028 B-3a: start-up preconditions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-start-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a private directory we own passes (tmpfs not required in this test)", () => {
    expect(checkPersistRunDir(dir, { allowNonTmpfs: true })).toBeUndefined();
  });

  it("a records root on a non-tmpfs filesystem is refused when tmpfs is required", () => {
    // the test dir's filesystem: refused unless it really is tmpfs
    const type = Number((fs as any).statfsSync(dir).type);
    const r = checkPersistRunDir(dir, { allowNonTmpfs: false });
    if (type === 0x01021994) expect(r).toBeUndefined();
    else expect(r).toMatch(/not on tmpfs/);
  });

  it("group- or other-writable is refused", () => {
    fs.chmodSync(dir, 0o770);
    expect(checkPersistRunDir(dir, { allowNonTmpfs: true })).toMatch(
      /writable by group or others/,
    );
    fs.chmodSync(dir, 0o707);
    expect(checkPersistRunDir(dir, { allowNonTmpfs: true })).toMatch(
      /writable by group or others/,
    );
  });

  it("another owner is refused", () => {
    expect(
      checkPersistRunDir(dir, { allowNonTmpfs: true, uid: (process.getuid?.() ?? 0) + 1 }),
    ).toMatch(/owned by uid/);
  });

  it("a symlink or a file is refused; a missing root is created 0700", () => {
    const file = join(dir, "f");
    fs.writeFileSync(file, "");
    expect(checkPersistRunDir(file, { allowNonTmpfs: true })).toMatch(
      /not a directory/,
    );
    const link = join(dir, "l");
    fs.symlinkSync(dir, link);
    expect(checkPersistRunDir(link, { allowNonTmpfs: true })).toMatch(
      /not a directory/,
    );
    const missing = join(dir, "new");
    expect(checkPersistRunDir(missing, { allowNonTmpfs: true })).toBeUndefined();
    expect(fs.statSync(missing).mode & 0o777).toBe(0o700);
  });

  it("NOFILE: below the minimum is refused; enough or unlimited passes; no /proc is not checked", () => {
    const limits = (soft: string) =>
      `Limit                     Soft Limit           Hard Limit           Units\nMax open files            ${soft}                 1048576              files\n`;
    expect(checkNofile(() => limits("1024"))).toMatch(/below/);
    expect(checkNofile(() => limits(`${MIN_NOFILE}`))).toBeUndefined();
    expect(checkNofile(() => limits("unlimited"))).toBeUndefined();
    expect(
      checkNofile(() => {
        throw Error("ENOENT");
      }),
    ).toBeUndefined();
    expect(checkNofile(() => "garbage")).toMatch(/can't parse/);
  });

  it("a failed precondition refuses DISK streams with persist_unavailable; ephemeral streams still run", () => {
    const ctx = context as any;
    const real = ctx.startupCheck;
    ctx.startupCheck = () => ({ ok: false, reason: "records root not on tmpfs" });
    try {
      expect(() => pstream({ path: join(dir, "disk") })).toThrow(
        "disk-backed streams are unavailable",
      );
      const eph = pstream({ path: join(dir, "eph"), ephemeral: true });
      eph.set({ encoding: DataEncoding.JsonCodec, raw: Buffer.from("x") });
      eph.close();
    } finally {
      ctx.startupCheck = real;
    }
  });
});
