import {
  compactBuildTimestamp,
  createBuildIdentity,
  makeBuildId,
} from "./build-identity";

describe("build identity", () => {
  test("formats compact timestamps deterministically", () => {
    expect(compactBuildTimestamp("2026-03-06T22:01:59.713Z")).toBe(
      "20260306T220159Z",
    );
  });

  test("build id includes commit and dirty hash when provided", () => {
    expect(
      makeBuildId({
        builtAt: "2026-03-06T22:01:59.713Z",
        gitCommit: "907b99d5413870087e3c8fa2a0a757ac8a82eb85",
        gitDirty: true,
        gitDiffHash: "a1b2c3d4eeeeffff",
      }),
    ).toBe("20260306T220159Z-907b99d54138-dirty-a1b2c3d4");
  });

  test("createBuildIdentity preserves metadata fields", () => {
    expect(
      createBuildIdentity({
        builtAt: "2026-03-06T22:01:59.713Z",
        gitCommit: "907b99d5413870087e3c8fa2a0a757ac8a82eb85",
        gitDirty: false,
        packageVersion: "1.2.3",
        artifactKind: "project-host",
      }),
    ).toEqual({
      build_id: "20260306T220159Z-907b99d54138",
      built_at: "2026-03-06T22:01:59.713Z",
      git_commit: "907b99d5413870087e3c8fa2a0a757ac8a82eb85",
      git_commit_short: "907b99d54138",
      git_dirty: false,
      git_diff_hash: undefined,
      package_version: "1.2.3",
      artifact_kind: "project-host",
    });
  });
});
