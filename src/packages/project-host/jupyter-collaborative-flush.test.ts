/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { SyncDB } from "@cocalc/sync/editor/db";

let documentMock: any;
const saveJupyterIpynbMock = jest.fn();
const jupyterNotebookContentsMock = jest.fn();

jest.mock("@cocalc/sync/editor/db", () => ({
  SyncDB: jest.fn(() => documentMock),
}));

jest.mock("./jupyter-ipynb", () => ({
  saveJupyterIpynb: (...args: any[]) => saveJupyterIpynbMock(...args),
}));

let filesystemMock: any;
jest.mock("@cocalc/conat/files/fs", () => ({
  ...jest.requireActual("@cocalc/conat/files/fs"),
  fsClient: jest.fn(() => filesystemMock),
}));

jest.mock("@cocalc/conat/sync-doc/sync-client", () => ({
  SyncClient: jest.fn(() => ({ close: jest.fn() })),
}));

jest.mock("./jupyter-notebook-contents", () => ({
  jupyterNotebookContents: (...args: any[]) =>
    jupyterNotebookContentsMock(...args),
}));

function stat(kind: "file" | "directory" | "symlink") {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  };
}

describe("collaborative Jupyter collection flush", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jupyterNotebookContentsMock.mockReturnValue(
      '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n',
    );
  });

  it("finds notebooks recursively without following links or checkpoints", async () => {
    const lstat = jest.fn(async (value: string) => {
      const kinds: Record<string, "file" | "directory" | "symlink"> = {
        assignment: "directory",
        "assignment/a.ipynb": "file",
        "assignment/notes.txt": "file",
        "assignment/nested": "directory",
        "assignment/nested/b.ipynb": "file",
        "assignment/link": "symlink",
      };
      if (!kinds[value]) throw new Error(`unexpected path ${value}`);
      return stat(kinds[value]);
    });
    const readdir = jest.fn(async (value: string) => {
      if (value === "assignment") {
        return [
          { name: "a.ipynb" },
          { name: "notes.txt" },
          { name: "nested" },
          { name: "link" },
          { name: ".ipynb_checkpoints" },
        ];
      }
      if (value === "assignment/nested") {
        return [{ name: "b.ipynb" }];
      }
      throw new Error(`unexpected directory ${value}`);
    });
    const { findJupyterNotebooks } =
      await import("./jupyter-collaborative-flush");

    await expect(
      findJupyterNotebooks({
        filesystem: { lstat, readdir } as any,
        paths: ["assignment"],
      }),
    ).resolves.toEqual(["assignment/a.ipynb", "assignment/nested/b.ipynb"]);
    expect(lstat).not.toHaveBeenCalledWith("assignment/.ipynb_checkpoints");
  });

  it("saves a stable collaborative version and records its disk hash", async () => {
    documentMock = {
      wait_until_ready: jest.fn(async () => undefined),
      newestVersion: jest.fn(() => "version-1"),
      get_doc: jest.fn(() => ({})),
      close: jest.fn(async () => undefined),
    };
    const saved = Buffer.from("portable notebook on disk");
    const readFile = jest
      .fn()
      .mockResolvedValueOnce('{"metadata":{}}')
      .mockResolvedValueOnce(saved);
    saveJupyterIpynbMock.mockResolvedValue({ bytes: saved.length });
    const { flushJupyterNotebook } =
      await import("./jupyter-collaborative-flush");

    const result = await flushJupyterNotebook({
      project_id: "project",
      notebook_path: "assignment/work.ipynb",
      actor_account_id: "instructor",
      filesystem: { readFile } as any,
      syncClient: {} as any,
    });

    expect(saveJupyterIpynbMock).toHaveBeenCalledTimes(1);
    expect(SyncDB).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/home/user/assignment/.work.ipynb.sage-jupyter2",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        path: "assignment/work.ipynb",
        version: "version-1",
        bytes: saved.length,
        sha256: createHash("sha256").update(saved).digest("hex"),
      }),
    );
    expect(documentMock.close).toHaveBeenCalled();
  });

  it("retries when the collaborative version changes during a save", async () => {
    const versions = ["version-1", "version-1", "version-2", "version-2"];
    documentMock = {
      wait_until_ready: jest.fn(async () => undefined),
      newestVersion: jest.fn(() => versions.shift() ?? "version-2"),
      get_doc: jest.fn(() => ({})),
      close: jest.fn(async () => undefined),
    };
    const saved = Buffer.from("second save");
    const readFile = jest
      .fn()
      .mockResolvedValueOnce('{"metadata":{}}')
      .mockResolvedValueOnce(saved);
    saveJupyterIpynbMock.mockResolvedValue({ bytes: saved.length });
    const { flushJupyterNotebook } =
      await import("./jupyter-collaborative-flush");

    const result = await flushJupyterNotebook({
      project_id: "project",
      notebook_path: "assignment/work.ipynb",
      actor_account_id: "instructor",
      filesystem: { readFile } as any,
      syncClient: {} as any,
    });

    expect(saveJupyterIpynbMock).toHaveBeenCalledTimes(2);
    expect(result?.version).toBe("version-2");
  });

  it("does not overwrite a disk-only notebook with an empty sync document", async () => {
    documentMock = {
      wait_until_ready: jest.fn(async () => undefined),
      newestVersion: jest.fn(() => undefined),
      get_doc: jest.fn(() => ({})),
      close: jest.fn(async () => undefined),
    };
    const { flushJupyterNotebook } =
      await import("./jupyter-collaborative-flush");

    await expect(
      flushJupyterNotebook({
        project_id: "project",
        notebook_path: "assignment/work.ipynb",
        actor_account_id: "instructor",
        filesystem: {} as any,
        syncClient: {} as any,
      }),
    ).resolves.toBeUndefined();
    expect(saveJupyterIpynbMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a notebook with content with the generated placeholder", async () => {
    // Support ticket 21023: a student opened the lab while it was still
    // empty, so the live notebook is only the generated empty cell.
    const { List, fromJS } = require("immutable");
    const lab = JSON.stringify({
      cells: [{ cell_type: "markdown", source: ["### Lab 3"], metadata: {} }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
    const placeholderDoc = (settings: object) => ({
      wait_until_ready: jest.fn(async () => undefined),
      newestVersion: jest.fn(() => "version-1"),
      get_doc: jest.fn(() => ({})),
      get: jest.fn(() =>
        List([fromJS({ type: "cell", id: "alpha", pos: 0, input: "" })]),
      ),
      get_one: jest.fn(() => fromJS({ type: "settings", ...settings })),
      close: jest.fn(async () => undefined),
    });
    const filesystem = {
      readFile: jest.fn(async () => Buffer.from(lab)),
      stat: jest.fn(async () => stat("file")),
    };
    const { flushJupyterNotebook } =
      await import("./jupyter-collaborative-flush");
    const flush = () =>
      flushJupyterNotebook({
        project_id: "project",
        notebook_path: "assignment/lab3.ipynb",
        actor_account_id: "instructor",
        filesystem: filesystem as any,
        syncClient: {} as any,
      });

    // The file is kept, and still recorded as this collaborative version
    // with the hash of the bytes kept (collection relies on that record,
    // e.g. to refuse reusing an older backup).
    const kept = {
      path: "assignment/lab3.ipynb",
      version: "version-1",
      sha256: createHash("sha256").update(Buffer.from(lab)).digest("hex"),
      bytes: Buffer.byteLength(lab),
    };
    documentMock = placeholderDoc({});
    await expect(flush()).resolves.toEqual(expect.objectContaining(kept));
    expect(saveJupyterIpynbMock).not.toHaveBeenCalled();

    // Likewise for a notebook that has no cells yet.
    documentMock = { ...placeholderDoc({}), get: jest.fn(() => List()) };
    await expect(flush()).resolves.toEqual(expect.objectContaining(kept));
    expect(saveJupyterIpynbMock).not.toHaveBeenCalled();

    // A notebook emptied on purpose is still flushed.
    documentMock = placeholderDoc({ has_had_content: true });
    await flush();
    expect(saveJupyterIpynbMock).toHaveBeenCalledTimes(1);
  });

  it("saves an edit made while the placeholder check reads the file", async () => {
    const { List, fromJS } = require("immutable");
    const lab = JSON.stringify({
      cells: [{ cell_type: "markdown", source: ["### Lab 3"], metadata: {} }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
    let version = "version-1";
    let reads = 0;
    let cell: any = { type: "cell", id: "alpha", pos: 0, input: "" };
    documentMock = {
      wait_until_ready: jest.fn(async () => undefined),
      newestVersion: jest.fn(() => version),
      get_doc: jest.fn(() => ({})),
      get: jest.fn(() => List([fromJS(cell)])),
      get_one: jest.fn(() => fromJS({ type: "settings" })),
      close: jest.fn(async () => undefined),
    };
    const filesystem = {
      readFile: jest.fn(async () => {
        // The first read is for metadata, before the stability loop; the
        // student types into the cell while the placeholder guard reads.
        reads += 1;
        if (reads === 2) {
          cell = { ...cell, input: "answer = 42" };
          version = "version-2";
        }
        return Buffer.from(lab);
      }),
    };
    const { flushJupyterNotebook } =
      await import("./jupyter-collaborative-flush");

    const result = await flushJupyterNotebook({
      project_id: "project",
      notebook_path: "assignment/lab3.ipynb",
      actor_account_id: "instructor",
      filesystem: filesystem as any,
      syncClient: {} as any,
    });

    expect(saveJupyterIpynbMock).toHaveBeenCalledTimes(1);
    expect(result?.version).toBe("version-2");
  });

  it("reports a kept notebook to collection, so it never reuses an older backup", async () => {
    // copy.ts disables recent-backup reuse only when the flush reports
    // source versions; a notebook whose file was kept must be reported too.
    const { List, fromJS } = require("immutable");
    const lab = JSON.stringify({
      cells: [{ cell_type: "markdown", source: ["### Lab 3"], metadata: {} }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
    documentMock = {
      wait_until_ready: jest.fn(async () => undefined),
      newestVersion: jest.fn(() => "version-1"),
      get_doc: jest.fn(() => ({})),
      get: jest.fn(() =>
        List([fromJS({ type: "cell", id: "alpha", pos: 0, input: "" })]),
      ),
      get_one: jest.fn(() => fromJS({ type: "settings" })),
      close: jest.fn(async () => undefined),
    };
    filesystemMock = {
      lstat: jest.fn(async (value: string) =>
        stat(value === "assignment" ? "directory" : "file"),
      ),
      readdir: jest.fn(async () => [{ name: "lab3.ipynb" }]),
      readFile: jest.fn(async () => Buffer.from(lab)),
    };
    const { flushJupyterNotebooksToDisk } =
      await import("./jupyter-collaborative-flush");

    const { notebooks } = await flushJupyterNotebooksToDisk({
      client: {} as any,
      project_id: "6f0e5a0c-6a0f-4b5e-9d1e-2a3b4c5d6e7f",
      paths: ["assignment"],
      actor_account_id: "instructor",
    });

    expect(saveJupyterIpynbMock).not.toHaveBeenCalled();
    expect(notebooks).toEqual([
      expect.objectContaining({
        path: "assignment/lab3.ipynb",
        version: "version-1",
        sha256: createHash("sha256").update(Buffer.from(lab)).digest("hex"),
      }),
    ]);
  });

  it("never writes the generated placeholder, even when the file reads as empty", async () => {
    // A course copy can truncate the file, so it reads as empty here, and
    // fill it in right after: the flush keeps and records what is there.
    const { List, fromJS } = require("immutable");
    const placeholder = {
      wait_until_ready: jest.fn(async () => undefined),
      newestVersion: jest.fn(() => "version-1"),
      get_doc: jest.fn(() => ({})),
      get: jest.fn(() =>
        List([fromJS({ type: "cell", id: "alpha", pos: 0, input: "" })]),
      ),
      get_one: jest.fn(() => fromJS({ type: "settings" })),
      close: jest.fn(async () => undefined),
    };
    const { flushJupyterNotebook } =
      await import("./jupyter-collaborative-flush");
    const flush = (filesystem: any) =>
      flushJupyterNotebook({
        project_id: "project",
        notebook_path: "assignment/lab3.ipynb",
        actor_account_id: "instructor",
        filesystem,
        syncClient: {} as any,
      });

    documentMock = placeholder;
    await expect(
      flush({ readFile: jest.fn(async () => Buffer.from("")) }),
    ).resolves.toEqual(expect.objectContaining({ bytes: 0 }));

    // The file is removed after it was found: nothing to write and nothing
    // to collect.
    documentMock = placeholder;
    let reads = 0;
    const missing = jest.fn(async () => {
      reads += 1;
      if (reads === 1) return Buffer.from(""); // metadata read
      const err: any = new Error("missing");
      err.code = "ENOENT";
      throw err;
    });
    await expect(flush({ readFile: missing })).resolves.toBeUndefined();

    expect(saveJupyterIpynbMock).not.toHaveBeenCalled();
  });
});
