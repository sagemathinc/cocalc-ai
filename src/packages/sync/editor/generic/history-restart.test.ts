import { createHash } from "node:crypto";
import { DataEncoding, decode } from "@cocalc/conat/core/codec";
import {
  ProofReads,
  proofCoversHistory,
  resetOptions,
  savedFileOf,
  savesThroughWriteFile,
  seedFor,
  validProof,
} from "./history-restart";

const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

const file = savedFileOf(bytes("Hello ü"))!;
const proofFor = (seq: number, epoch = 1, sha256 = file.sha256) => ({
  seq,
  data: { sha256, bytes: file.bytes, epoch },
});

describe("savedFileOf", () => {
  it("decodes UTF-8 and hashes exactly the bytes read", () => {
    expect(file).toEqual({
      value: "Hello ü",
      sha256: hex("Hello ü"),
      bytes: 8,
    });
  });
  it("keeps a leading byte order mark, which the hash covers", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("Hello")]);
    const f = savedFileOf(withBom)!;
    expect(f.value).toBe("\ufeffHello");
    expect(f.bytes).toBe(8);
    expect(f.sha256).toBe(
      createHash("sha256").update(Buffer.from(withBom)).digest("hex"),
    );
    // proof -> file -> seed: the seed is exactly the file's value
    const seed = seedFor({ value: f.value, time: "t", wall: 0, userId: 0 });
    expect(decode({ encoding: seed.encoding, data: seed.raw }).snapshot).toBe(
      "\ufeffHello",
    );
    // and it encodes back to exactly the hashed bytes
    expect(Buffer.from(new TextEncoder().encode(f.value))).toEqual(
      Buffer.from(withBom),
    );
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(savedFileOf(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
  });
});

describe("validProof", () => {
  const state = { seq: 10, count: 10, epoch: 1, proof: proofFor(8) };
  it("is the proof for these exact bytes in this epoch", () => {
    expect(validProof(state, file)).toEqual({
      seq: 8,
      epoch: 1,
      sha256: file.sha256,
      bytes: file.bytes,
    });
  });
  it.each([
    ["no proof", { ...state, proof: undefined }],
    ["another epoch", { ...state, proof: proofFor(8, 0) }],
    ["other bytes", { ...state, proof: proofFor(8, 1, hex("Hello")) }],
    ["a seq past the history", { ...state, proof: proofFor(11) }],
  ])("is undefined for %s", (_, s) => {
    expect(validProof(s, file)).toBeUndefined();
  });
});

describe("proofCoversHistory", () => {
  it("only when the proof's seq is the newest, in this epoch", () => {
    expect(
      proofCoversHistory({ seq: 10, count: 9, epoch: 1, proof: proofFor(10) }),
    ).toBe(true);
    expect(
      proofCoversHistory({ seq: 10, count: 9, epoch: 1, proof: proofFor(9) }),
    ).toBe(false);
    expect(
      proofCoversHistory({
        seq: 10,
        count: 9,
        epoch: 2,
        proof: proofFor(10, 1),
      }),
    ).toBe(false);
  });
});

describe("seedFor", () => {
  it("is a snapshot of the value, with nothing older to load", () => {
    const seed = seedFor({ value: "v", time: "t1", wall: 5, userId: 2 });
    expect(seed.encoding).toBe(DataEncoding.MsgPack);
    expect(decode({ encoding: seed.encoding, data: seed.raw })).toEqual({
      time: "t1",
      wall: 5,
      is_snapshot: true,
      snapshot: "v",
      size: 1,
      user_id: 2,
      seq_info: { seq: 0 },
    });
    expect(seed.checkpoint).toEqual({
      name: "latest_snapshot",
      data: { patchId: "t1" },
    });
  });
});

describe("resetOptions", () => {
  const seed = seedFor({ value: file.value, time: "t", wall: 0, userId: 0 });
  const state = { seq: 10, count: 9, epoch: 1, proof: proofFor(10) };

  it("an automatic reset covers the whole history, with no rollback", () => {
    const proof = validProof(state, file);
    expect(
      resetOptions({ mode: "oversized", state, file, proof, seed, now: 7 }),
    ).toMatchObject({
      ifRevision: { seq: 10, count: 9 },
      ifInitEpoch: 1,
      coveredSeq: 10,
      allowRollback: false,
      archive: true,
      reason: "oversized",
      settings: {
        history_reset: {
          reason: "oversized",
          coverage: "proven",
          coveredSeq: 10,
          time: 7,
        },
      },
    });
  });

  it("refuses an automatic reset without a proof covering the history", () => {
    expect(() =>
      resetOptions({ mode: "oversized", state, file, seed }),
    ).toThrow("needs a proof");
  });

  it("a restart without a valid proof covers nothing", () => {
    expect(
      resetOptions({ mode: "user-restart-from-file", state, file, seed }),
    ).toMatchObject({
      coveredSeq: 0,
      allowRollback: true,
      settings: { history_reset: { coverage: "none", coveredSeq: 0 } },
    });
  });

  it("a restart with a valid proof covers what the file covers", () => {
    const s = { ...state, proof: proofFor(8) };
    expect(
      resetOptions({
        mode: "user-restart-from-file",
        state: s,
        file,
        proof: validProof(s, file),
        seed,
      }),
    ).toMatchObject({ coveredSeq: 8, allowRollback: true });
  });

  it("binds the opId to every input: a retry reuses it, a change does not", () => {
    const opId = (s, f = file) =>
      resetOptions({ mode: "user-restart-from-file", state: s, file: f, seed })
        .opId;
    expect(opId(state)).toBe(opId({ ...state }));
    expect(opId({ ...state, seq: 11 })).not.toBe(opId(state));
    expect(opId({ ...state, count: 10 })).not.toBe(opId(state));
    expect(opId({ ...state, epoch: 2 })).not.toBe(opId(state));
    expect(opId(state, savedFileOf(bytes("changed"))!)).not.toBe(opId(state));
  });
});

describe("savesThroughWriteFile", () => {
  it("is a property of the document, by its path", () => {
    expect(savesThroughWriteFile("a/notes.md")).toBe(true);
    expect(savesThroughWriteFile("x.tasks")).toBe(true);
    expect(savesThroughWriteFile(".a.ipynb.sage-jupyter2")).toBe(false);
    expect(savesThroughWriteFile(".a.board.json.sage-board")).toBe(false);
  });
});

describe("ProofReads", () => {
  const stateWith = (i: number) => ({
    seq: 10 + i,
    count: 10,
    epoch: 1,
    proof: { seq: 10 + i, data: { sha256: `${i}`.padStart(64, "0") } },
  });

  it("does not reread a proof already found not to match", () => {
    const reads = new ProofReads();
    expect(reads.shouldRead(stateWith(0))).toBe(true);
    reads.reject(stateWith(0));
    expect(reads.shouldRead(stateWith(0))).toBe(false);
    // a new proof (or a changed file's proof) is read again
    expect(reads.shouldRead(stateWith(1))).toBe(true);
  });

  it("stays bounded however many different proofs are rejected", () => {
    const reads = new ProofReads();
    for (let i = 0; i < 10_000; i++) {
      expect(reads.shouldRead(stateWith(i))).toBe(true);
      reads.reject(stateWith(i));
    }
    expect(reads.retained()).toBe(1);
    expect(reads.shouldRead(stateWith(9_999))).toBe(false);
  });
});
