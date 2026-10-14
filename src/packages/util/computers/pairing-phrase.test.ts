import { PAIRING_WORDS, pairingPhrase } from "./pairing-phrase";

describe("pairingPhrase", () => {
  it("has 256 distinct lowercase words", () => {
    expect(PAIRING_WORDS).toHaveLength(256);
    expect(new Set(PAIRING_WORDS).size).toBe(256);
    for (const word of PAIRING_WORDS) expect(word).toMatch(/^[a-z]{3,10}$/);
  });

  it("uses the first four bytes, one word each", () => {
    expect(pairingPhrase(new Uint8Array([0, 1, 255, 2, 99]))).toBe(
      [
        PAIRING_WORDS[0],
        PAIRING_WORDS[1],
        PAIRING_WORDS[255],
        PAIRING_WORDS[2],
      ].join("-"),
    );
  });

  it("refuses a short hash", () => {
    expect(() => pairingPhrase(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
  });
});
