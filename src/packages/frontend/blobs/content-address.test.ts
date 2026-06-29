import { webcrypto } from "crypto";
import { bytesToBase64, uuidSha1FromBytes } from "./content-address";

describe("content-addressed blobs", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
  });

  it("computes the backend blob uuid from raw bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254, 42]);

    await expect(uuidSha1FromBytes(bytes)).resolves.toBe(
      "c8d0624c-39fb-4557-b649-2c3a92a1c289",
    );
  });

  it("encodes raw bytes as base64", () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 3, 255, 254, 42]))).toBe(
      "AAECA//+Kg==",
    );
  });
});
