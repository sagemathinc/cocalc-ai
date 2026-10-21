import { createHash } from "node:crypto";
import { DataEncoding, decode } from "@cocalc/conat/core/codec";
import {
  proofCoversHistory,
  resetOptions,
  savedFileOf,
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
