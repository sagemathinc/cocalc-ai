import { describe, expect, it } from "@jest/globals";

import { __test__ } from "./runtime-conformance";

describe("runtime conformance", () => {
  it("keeps the live sudo wrapper probe out of startup checks", () => {
    expect(__test__.startupCheckIds()).toEqual([
      "root-owned-path",
      "sudo-policy-visible",
      "sudo-direct-deny",
      "sudo-generic-mount-deny",
    ]);
    expect(__test__.periodicCheckIds()).toContain("sudo-wrapper-allow");
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
