import fs from "node:fs";
import path from "node:path";

import * as bootstrapHost from "./bootstrap-host";

const { resolveBootstrapImageSizeGb } = bootstrapHost;

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

describe("bootstrap-host shell templates", () => {
  it("keeps carriage-return stripping as a literal backslash-r sequence", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`tr -d '\\\\r'`);
    expect(source).not.toContain("tr -d '\r'");
  });

  it("downloads the bootstrap payload to a separate file instead of self-overwriting", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(
      `BOOTSTRAP_PAYLOAD="$BOOTSTRAP_DIR/bootstrap.payload.sh"`,
    );
    expect(source).toContain(`-o "$BOOTSTRAP_PAYLOAD"`);
    expect(source).toContain(`bash "$BOOTSTRAP_PAYLOAD"`);
    expect(source).not.toContain(`-o "$BOOTSTRAP_DIR/bootstrap.sh"`);
  });
});
