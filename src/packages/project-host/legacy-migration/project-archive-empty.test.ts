/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A legacy project with no files (or only CoCalc's own state, which is never
// restored) restores as an empty restore instead of failing, and leaves the
// project's current files alone.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

const tmp = mkdtempSync(join(tmpdir(), "cocalc-archive-empty-"));
// a small per-file limit, so a "too large" file is cheap to make (read when
// project-archive loads, below)
process.env.COCALC_PROJECT_ARCHIVE_MAX_FILE_BYTES = "1024";

jest.mock("@cocalc/backend/data", () => ({ data: join(tmp, "data") }));
jest.mock("../lro/stream", () => ({ publishLroEvent: async () => {} }));

import { createLegacyProjectArchiveHandlers } from "./project-archive";

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function snapshotTree(source: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  run("rsync", ["-a", "--exclude=/.snapshots", `${source}/`, `${dest}/`]);
}

function archiveOf(build: (src: string) => void): Buffer {
  const src = mkdtempSync(join(tmp, "src-"));
  build(src);
  const tarPath = `${src}.tar`;
  run("tar", ["-cf", tarPath, "-C", src, "."]);
  return zstdCompressSync(readFileSync(tarPath));
}

describe("legacy project restore of an archive with no files", () => {
  const home = join(tmp, "home");
  const archives: Record<string, Buffer> = {};
  let server: Server;
  let base: string;
  const projectSnapshots: unknown[] = [];
  const backupExempt: string[] = [];

  const handlers = createLegacyProjectArchiveHandlers({
    getOrEnsureVolume: async () => undefined,
    projectMountpoint: () => home,
    createWritableSnapshot: async (source, dest) => snapshotTree(source, dest),
    createProjectSnapshot: async (opts) => {
      projectSnapshots.push(opts);
      snapshotTree(opts.source, opts.dest);
    },
    deleteSubvolumeTree: async (path) =>
      path ? rmSync(path, { recursive: true, force: true }) : undefined,
    invalidateProjectFsServer: () => {},
    touchProjectLastEdited: () => {},
    markProjectArchiveInitialBackupExempt: (project_id) =>
      backupExempt.push(project_id),
    logger: { warn: () => {} },
  } as any);

  beforeAll(async () => {
    archives.empty = archiveOf(() => {});
    // its only file is over the per-file limit: user data, not an empty
    // project
    archives.oversize = archiveOf((src) => {
      mkdirSync(join(src, ".smc", "local_hub"), { recursive: true });
      writeFileSync(join(src, ".smc", "local_hub", "local_hub.port"), "6000\n");
      writeFileSync(join(src, "big.dat"), Buffer.alloc(4096, 1));
    });
    archives.state = archiveOf((src) => {
      mkdirSync(join(src, ".smc", "local_hub"), { recursive: true });
      writeFileSync(join(src, ".smc", "local_hub", "local_hub.port"), "6000\n");
    });
    server = createServer((req, res) => {
      const archive = archives[`${req.url}`.slice(1)];
      res.writeHead(200, { "content-length": archive.length });
      res.end(archive);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address == null || typeof address === "string") throw Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, ".snapshots"), { recursive: true });
    // a file the user made in the new project meanwhile
    writeFileSync(join(home, "new-work.txt"), "keep me\n");
    projectSnapshots.length = 0;
    backupExempt.length = 0;
  });

  it.each(["empty", "state"])(
    "restores the %s archive as empty, leaving the home alone",
    async (name) => {
      const project_id = "00000000-0000-4000-8000-000000000134";
      const result = await handlers.restoreProjectArchive({
        project_id,
        download: { url: `${base}/${name}` } as any,
      });
      expect(result).toEqual(
        expect.objectContaining({
          file_count: 0,
          empty_archive: true,
          missing_archive_file_count: 0,
        }),
      );
      expect(readFileSync(join(home, "new-work.txt"), "utf8")).toBe(
        "keep me\n",
      );
      expect(existsSync(join(home, ".smc"))).toBe(false);
      // nothing applied, so no safety snapshot either
      expect(projectSnapshots).toEqual([]);
      expect(readdirSync(join(home, ".snapshots"))).toEqual([]);
      expect(backupExempt).toEqual([project_id]);
    },
  );

  it("still fails when every restorable file was skipped as too large, naming the limit", async () => {
    const project_id = "00000000-0000-4000-8000-000000000135";
    await expect(
      handlers.restoreProjectArchive({
        project_id,
        download: { url: `${base}/oversize` } as any,
      }),
    ).rejects.toThrow(
      /no restorable files: 1 file\(s\) exceed the 1 KiB per-file limit \(COCALC_PROJECT_ARCHIVE_MAX_FILE_BYTES\)/,
    );
    // nothing applied, and not marked as an empty restore
    expect(readFileSync(join(home, "new-work.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(home, "big.dat"))).toBe(false);
    expect(projectSnapshots).toEqual([]);
    expect(backupExempt).toEqual([]);
  });
});
