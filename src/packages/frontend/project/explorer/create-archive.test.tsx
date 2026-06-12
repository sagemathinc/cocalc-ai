/** @jest-environment jsdom */

import {
  ARCHIVE_TIMEOUT_MS,
  STALE_DOWNLOAD_ARCHIVE_MS,
  createArchive,
  createDownloadArchive,
  removeStaleDownloadArchives,
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
    const onProgress = jest.fn();
    const actions = {
      project_id: "project-1",
      fs: () => ({ ouch, rename, rm }),
    };

    const archive = await createDownloadArchive({
      files: ["a", "b"],
      target: "selection",
      format: "zip",
      actions,
      onProgress,
    });

    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual([
      "scratch",
      "cleanup",
      "compress",
    ]);
    expect(ensureProjectScratchVolume).toHaveBeenCalledWith({
      project_id: "project-1",
    });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/tmp\/\.cocalc-archive-.*-\.cocalc-download-archive-.*-selection\.zip$/,
      ),
      expect.stringMatching(
        /^\/tmp\/\.cocalc-download-archive-.*-selection\.zip$/,
      ),
    );
    expect(archive).toEqual({
      path: expect.stringMatching(
        /^\/tmp\/\.cocalc-download-archive-.*-selection\.zip$/,
      ),
      filename: "selection.zip",
    });
    expect(archive.path).toContain(".cocalc-download-archive-");
  });

  it("sanitizes download archive filenames but preserves the requested suffix", async () => {
    const ouch = jest.fn(async () => ({ code: 0, stderr: Buffer.alloc(0) }));
    const rename = jest.fn(async () => undefined);
    const rm = jest.fn(async () => undefined);
    const actions = {
      project_id: "project-1",
      fs: () => ({ ouch, rename, rm }),
    };

    const archive = await createDownloadArchive({
      files: ["a", "b"],
      target: "../selection.tar.gz",
      format: "zip",
      actions,
    });

    expect(archive.filename).toBe("selection.zip");
    expect(archive.path).toMatch(
      /^\/tmp\/\.cocalc-download-archive-.*-selection\.zip$/,
    );
  });

  it("garbage-collects stale hidden download archives only", async () => {
    const now = new Date("2026-06-12T18:00:00.000Z").valueOf();
    const stale = ".cocalc-download-archive-stale.zip";
    const fresh = ".cocalc-download-archive-fresh.zip";
    const unrelated = "user-file.zip";
    const readdir = jest.fn(async () => [stale, fresh, unrelated]);
    const stat = jest.fn(async (path: string) => {
      if (path.endsWith(stale)) {
        return {
          mtimeMs: now - STALE_DOWNLOAD_ARCHIVE_MS - 1,
          atimeMs: now - STALE_DOWNLOAD_ARCHIVE_MS - 1,
        };
      }
      if (path.endsWith(fresh)) {
        return {
          mtimeMs: now - STALE_DOWNLOAD_ARCHIVE_MS - 1,
          atimeMs: now,
        };
      }
      throw Error(`unexpected stat for ${path}`);
    });
    const rm = jest.fn(async () => undefined);
    const actions = {
      fs: () => ({ readdir, stat, rm }),
    };

    await removeStaleDownloadArchives({ actions, now });

    expect(readdir).toHaveBeenCalledWith("/tmp");
    expect(stat).toHaveBeenCalledWith(`/tmp/${stale}`);
    expect(stat).toHaveBeenCalledWith(`/tmp/${fresh}`);
    expect(stat).not.toHaveBeenCalledWith(`/tmp/${unrelated}`);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(`/tmp/${stale}`, { force: true });
  });
});
