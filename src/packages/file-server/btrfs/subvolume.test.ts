const btrfsMock = jest.fn(async (_opts?: any) => ({ stdout: "", stderr: "" }));

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
  sudo: jest.fn(async () => undefined),
}));

import {
  getSubvolumeField,
  getSubvolumeId,
  invalidateSubvolumeMetadata,
} from "./subvolume";
import { clearBtrfsOperationCachesForTest } from "./operation-cache";

describe("subvolume metadata cache", () => {
  beforeEach(() => {
    clearBtrfsOperationCachesForTest();
    btrfsMock.mockClear();
  });

  it("collapses concurrent subvolume show calls for the same path", async () => {
    btrfsMock.mockResolvedValueOnce({
      stdout: `
project-1
  Name: project-1
  UUID: uuid
  Subvolume ID: 123
  Generation: 456
`,
      stderr: "",
    });

    await expect(
      Promise.all([
        getSubvolumeId("/mnt/test/project-1"),
        getSubvolumeField("/mnt/test/project-1", "Generation"),
      ]),
    ).resolves.toEqual([123, "456"]);

    expect(btrfsMock).toHaveBeenCalledTimes(1);
    expect(btrfsMock).toHaveBeenCalledWith({
      args: ["subvolume", "show", "/mnt/test/project-1"],
      err_on_exit: true,
      verbose: false,
    });
  });

  it("allows explicit invalidation after metadata mutations", async () => {
    btrfsMock
      .mockResolvedValueOnce({
        stdout: "  Subvolume ID: 123\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: "  Subvolume ID: 124\n",
        stderr: "",
      });

    await expect(getSubvolumeId("/mnt/test/project-1")).resolves.toBe(123);
    invalidateSubvolumeMetadata("/mnt/test/project-1");
    await expect(getSubvolumeId("/mnt/test/project-1")).resolves.toBe(124);

    expect(btrfsMock).toHaveBeenCalledTimes(2);
  });
});
