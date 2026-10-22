import { createHash } from "node:crypto";
import { FILE_PROOF_MAX_BYTES, fileProof, readFileProof } from "./file-proof";

describe("fileProof", () => {
  it("binds the epoch and seq to the hash and size of the UTF-8 bytes", () => {
    expect(fileProof({ value: "é", epoch: 2, seq: 7 })).toEqual({
      epoch: 2,
      seq: 7,
      sha256: createHash("sha256").update("é", "utf8").digest("hex"),
      bytes: 2,
    });
  });

  it("is undefined over the size limit", () => {
    expect(
      fileProof({
        value: "x".repeat(FILE_PROOF_MAX_BYTES + 1),
        epoch: 0,
        seq: 1,
      }),
    ).toBeUndefined();
  });
});

describe("readFileProof", () => {
  const data = { sha256: "a".repeat(64), bytes: 3, epoch: 1 };
  it("reads a stored proof", () => {
    expect(readFileProof({ seq: 5, data })).toEqual({ seq: 5, ...data });
  });
  it.each([
    ["no checkpoint", undefined],
    ["no seq", { data }],
    ["no data", { seq: 5 }],
    ["a bad hash", { seq: 5, data: { ...data, sha256: "x" } }],
    ["no epoch", { seq: 5, data: { ...data, epoch: undefined } }],
    ["a fractional size", { seq: 5, data: { ...data, bytes: 1.5 } }],
  ])("is undefined for %s", (_, checkpoint) => {
    expect(readFileProof(checkpoint as any)).toBeUndefined();
  });
});
