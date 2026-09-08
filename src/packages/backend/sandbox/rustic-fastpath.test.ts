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

import rustic, { getSnapshot } from "./rustic";

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

function snapshotsJson(...snapshots: any[]): string {
  return JSON.stringify([{ snapshots }]);
}

describe("rustic TOML fast path", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test.each(["backup", "restore"])(
    "managed %s rejects fallback before repo initialization or path lookup",
    async (command) => {
      const previous = process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
      process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
      const safeAbsPath = jest.fn();
      try {
        await expect(
          rustic([command, "source", "destination"], {
            repo: "/tmp/never-create-managed-fallback-repository",
            safeAbsPath,
          }),
        ).rejects.toThrow("unsupervised fallback is disabled");
        expect(execMock).not.toHaveBeenCalled();
        expect(safeAbsPath).not.toHaveBeenCalled();
      } finally {
        if (previous == null)
          delete process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
        else process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = previous;
      }
    },
  );

  test.each([
    { code: 1, truncated: false },
    { code: 0, truncated: true },
    { code: null, truncated: false },
  ])("snapshot metadata rejects incomplete execution: %j", async (state) => {
    const id = "a".repeat(64);
    execMock.mockResolvedValueOnce({
      ...ok(snapshotsJson({ id, hostname: "project-1" })),
      ...state,
    });
    await expect(
      getSnapshot({ id, repo: "/tmp/incomplete-snapshot.toml" }),
    ).rejects.toThrow();
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    { code: 1, truncated: true },
    { code: null, truncated: false },
  ])(
    "interrupted backup does not retry repository initialization: %j",
    async (state) => {
      execMock.mockResolvedValueOnce({
        ...fail("No repository config file found"),
        ...state,
      });
      const result = await rustic(["backup", "--json", "a.txt"], {
        repo: "/tmp/interrupted-init.toml",
        host: "project-1",
        safeAbsPath: async (path: string) => `/sandbox/${path}`,
      });
      expect(result).toMatchObject(state);
      expect(execMock).toHaveBeenCalledTimes(1);
    },
  );

  test("snapshots skip repoinfo preflight for TOML repos", async () => {
    execMock.mockResolvedValueOnce(ok("[]"));

    await rustic(["snapshots", "--json"], {
      repo: "/tmp/project-repo.toml",
      host: "project-1",
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][0].killProcessGroup).toBe(true);
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

  test("optional nice priority wraps rustic command", async () => {
    execMock.mockResolvedValueOnce(ok("[]"));

    await rustic(["snapshots", "--json"], {
      repo: "/tmp/project-repo-nice.toml",
      host: "project-1",
      nice: 15,
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][0].cmd).toBe("/usr/bin/nice");
    expect(execMock.mock.calls[0][0].prefixArgs).toEqual([
      "-n",
      "15",
      "/mock/rustic",
    ]);
    expect(execMock.mock.calls[0][0].safety).toEqual([
      "-P",
      "/tmp/project-repo-nice",
      "snapshots",
      "--json",
      "--filter-host",
      "project-1",
    ]);
  });

  test("forget accepts multiple exact snapshot ids", async () => {
    const snapshot1 =
      "1111111111111111111111111111111111111111111111111111111111111111";
    const snapshot2 =
      "2222222222222222222222222222222222222222222222222222222222222222";
    execMock
      .mockResolvedValueOnce(
        ok(snapshotsJson({ id: snapshot1, hostname: "project-1" })),
      )
      .mockResolvedValueOnce(
        ok(snapshotsJson({ id: snapshot2, hostname: "project-1" })),
      )
      .mockResolvedValueOnce(ok(""));

    await rustic(["forget", snapshot1, snapshot2], {
      repo: "/tmp/project-repo-forget.toml",
      host: "project-1",
      nice: 15,
    });

    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock.mock.calls[2][0].cmd).toBe("/usr/bin/nice");
    expect(execMock.mock.calls[2][0].prefixArgs).toEqual([
      "-n",
      "15",
      "/mock/rustic",
    ]);
    expect(execMock.mock.calls[2][0].safety).toEqual([
      "-P",
      "/tmp/project-repo-forget",
      "forget",
      snapshot1,
      snapshot2,
    ]);
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

  test("backup initializes TOML repo after opendal missing config error", async () => {
    execMock
      .mockResolvedValueOnce(
        fail(
          "[WARN] service=s3 name=prod-apac path=config: stat failed NotFound (persistent) at stat\n" +
            "error: `rustic_core` experienced an error related to `the configuration`.",
        ),
      )
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
      repo: "/tmp/project-repo-opendal.toml",
      host: "project-1",
      safeAbsPath: async (path: string) =>
        `/sandbox/${path.replace(/^\/+/, "")}`,
    });

    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock.mock.calls[1][0].safety).toEqual([
      "--no-progress",
      "-P",
      "/tmp/project-repo-opendal",
      "init",
    ]);
    expect(execMock.mock.calls[2][0].safety).toEqual(
      execMock.mock.calls[0][0].safety,
    );
  });
});
