import fs from "node:fs";
import path from "node:path";

import * as bootstrapHost from "./bootstrap-host";

const { resolveBootstrapImageSizeGb, resolveBootstrapRootReserveGb } =
  bootstrapHost;

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

describe("resolveBootstrapRootReserveGb", () => {
  it("defaults to a 25 GiB root reserve", () => {
    expect(resolveBootstrapRootReserveGb()).toBe("25");
  });

  it("accepts explicit positive overrides", () => {
    expect(resolveBootstrapRootReserveGb(24)).toBe("24");
    expect(resolveBootstrapRootReserveGb("32")).toBe("32");
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

  it("uses a btrfs-backed bootstrap state root for reconcile when available", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(
      `BOOTSTRAP_STATE_ROOT="/mnt/cocalc/data/.host-bootstrap"`,
    );
    expect(source).toContain(`BOOTSTRAP_LOG="$BOOTSTRAP_DIR/bootstrap.log"`);
  });

  it("runs explicit reconcile mode after bootstrap is already complete", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(
      `python3 "$BOOTSTRAP_DIR/bootstrap.py" reconcile --bootstrap-dir "$BOOTSTRAP_DIR"`,
    );
    expect(source).not.toContain(
      `python3 "$BOOTSTRAP_DIR/bootstrap.py" --config "$BOOTSTRAP_DIR/bootstrap-config.json" --only cloudflared`,
    );
  });

  it("writes split bootstrap host facts and desired state instead of bootstrap-config.json", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`> "$BOOTSTRAP_DIR/bootstrap-host-facts.json"`);
    expect(source).toContain(`> "$BOOTSTRAP_DIR/bootstrap-desired-state.json"`);
    expect(source).not.toContain(`> "$BOOTSTRAP_DIR/bootstrap-config.json"`);
  });

  it("does not make bootstrap execution depend on tee writing the log file", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "bootstrap-host.ts"),
      "utf8",
    );

    expect(source).toContain(`if ! bash "$BOOTSTRAP_PAYLOAD"; then`);
    expect(source).not.toContain(
      `if ! bash "$BOOTSTRAP_PAYLOAD" 2>&1 | tee "$BOOTSTRAP_DIR/bootstrap.log"; then`,
    );
    expect(source).toContain(`bootstrap_log_tail() {`);
  });
});
