import {
  DEFAULT_LAMBDA_FILESYSTEM_MOUNT,
  lambdaFilesystemMount,
} from "../lambda/provider";

describe("lambdaFilesystemMount", () => {
  it("defaults to the project-host data mount, not the old /btrfs", () => {
    expect(DEFAULT_LAMBDA_FILESYSTEM_MOUNT).toBe("/mnt/cocalc");
    expect(lambdaFilesystemMount(undefined)).toBe("/mnt/cocalc");
    expect(lambdaFilesystemMount({})).toBe("/mnt/cocalc");
  });

  it("uses an explicit mount point from the host spec", () => {
    expect(lambdaFilesystemMount({ filesystem_mount_point: "/btrfs" })).toBe(
      "/btrfs",
    );
    expect(
      lambdaFilesystemMount({ filesystem_mount_point: "/data/shared" }),
    ).toBe("/data/shared");
  });
});
