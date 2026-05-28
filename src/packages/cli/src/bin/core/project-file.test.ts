import assert from "node:assert/strict";
import test from "node:test";

import { createProjectFileOps } from "./project-file";

function createOps(readOnly = false) {
  const calls: string[] = [];
  const fs = {
    getListing: async () => ({
      files: {
        "a.txt": { isDir: false, size: 3, mtime: 1 },
      },
    }),
    readFile: async () => Buffer.from("abc"),
    writeFile: async () => {
      calls.push("writeFile");
    },
    rm: async () => {
      calls.push("rm");
    },
    mkdir: async () => {
      calls.push("mkdir");
    },
    ripgrep: async () => {
      calls.push("ripgrep");
      return { stdout: "", stderr: "", code: 0, truncated: false };
    },
    fd: async () => {
      calls.push("fd");
      return { stdout: "", stderr: "", code: 0, truncated: false };
    },
  };
  return {
    calls,
    ops: createProjectFileOps({
      resolveProjectFilesystem: async () => ({
        project: { project_id: "p", title: "Project" },
        fs,
        readOnly,
      }),
      resolveProjectFromArgOrContext: async () => ({
        project_id: "p",
        title: "Project",
      }),
      asUtf8: (value) => `${value ?? ""}`,
      normalizeProcessExitCode: (raw) => Number(raw) || 0,
      normalizeBoolean: (value) => value === true,
    }),
  };
}

test("project file read commands work against read-only viewer filesystems", async () => {
  const { ops } = createOps(true);

  assert.deepEqual(await ops.projectFileListData({ ctx: {} }), [
    {
      project_id: "p",
      path: ".",
      name: "a.txt",
      is_dir: false,
      size: 3,
      mtime: 1,
    },
  ]);
  assert.deepEqual(await ops.projectFileCatData({ ctx: {}, path: "a.txt" }), {
    project_id: "p",
    path: "a.txt",
    content: "abc",
    bytes: 3,
  });
  assert.deepEqual(await ops.projectFileGetData({ ctx: {}, src: "a.txt" }), {
    project_id: "p",
    src: "a.txt",
    bytes: 3,
    content_base64: Buffer.from("abc").toString("base64"),
    status: "downloaded",
  });
});

test("project file write commands reject read-only viewer filesystems before mutating", async () => {
  const { ops, calls } = createOps(true);

  await assert.rejects(
    ops.projectFilePutData({
      ctx: {},
      dest: "a.txt",
      data: Buffer.from("x"),
      parents: true,
    }),
    /viewer project access is read-only/,
  );
  await assert.rejects(
    ops.projectFileRmData({
      ctx: {},
      path: "a.txt",
      recursive: false,
      force: false,
    }),
    /viewer project access is read-only/,
  );
  await assert.rejects(
    ops.projectFileMkdirData({
      ctx: {},
      path: "dir",
      parents: false,
    }),
    /viewer project access is read-only/,
  );
  assert.deepEqual(calls, []);
});

test("project file search commands reject read-only viewer filesystems", async () => {
  const { ops, calls } = createOps(true);

  await assert.rejects(
    ops.projectFileRgData({
      ctx: {},
      pattern: "abc",
      timeoutMs: 1000,
      maxBytes: 1000,
    }),
    /search commands are not available for viewers yet/,
  );
  await assert.rejects(
    ops.projectFileFdData({
      ctx: {},
      timeoutMs: 1000,
      maxBytes: 1000,
    }),
    /search commands are not available for viewers yet/,
  );
  assert.deepEqual(calls, []);
});
