import { describe, expect, it } from "@jest/globals";

import { __test__ } from "./runtime-conformance";

describe("runtime conformance", () => {
  it("keeps the live sudo wrapper probe out of startup checks", () => {
    expect(__test__.startupCheckIds()).toEqual([
      "root-owned-path",
      "sudo-policy-visible",
      "project-cgroup-helper-contract",
      "sudo-direct-deny",
      "sudo-generic-mount-deny",
    ]);
    expect(__test__.periodicCheckIds()).toContain(
      "project-cgroup-helper-contract",
    );
    expect(__test__.periodicCheckIds()).toContain("sudo-wrapper-allow");
  });

  it("distinguishes supported helper usage from an old helper", () => {
    expect(
      __test__.helperCommandSupported({
        exitCode: 2,
        stdout: "",
        stderr:
          "usage: cocalc-runtime-storage enter-project-cgroup <project-id> <launcher-pid>",
      }),
    ).toBe(true);
    expect(
      __test__.helperCommandSupported({
        exitCode: 2,
        stdout: "",
        stderr:
          "SECURITY_DENY code=unsupported-command detail=enter-project-cgroup",
      }),
    ).toBe(false);
    expect(
      __test__.helperCommandSupported(
        {
          exitCode: 2,
          stdout: "",
          stderr:
            "usage: cocalc-runtime-storage verify-project-network-limits <project-id>",
        },
        "verify-project-network-limits",
      ),
    ).toBe(true);
  });

  it("times out stuck commands", async () => {
    const result = await __test__.run(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10_000)"],
      100,
    );
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out after 100ms");
  });
});
