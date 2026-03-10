/** @jest-environment jsdom */

import { createArchive } from "./create-archive";

describe("createArchive", () => {
  it("normalizes zip archive targets so existing archive suffixes do not produce invalid paths", async () => {
    const ouch = jest.fn(async () => ({ code: 0, stderr: Buffer.alloc(0) }));
    const actions = {
      fs: () => ({ ouch }),
    };

    await createArchive({
      path: "/btrfs/project-1",
      files: ["cowasm.tar"],
      target: "cowasm.tar",
      format: "zip",
      actions,
    });

    expect(ouch).toHaveBeenCalledWith([
      "compress",
      "cowasm.tar",
      "/btrfs/project-1/cowasm.zip",
    ]);
  });

  it("preserves ordinary dotted target names when adding an archive suffix", async () => {
    const ouch = jest.fn(async () => ({ code: 0, stderr: Buffer.alloc(0) }));
    const actions = {
      fs: () => ({ ouch }),
    };

    await createArchive({
      path: "/btrfs/project-1",
      files: ["report.md"],
      target: "release.v1",
      format: "zip",
      actions,
    });

    expect(ouch).toHaveBeenCalledWith([
      "compress",
      "report.md",
      "/btrfs/project-1/release.v1.zip",
    ]);
  });
});
