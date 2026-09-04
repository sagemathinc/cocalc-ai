/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { SPEC } from "./install";

describe("sandbox tool install scripts", () => {
  it("installs Blit at the path checked by the installer", () => {
    const script = SPEC.blit.script();
    expect(script).toContain(
      `install -m 0755 "$tmp/bin/blit" "${SPEC.blit.path}"`,
    );
  });

  it("installs xwayland-satellite at the path checked by the installer", () => {
    const script = SPEC.xwaylandSatellite.script();
    expect(script).toContain(
      `bin/xwayland-satellite" "${SPEC.xwaylandSatellite.path}"`,
    );
  });

  it("installs hash-pinned official Codex binaries atomically", () => {
    const script = SPEC.codex.script();
    expect(script).toContain(
      "https://github.com/openai/codex/releases/download/rust-v0.153.2",
    );
    expect(script).toMatch(
      /codex-(?:x86_64|aarch64)-unknown-linux-musl\.tar\.gz/,
    );
    expect(script).toMatch(
      /codex-code-mode-host-(?:x86_64|aarch64)-unknown-linux-musl\.tar\.gz/,
    );
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain("tar -xOzf");
    expect(script).toContain(
      `mv \"${SPEC.codex.path}.tmp\" \"${SPEC.codex.path}\"`,
    );
  });
});
