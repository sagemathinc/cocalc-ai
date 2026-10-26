/*
A project-host keeps each project's databases in a directory (volume) of their
own, which it prepares before the persist server opens any of them.
*/

import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { initContext, setPrepareProjectStore, syncFiles } from "./context";
import { getStream, projectStoreRoot } from "./util";

const PROJECT = "11111111-2222-4333-8444-555555555555";

let dir: string;
let prepared: { project_id: string; root: string }[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "persist-project-store-"));
  initContext({
    sqlite: { DatabaseSync },
    compress: zstdCompressSync,
    decompress: (data, maxOutputLength) =>
      zstdDecompressSync(data, maxOutputLength ? { maxOutputLength } : {}),
    syncFiles: {
      ...syncFiles,
      localProjects: join(dir, "project-[project_id]-persist"),
    },
    statSync,
    copyFileSync,
    ensureContainingDirectoryExists: async (path) => {
      mkdirSync(join(path, ".."), { recursive: true });
    },
  });
});

beforeEach(() => {
  prepared = [];
});

afterAll(() => {
  setPrepareProjectStore(async () => {});
  rmSync(dir, { recursive: true, force: true });
});

const storage = { path: `projects/${PROJECT}/patchflow/a` };
const subject = `persist.project-${PROJECT}.x`;

it("finds the directory that holds a project's databases", () => {
  expect(projectStoreRoot(storage.path)).toEqual({
    project_id: PROJECT,
    root: join(dir, `project-${PROJECT}-persist`),
  });
  expect(projectStoreRoot("accounts/x/y")).toBeUndefined();
});

it("prepares the directory before opening a project's database", async () => {
  setPrepareProjectStore(async (opts) => {
    prepared.push(opts);
    mkdirSync(opts.root, { recursive: true });
  });
  const stream = await getStream({ subject, storage });
  expect(prepared).toEqual([
    { project_id: PROJECT, root: join(dir, `project-${PROJECT}-persist`) },
  ]);
  expect(
    existsSync(join(dir, `project-${PROJECT}-persist`, "patchflow", "a.db")),
  ).toBe(true);
  stream.close();
});

it("opens nothing when preparing it fails", async () => {
  setPrepareProjectStore(async () => {
    throw new Error("project root does not exist");
  });
  const other = `projects/${PROJECT}/patchflow/b`;
  await expect(
    getStream({ subject, storage: { path: other } }),
  ).rejects.toThrow("project root does not exist");
  expect(
    existsSync(join(dir, `project-${PROJECT}-persist`, "patchflow", "b.db")),
  ).toBe(false);
});

it("does not prepare anything for ephemeral streams", async () => {
  setPrepareProjectStore(async (opts) => {
    prepared.push(opts);
  });
  const stream = await getStream({
    subject,
    storage: { path: `projects/${PROJECT}/ephemeral`, ephemeral: true },
  });
  expect(prepared).toEqual([]);
  stream.close();
});
