import { resolveBootstrapImageSizeGb } from "./bootstrap-host";

describe("resolveBootstrapImageSizeGb", () => {
  it("uses auto sizing for Lambda hosts", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "lambda",
        isSelfHost: false,
        diskGb: 100,
      }),
    ).toBe("auto");
  });

  it("uses auto sizing for self-host", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "self-host",
        isSelfHost: true,
        diskGb: 100,
      }),
    ).toBe("auto");
  });

  it("keeps explicit disk sizing for other cloud providers", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "gcp",
        isSelfHost: false,
        diskGb: 250,
      }),
    ).toBe("250");
  });

  it("enforces the minimum image size for non-auto providers", () => {
    expect(
      resolveBootstrapImageSizeGb({
        providerId: "gcp",
        isSelfHost: false,
        diskGb: 10,
      }),
    ).toBe("20");
  });
});
