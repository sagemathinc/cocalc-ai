/*
When a document is saved to disk, the saver records the proof that the file
is the document's value: the seq its value covered and the hash of the exact
bytes it wrote (bounded history design, H1b).  The value and the seq are
captured together, before the write, so a remote edit that arrives while the
file is being written, or before it was applied, is never claimed.

pnpm test ./file-proof.test.ts
*/

import { createHash } from "node:crypto";
import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  wait,
  delay,
} from "./setup";
import { SAVED_FILE_CHECKPOINT } from "@cocalc/sync/editor/generic/file-proof";

beforeAll(before);
afterAll(after);
jest.setTimeout(30000);

const sha256 = (s: string) =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

describe("the saved file proof", () => {
  const project_id = uuid();
  const docs: any[] = [];
  const open = async (path: string) => {
    const doc = connect().sync.string({
      project_id,
      path,
      service: server.service,
      noAutosave: true,
      noBackendFsWatch: true,
      firstReadLockTimeout: 1,
    });
    docs.push(doc);
    await once(doc, "ready");
    return doc;
  };
  afterAll(async () => {
    for (const doc of docs) {
      try {
        await doc.close();
      } catch {}
    }
  });

  const proofOf = (doc) =>
    (doc as any).dstream().getCheckpoint(SAVED_FILE_CHECKPOINT);
  const newestSeq = (doc) => (doc as any).dstream().receivedThroughSeq();
  // edit doc and wait until other has applied the edit
  const remoteEdit = async (doc, other, value: string) => {
    doc.from_str(value);
    doc.commit();
    await doc.save();
    await wait({ until: () => other.to_str() === value });
  };

  it("records the seq the saved value covers and the hash of the bytes written", async () => {
    const a = await open("proof-basic.txt");
    a.from_str("Hello ü 😀");
    a.commit();
    await a.save();
    await a.save_to_disk();
    await wait({ until: () => proofOf(a) != null });
    expect(proofOf(a)).toMatchObject({
      seq: newestSeq(a),
      data: {
        sha256: sha256("Hello ü 😀"),
        bytes: Buffer.byteLength("Hello ü 😀", "utf8"),
        epoch: 0,
      },
    });
  });

  it("records no proof for a value with a remote edit received but not yet applied", async () => {
    const a = await open("proof-pending.txt");
    const b = await open("proof-pending.txt");
    await remoteEdit(a, b, "one");
    await a.save_to_disk();
    await wait({ until: () => proofOf(a)?.data?.sha256 === sha256("one") });
    const before = proofOf(a);
    // When b's next edit reaches a, a's patches table reports it; applying
    // it waits for a microtask.  Capture right then, in that same step.
    let captured: Promise<void> | undefined;
    (a as any).patches_table.once("change", () => {
      captured = (a as any).writeFile();
    });
    b.from_str("two");
    b.commit();
    await b.save();
    await wait({ until: () => captured != null && a.to_str() === "two" });
    await captured;
    await delay(200);
    // the file was written, with "one" (captured before "two" applied) ...
    // ... but no proof claims the seq that "two" has
    expect(proofOf(a)).toEqual(before);
  });

  it("records the seq captured before the write, not one reached during it", async () => {
    const a = await open("proof-during-write.txt");
    const b = await open("proof-during-write.txt");
    await remoteEdit(a, b, "first");
    const fs = (a as any).fs;
    const write = fs.writeFileDelta;
    let capturedSeq: number | undefined;
    fs.writeFileDelta = async (...args) => {
      capturedSeq = newestSeq(a);
      // a remote edit arrives and is applied while the file is written
      await remoteEdit(b, a, "second");
      expect(newestSeq(a)).toBeGreaterThan(capturedSeq);
      return await write.apply(fs, args);
    };
    try {
      await (a as any).writeFile();
    } finally {
      fs.writeFileDelta = write;
    }
    await wait({ until: () => proofOf(a)?.data?.sha256 === sha256("first") });
    expect(proofOf(a).seq).toBe(capturedSeq);
    expect(proofOf(a).seq).toBeLessThan(newestSeq(a));
  });

  it("records no proof when the write fails, or the epoch changed during it", async () => {
    const a = await open("proof-failures.txt");
    a.from_str("v1");
    a.commit();
    await a.save();
    await a.save_to_disk();
    await wait({ until: () => proofOf(a)?.data?.sha256 === sha256("v1") });
    const fs = (a as any).fs;
    const write = fs.writeFileDelta;

    a.from_str("v2");
    a.commit();
    await a.save();
    fs.writeFileDelta = async () => {
      throw Error("disk full");
    };
    await expect((a as any).writeFile()).rejects.toThrow("disk full");
    await delay(200);
    expect(proofOf(a).data.sha256).toBe(sha256("v1"));

    fs.writeFileDelta = async (...args) => {
      // e.g., the history was reset while the file was written
      (a as any).history_epoch = ((a as any).history_epoch ?? 0) + 1;
      return await write.apply(fs, args);
    };
    try {
      await (a as any).writeFile();
    } finally {
      fs.writeFileDelta = write;
      (a as any).history_epoch -= 1;
    }
    await delay(200);
    expect(proofOf(a).data.sha256).toBe(sha256("v1"));
  });

  it("records no proof for a value over 32 MiB", async () => {
    const a = await open("proof-large.txt");
    const fs = (a as any).fs;
    const write = fs.writeFileDelta;
    // the bytes are not written, only the proof is checked
    fs.writeFileDelta = async () => {};
    try {
      // 11 Mi characters, 33 MiB of UTF-8
      a.from_str("€".repeat(11 * 1024 * 1024));
      a.commit();
      await a.save();
      await (a as any).writeFile();
    } finally {
      fs.writeFileDelta = write;
    }
    await delay(200);
    expect(proofOf(a)).toBeUndefined();
  });
});
