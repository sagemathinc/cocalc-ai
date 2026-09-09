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

  it("verifies both patched Codex binaries before replacing installed files", () => {
    const script = SPEC.codex.script();
    expect(script).toContain(
      "https://github.com/sagemathinc/codex/releases/download/v0.153.4",
    );
    expect(script).toMatch(/codex-v0\.153\.4-linux-(?:x64|arm64)\.xz/);
    expect(script).toMatch(
      /codex-code-mode-host-v0\.153\.4-linux-(?:x64|arm64)\.xz/,
    );
    expect(script).toContain("sha256sum -c -");
    expect(script.match(/sha256sum -c -/g)).toHaveLength(4);
    expect(script).toContain("xz -dc");
    expect(script.lastIndexOf("sha256sum -c -")).toBeLessThan(
      script.indexOf("mv "),
    );
    expect(script).toContain(
      `mv \"${SPEC.codex.path}.tmp\" \"${SPEC.codex.path}\"`,
    );
  });
});
