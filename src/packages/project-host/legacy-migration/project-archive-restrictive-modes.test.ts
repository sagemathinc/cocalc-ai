/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// End-to-end restore of an archive containing a directory without owner
// search permission and a file without owner read permission (support
// ticket 21026). Before the fix, the apply rsync exited 23 and the whole
// restore failed.

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

const tmp = mkdtempSync(join(tmpdir(), "cocalc-archive-restrictive-modes-"));

jest.mock("@cocalc/backend/data", () => ({ data: join(tmp, "data") }));
jest.mock("../lro/stream", () => ({ publishLroEvent: async () => {} }));

import { createLegacyProjectArchiveHandlers } from "./project-archive";

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  }
}

// Like a btrfs snapshot, do not include the nested .snapshots tree.
function snapshotTree(source: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  run("rsync", ["-a", "--exclude=/.snapshots", `${source}/`, `${dest}/`]);
}

function removeTree(path?: string) {
  if (!path) return;
  spawnSync("chmod", ["-R", "u+rwX", path]);
  rmSync(path, { recursive: true, force: true });
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

describe("legacy project restore with restrictive archive modes", () => {
  let server: Server;
  let url: string;
  const home = join(tmp, "home");
  const warnings: { message: string; metadata?: any }[] = [];

  const handlers = createLegacyProjectArchiveHandlers({
    getOrEnsureVolume: async () => undefined,
    projectMountpoint: () => home,
    createWritableSnapshot: async (source, dest) => snapshotTree(source, dest),
    createReadonlySnapshot: async (source, dest) => snapshotTree(source, dest),
    setSubvolumeReadonly: async () => {},
    deleteSubvolumeTree: async (path) => removeTree(path),
    invalidateProjectFsServer: () => {},
    touchProjectLastEdited: () => {},
    logger: {
      warn: (message, metadata) => warnings.push({ message, metadata }),
    },
  });

  beforeAll(async () => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "course", "perms", "nosearch"), { recursive: true });
    writeFileSync(join(src, "course", "perms", "nosearch", "file"), "inside\n");
    writeFileSync(join(src, "course", "perms", "noread"), "secret\n");
    writeFileSync(join(src, "notes.txt"), "notes\n");
    const tarPath = join(tmp, "project.tar");
    run("tar", [
      "-cf",
      tarPath,
      "-C",
      src,
      "--exclude=./course/perms/nosearch",
      "--exclude=./course/perms/noread",
      ".",
    ]);
    // --mode lets an unprivileged user record the restrictive modes.
    run("tar", [
      "-rf",
      tarPath,
      "-C",
      src,
      "--mode=a-rwx",
      "./course/perms/noread",
    ]);
    run("tar", [
      "-rf",
      tarPath,
      "-C",
      src,
      "--mode=u=rw,go=",
      "./course/perms/nosearch",
    ]);
    const archive = zstdCompressSync(readFileSync(tarPath));
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": archive.length });
      res.end(archive);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address == null || typeof address === "string") throw Error("no port");
    url = `http://127.0.0.1:${address.port}/project.tar.zst`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    removeTree(tmp);
  });

  beforeEach(() => {
    removeTree(home);
    mkdirSync(join(home, ".snapshots"), { recursive: true });
    warnings.length = 0;
  });

  function expectRestored(root: string) {
    expect(
      readFileSync(join(root, "course", "perms", "nosearch", "file"), "utf8"),
    ).toBe("inside\n");
    expect(readFileSync(join(root, "course", "perms", "noread"), "utf8")).toBe(
      "secret\n",
    );
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("notes\n");
    expect(mode(join(root, "course", "perms", "nosearch"))).toBe(0o700);
    expect(mode(join(root, "course", "perms", "noread"))).toBe(0o400);
  }

  it("restores the whole archive", async () => {
    const result = await handlers.restoreProjectArchive({
      project_id: "00000000-0000-4000-8000-000000000021",
      download: { url } as any,
    });
    expect(result.missing_archive_file_count).toBe(0);
    expectRestored(home);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "legacy project archive restore granted owner access",
        metadata: expect.objectContaining({ adjusted_count: 2 }),
      }),
    ]);
  });

  it("prepares and applies a remediation snapshot", async () => {
    const prepared = await handlers.prepareLegacyProjectArchiveRemediation({
      project_id: "00000000-0000-4000-8000-000000000026",
      download: { url } as any,
    });
    expectRestored(join(home, prepared.snapshot_path));
    await handlers.applyLegacyProjectArchiveRemediation({
      project_id: "00000000-0000-4000-8000-000000000026",
      safety_snapshot_name: "before-test-apply",
    });
    expectRestored(home);
  });
});
