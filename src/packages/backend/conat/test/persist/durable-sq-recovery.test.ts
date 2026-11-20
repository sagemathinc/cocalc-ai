/*
Finding 028 B-2: S-q, the same-boot recovery of a project poisoned by a
quota error at fsync (Q-F), DESIGN v1.21 §3.2.6.

Only in a NEW persist process (its generation did not write the poison, so
it holds no connection to the files): a trusted, bounded inventory of the
project's store; for each file a verified eviction; then an integrity_check
of each database; then the project record and its streams' project-scope
records go.  Any failure: the project stays poisoned.  A file poisoned by a
device error is never cleared by S-q.
*/

import * as fs from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import {
  persistDurabilityRecords,
  sha256Hex,
} from "@cocalc/backend/conat/persist-durability";
import { persistInventory } from "@cocalc/backend/conat/persist-verified-eviction";
import { createDurabilityRecords } from "@cocalc/conat/persist/durability-records";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  clearOpenBarrierPass,
  prepareDurableOpen,
} from "@cocalc/conat/persist/storage";
import { evictionIt, probeEvictable } from "./evictable-probe";

// S-q verifies each file before it clears a project: the tests that need it
// to succeed need a test directory whose page cache can be dropped (see
// evictable-probe.ts; a real skip only on "pages still resident").
const itEvicts = evictionIt(probeEvictable(tmpdir()));

const msg = (s: string) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
});

// the records an EARLIER persist process left after a Q-F poison
function earlierProcessPoisonedProject(owner: string, ids: string[]) {
  const earlier = createDurabilityRecords({
    root: persistDurabilityRecords().root,
    generation: `earlier-${Math.random()}`,
    fs: fs as any,
    sha256: sha256Hex,
    pid: 0,
  });
  for (const id of ids) {
    earlier.arm(id, owner);
    earlier.poison(id, { where: "test", scope: "project", owner });
  }
  earlier.poisonProject(owner, { where: "test", errno: "EDQUOT" });
}

describe("028 B-2: S-q recovery of a poisoned project", () => {
  let root: string;
  let streams: any[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "persist-028-sq-"));
    streams = [];
  });
  afterEach(async () => {
    for (const s of streams) {
      try {
        if (!s.isPoisoned?.()) s.close();
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });

  function makeStreams(names: string[]): string[] {
    return names.map((name) => {
      const path = join(root, name);
      const s = pstream({ path });
      s.set(msg(name));
      s.close();
      return path;
    });
  }

  it("the inventory lists the store's databases, and refuses a symlink or a foreign file type", async () => {
    const [a, b] = makeStreams(["a", "b"]);
    expect(await persistInventory(root)).toEqual([`${a}.db`, `${b}.db`].sort());
    await symlink("/etc/passwd", join(root, "x.db"));
    expect(await persistInventory(root)).toBeUndefined();
  });

  itEvicts(
    "a project poisoned by an earlier process is verified and cleared at the next open; its streams are served",
    async () => {
      const owner = "55555555-2222-4333-8444-555555555555";
      const [a, b] = makeStreams(["sq-a", "sq-b"]);
      earlierProcessPoisonedProject(owner, [a, b]);
      const records = persistDurabilityRecords();
      expect(records.check(a, owner)).toBe("poisoned");
      await prepareDurableOpen(a, owner, root);
      const s = pstream({ path: a });
      streams.push(s);
      clearOpenBarrierPass(a);
      expect(records.check(a, owner)).toBe("ok");
      expect(records.check(b, owner)).toBe("ok");
      expect(Buffer.from(s.get({ seq: 1 })!.raw).toString()).toBe("sq-a");
    },
  );

  it("an ambiguous inventory keeps the project poisoned", async () => {
    const owner = "66666666-2222-4333-8444-555555555555";
    const [a] = makeStreams(["amb-a"]);
    await symlink("/etc/passwd", join(root, "amb-x.db"));
    earlierProcessPoisonedProject(owner, [a]);
    await expect(prepareDurableOpen(a, owner, root)).rejects.toThrow(
      "had a sync error",
    );
    expect(persistDurabilityRecords().check(a, owner)).toBe("poisoned");
  });

  it("a poison written by THIS process is never recovered by S-q (its connection may still be open)", async () => {
    const owner = "77777777-2222-4333-8444-555555555555";
    const [a] = makeStreams(["same-a"]);
    const records = persistDurabilityRecords();
    records.poisonProject(owner, { where: "test" });
    await expect(prepareDurableOpen(a, owner, root)).rejects.toThrow(
      "had a sync error",
    );
    expect(records.check(a, owner)).toBe("poisoned");
  });

  itEvicts(
    "a file poisoned by a DEVICE error stays poisoned after S-q clears its project",
    async () => {
      const owner = "88888888-2222-4333-8444-555555555555";
      const [a, b] = makeStreams(["dev-a", "dev-b"]);
      earlierProcessPoisonedProject(owner, [a]);
      const earlier = createDurabilityRecords({
        root: persistDurabilityRecords().root,
        generation: `earlier-dev-${Math.random()}`,
        fs: fs as any,
        sha256: sha256Hex,
        pid: 0,
      });
      earlier.arm(b, owner);
      earlier.poison(b, { where: "test", errno: "EIO" }); // file scope
      await prepareDurableOpen(a, owner, root);
      const s = pstream({ path: a });
      streams.push(s);
      clearOpenBarrierPass(a);
      expect(persistDurabilityRecords().check(b, owner)).toBe("poisoned");
    },
  );

  it("a damaged database fails S-q's integrity_check: the project stays poisoned", async () => {
    const owner = "99999999-2222-4333-8444-555555555555";
    const [a] = makeStreams(["bad-a"]);
    const fd = fs.openSync(`${a}.db`, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096);
    fs.closeSync(fd);
    earlierProcessPoisonedProject(owner, [a]);
    await expect(prepareDurableOpen(a, owner, root)).rejects.toThrow(
      "had a sync error",
    );
    expect(persistDurabilityRecords().check(a, owner)).toBe("poisoned");
  });
});
