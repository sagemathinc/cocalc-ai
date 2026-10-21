import { createHash } from "node:crypto";
import { Sha256, sha256Utf8 } from "./sha256-utf8";

const expected = (s: string) =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

describe("sha256Utf8", () => {
  it.each([
    ["empty", ""],
    ["ascii", "Hello world"],
    ["55 bytes (one block with the padding)", "x".repeat(55)],
    ["56 bytes (two blocks)", "x".repeat(56)],
    ["64 bytes", "y".repeat(64)],
    ["multibyte", "é ñ 中文 ∑"],
    ["astral", "😀🎉 a 𝔸"],
  ])("matches node's SHA-256 for %s", (_, s) => {
    expect(sha256Utf8(s)).toEqual({
      sha256: expected(s),
      bytes: Buffer.byteLength(s, "utf8"),
    });
  });

  it("hashes across slices without splitting a surrogate pair", () => {
    // a pair straddling the 1 Mi-character slice boundary
    const s = "a".repeat(1024 * 1024 - 1) + "😀" + "b".repeat(1000);
    expect(sha256Utf8(s)).toEqual({
      sha256: expected(s),
      bytes: Buffer.byteLength(s, "utf8"),
    });
  });

  it("matches across many slices", () => {
    const s = "ü€😀x".repeat(700_000);
    expect(sha256Utf8(s)!.sha256).toBe(expected(s));
  });

  it("gives up once the UTF-8 encoding passes maxBytes, not the length", () => {
    // 10 characters, 30 bytes
    const s = "€".repeat(10);
    expect(sha256Utf8(s, { maxBytes: 30 })).toEqual({
      sha256: expected(s),
      bytes: 30,
    });
    expect(sha256Utf8(s, { maxBytes: 29 })).toBeUndefined();
    // the length alone is already too long
    expect(sha256Utf8("x".repeat(11), { maxBytes: 10 })).toBeUndefined();
  });

  it("is incremental", () => {
    const h = new Sha256();
    for (const part of ["ab", "c".repeat(100), "d"]) {
      h.update(Buffer.from(part));
    }
    expect(h.digest()).toBe(expected("ab" + "c".repeat(100) + "d"));
  });
});
