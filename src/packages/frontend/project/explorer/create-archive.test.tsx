/** @jest-environment jsdom */

import {
  ARCHIVE_TIMEOUT_MS,
  createArchive,
  createDownloadArchive,
} from "./create-archive";

const ensureProjectScratchVolume = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          ensureProjectScratchVolume: (...args: any[]) =>
            ensureProjectScratchVolume(...args),
        },
      },
    },
  },
}));

describe("createArchive", () => {
  beforeEach(() => {
    ensureProjectScratchVolume.mockReset();
    ensureProjectScratchVolume.mockResolvedValue(undefined);
  });

  it("normalizes zip archive targets so existing archive suffixes do not produce invalid paths", async () => {
    const ouch = jest.fn(async () => ({ code: 0, stderr: Buffer.alloc(0) }));
    const rename = jest.fn(async () => undefined);
    const rm = jest.fn(async () => undefined);
    const actions = {
      fs: () => ({ ouch, rename, rm }),
    };

    const finalPath = await createArchive({
      path: "/btrfs/project-1",
      files: ["cowasm.tar"],
      target: "cowasm.tar",
      format: "zip",
      actions,
    });

    expect(ouch).toHaveBeenCalledWith(
      [
        "compress",
        "cowasm.tar",
        expect.stringMatching(
          /^\/btrfs\/project-1\/\.cocalc-archive-.*-cowasm\.zip$/,
        ),
      ],
      {
        timeout: ARCHIVE_TIMEOUT_MS,
      },
    );
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/btrfs\/project-1\/\.cocalc-archive-.*-cowasm\.zip$/,
      ),
      "/btrfs/project-1/cowasm.zip",
    );
    expect(finalPath).toBe("/btrfs/project-1/cowasm.zip");
  });

  it("preserves ordinary dotted target names when adding an archive suffix", async () => {
    const ouch = jest.fn(async () => ({ code: 0, stderr: Buffer.alloc(0) }));
    const rename = jest.fn(async () => undefined);
    const rm = jest.fn(async () => undefined);
    const actions = {
      fs: () => ({ ouch, rename, rm }),
    };

    await createArchive({
      path: "/btrfs/project-1",
      files: ["report.md"],
      target: "release.v1",
      format: "zip",
      actions,
    });

    expect(ouch).toHaveBeenCalledWith(
      [
        "compress",
        "report.md",
        expect.stringMatching(
          /^\/btrfs\/project-1\/\.cocalc-archive-.*-release\.v1\.zip$/,
        ),
      ],
      {
        timeout: ARCHIVE_TIMEOUT_MS,
      },
    );
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/btrfs\/project-1\/\.cocalc-archive-.*-release\.v1\.zip$/,
      ),
      "/btrfs/project-1/release.v1.zip",
    );
  });

  it("cleans up the temporary archive and reports truncated commands as failures", async () => {
    const ouch = jest.fn(async () => ({
      code: 0,
      stderr: Buffer.from("timeout"),
      truncated: true,
    }));
    const rename = jest.fn(async () => undefined);
    const rm = jest.fn(async () => undefined);
    const actions = {
      fs: () => ({ ouch, rename, rm }),
    };

    await expect(
      createArchive({
        path: "/btrfs/project-1",
        files: ["big"],
        target: "backup",
        format: "tar.gz",
        actions,
      }),
    ).rejects.toThrow("timeout");

    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledTimes(2);
    expect(rm).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /^\/btrfs\/project-1\/\.cocalc-archive-.*-backup\.tar\.gz$/,
      ),
      { force: true },
    );
  });

  it("creates download archives in project scratch storage", async () => {
    const ouch = jest.fn(async () => ({ code: 0, stderr: Buffer.alloc(0) }));
    const rename = jest.fn(async () => undefined);
    const rm = jest.fn(async () => undefined);
    const actions = {
      project_id: "project-1",
      fs: () => ({ ouch, rename, rm }),
    };

    const finalPath = await createDownloadArchive({
      files: ["a", "b"],
      target: "selection",
      format: "zip",
      actions,
    });

    expect(ensureProjectScratchVolume).toHaveBeenCalledWith({
      project_id: "project-1",
    });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/\.cocalc-archive-.*-selection\.zip$/),
      "/tmp/selection.zip",
    );
    expect(finalPath).toBe("/tmp/selection.zip");
  });
});
