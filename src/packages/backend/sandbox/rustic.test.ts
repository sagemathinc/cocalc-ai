/*
Test the rustic backup api.

https://github.com/rustic-rs/rustic
*/

import rustic, {
  getHost,
  getSnapshot,
  rusticCapabilities,
  sparseRestoreArgs,
} from "./rustic";
import {
  chmod,
  mkdtemp,
  mkdir,
  open as openFile,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseOutput } from "./exec";

const describeIfNotDarwin =
  process.platform === "darwin" ? describe.skip : describe;

let tempDir, options, home;
let latestSnapshotId;
beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cocalc"));
  const repo = join(tempDir, "repo");
  home = join(tempDir, "home");
  await mkdir(home);
  const safeAbsPath = (path: string) => join(home, resolve("/", path));
  options = {
    host: "my-host",
    repo,
    safeAbsPath,
  };
});
afterAll(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describeIfNotDarwin("rustic does something", () => {
  jest.setTimeout(15_000);

  it("there are initially no backups", async () => {
    const { stdout, truncated } = await rustic(
      ["snapshots", "--json"],
      options,
    );
    const s = JSON.parse(Buffer.from(stdout).toString());
    expect(s).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("create a file and back it up", async () => {
    await writeFile(join(home, "a.txt"), "hello");
    const { stdout, truncated } = await rustic(
      ["backup", "--json", "a.txt"],
      options,
    );
    const s = JSON.parse(Buffer.from(stdout).toString());
    expect(s.paths).toEqual(["a.txt"]);
    latestSnapshotId = s.id;
    expect(truncated).toBe(false);
  });

  it("backs up a file relative to cwd without introducing an absolute path", async () => {
    await writeFile(join(home, "b.txt"), "world");
    const { stdout, truncated } = await rustic(["backup", "--json", "b.txt"], {
      ...options,
      cwd: ".",
    });
    const s = JSON.parse(Buffer.from(stdout).toString());
    expect(s.paths).toEqual(["b.txt"]);
    expect(truncated).toBe(false);
  });

  it("resolves '.' relative to cwd (not sandbox root)", async () => {
    await mkdir(join(home, "nested", "deep"), { recursive: true });
    await writeFile(join(home, "nested", "deep", "c.txt"), "cwd");
    const { stdout, truncated } = await rustic(["backup", "--json", "."], {
      ...options,
      cwd: "nested/deep",
    });
    const s = JSON.parse(Buffer.from(stdout).toString());
    expect(s.paths).toEqual(["."]);
    expect(truncated).toBe(false);
  });

  it("use a .toml file instead of explicitly passing in a repo", async () => {
    await mkdir(join(home, "x"));
    await writeFile(
      join(home, "x/a.toml"),
      `
[repository]
repository = "${options.repo}"
password = ""
`,
    );
    const options2 = { ...options, repo: join(home, "x/a.toml") };
    const { stdout } = parseOutput(
      await rustic(["snapshots", "--json"], options2),
    );
    const s = JSON.parse(stdout);
    expect(s.length).toBeGreaterThanOrEqual(1);
    expect(s.some((group) => group?.group_key?.hostname === "my-host")).toBe(
      true,
    );
  });

  it("it appears in the snapshots list", async () => {
    const { stdout, truncated } = await rustic(
      ["snapshots", "--json"],
      options,
    );
    const s = JSON.parse(Buffer.from(stdout).toString());
    const paths = s.flatMap((group) =>
      (group?.snapshots ?? []).map((snap) => snap.paths?.[0]),
    );
    expect(paths).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
    expect(truncated).toBe(false);
  });

  it("can resolve a snapshot host by exact snapshot id", async () => {
    expect(latestSnapshotId).toBeTruthy();
    const snapshot = await getSnapshot({
      id: latestSnapshotId,
      repo: options.repo,
    });
    expect(snapshot.id).toBe(latestSnapshotId);
    expect(snapshot.hostname).toBe("my-host");
    await expect(
      getHost({ id: latestSnapshotId, repo: options.repo }),
    ).resolves.toBe("my-host");
  });

  it("can restore legacy project-migration snapshots without the local cache", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(home, "legacy-migration.txt"), "legacy");
    const { stdout } = await rustic(
      ["backup", "--json", "legacy-migration.txt"],
      {
        ...options,
        host: projectId,
      },
    );
    const backup = JSON.parse(Buffer.from(stdout).toString());
    await rustic(
      ["restore", "--no-cache", backup.id, "legacy-migration-restore"],
      {
        ...options,
        host: `project-${projectId}`,
      },
    );
    await expect(
      readFile(
        join(home, "legacy-migration-restore", "legacy-migration.txt"),
        "utf8",
      ),
    ).resolves.toBe("legacy");
  });
});

describe("rustic capabilities", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cocalc-rustic-caps"));
  });
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const fake = async (name: string, script: string) => {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  };

  it("a build without `version --json` has none, and restores as before", async () => {
    const old = await fake("old", 'echo "unrecognized subcommand" >&2; exit 2');
    expect(await rusticCapabilities(old)).toEqual({});
    expect(await sparseRestoreArgs(old)).toEqual([]);
  });

  it("garbage or a missing binary has none", async () => {
    expect(
      await rusticCapabilities(await fake("garbage", "echo nope")),
    ).toEqual({});
    expect(await rusticCapabilities(join(dir, "missing"))).toEqual({});
  });

  it("a sparse-capable build restores holes as holes", async () => {
    const caps = { sparse_required_restore: true, hole_aware_backup: true };
    const current = await fake(
      "current",
      `echo '${JSON.stringify({ schema_version: 1, capabilities: caps })}'`,
    );
    expect(await rusticCapabilities(current)).toEqual(caps);
    expect(await sparseRestoreArgs(current)).toEqual([
      "--sparse",
      "by-content-required",
    ]);
    // only an explicit true counts
    const odd = await fake(
      "odd",
      `echo '{"capabilities":{"sparse_required_restore":"yes"}}'`,
    );
    expect(await sparseRestoreArgs(odd)).toEqual([]);
  });
});

describeIfNotDarwin("sparse restore with the installed rustic", () => {
  jest.setTimeout(60_000);

  it("restores a sparse file without allocating its holes", async () => {
    if ((await sparseRestoreArgs()).length == 0) {
      // the installed rustic predates sparse restores (e.g. upstream 0.11.1)
      return;
    }
    const size = 512 * 1024 * 1024;
    const file = await openFile(join(home, "sparse.img"), "w");
    await file.truncate(size);
    await file.write(Buffer.from("data"), 0, 4, 100 * 1024 * 1024);
    await file.close();
    const { stdout } = await rustic(
      ["backup", "--json", "sparse.img"],
      options,
    );
    const { id } = JSON.parse(Buffer.from(stdout).toString());
    const { code } = await rustic(
      ["restore", `${id}:sparse.img`, "sparse-restore"],
      options,
    );
    expect(code).toBe(0);
    const restored = await stat(join(home, "sparse-restore"));
    expect(restored.size).toBe(size);
    // a dense restore would allocate all 512 MiB
    expect(restored.blocks * 512).toBeLessThan(16 * 1024 * 1024);
  });
});
