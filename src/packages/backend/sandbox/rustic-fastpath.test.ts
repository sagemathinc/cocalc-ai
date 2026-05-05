/*
Ensure TOML-backed rustic repos avoid repoinfo in the hot path.
*/

import type { ExecOutput } from "@cocalc/conat/files/fs";

const execMock = jest.fn<Promise<ExecOutput>, [any]>();

jest.mock("./exec", () => {
  const actual = jest.requireActual("./exec");
  return {
    __esModule: true,
    ...actual,
    default: (...args: any[]) => execMock(...args),
  };
});

jest.mock("./install", () => ({
  __esModule: true,
  rustic: "/mock/rustic",
}));

import rustic from "./rustic";

function ok(stdout = "", stderr = ""): ExecOutput {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    code: 0,
    truncated: false,
  };
}

function fail(stderr: string): ExecOutput {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
    code: 1,
    truncated: false,
  };
}

describe("rustic TOML fast path", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test("snapshots skip repoinfo preflight for TOML repos", async () => {
    execMock.mockResolvedValueOnce(ok("[]"));

    await rustic(["snapshots", "--json"], {
      repo: "/tmp/project-repo.toml",
      host: "project-1",
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][0].safety).toEqual([
      "-P",
      "/tmp/project-repo",
      "snapshots",
      "--json",
      "--filter-host",
      "project-1",
    ]);
    expect(
      execMock.mock.calls.flatMap(([opts]) => opts.safety as string[]),
    ).not.toContain("repoinfo");
  });

  test("backup initializes TOML repo only after a missing-repo error", async () => {
    execMock
      .mockResolvedValueOnce(fail("No repository config file found"))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            id: "backup-1",
            time: "2026-05-05T18:00:00.000Z",
            summary: {},
            paths: ["a.txt"],
          }),
        ),
      );

    await rustic(["backup", "--json", "a.txt"], {
      repo: "/tmp/project-repo-missing.toml",
      host: "project-1",
      safeAbsPath: async (path: string) =>
        `/sandbox/${path.replace(/^\/+/, "")}`,
    });

    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock.mock.calls[0][0].safety).toEqual([
      "-P",
      "/tmp/project-repo-missing",
      "backup",
      "--json",
      "--no-scan",
      "--host",
      "project-1",
      "--",
      "a.txt",
    ]);
    expect(execMock.mock.calls[1][0].safety).toEqual([
      "--no-progress",
      "-P",
      "/tmp/project-repo-missing",
      "init",
    ]);
    expect(execMock.mock.calls[2][0].safety).toEqual(
      execMock.mock.calls[0][0].safety,
    );
    expect(
      execMock.mock.calls.flatMap(([opts]) => opts.safety as string[]),
    ).not.toContain("repoinfo");
  });
});
