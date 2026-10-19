/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { saveJupyterIpynb } from "./filesystem";
import { ipynbTextHasContent, isPlaceholderIpynb } from "./placeholder";

const PLACEHOLDER = {
  cells: [{ cell_type: "code", source: "", outputs: [], metadata: {} }],
  metadata: { kernelspec: { name: "python3" }, language_info: {} },
  nbformat: 4,
  nbformat_minor: 5,
};
const LAB = {
  cells: [
    { cell_type: "markdown", source: ["### Lab 3"], metadata: {} },
    {
      cell_type: "code",
      source: ["x = 1"],
      outputs: [],
      metadata: {},
      execution_count: null,
    },
  ],
  metadata: { kernelspec: { name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
};

describe("isPlaceholderIpynb", () => {
  it("recognizes empty notebooks", () => {
    expect(isPlaceholderIpynb({ cells: [] })).toBe(true);
    expect(isPlaceholderIpynb(PLACEHOLDER)).toBe(true);
    expect(isPlaceholderIpynb({ cells: [{ source: ["  \n"] }] })).toBe(true);
  });

  it.each([
    ["a cell with source", { cells: [{ source: "x" }] }],
    ["a cell with output", { cells: [{ source: "", outputs: [{}] }] }],
    ["two cells", { cells: [{}, {}] }],
    ["a markdown cell", { cells: [{ cell_type: "markdown", source: "" }] }],
    [
      "nbgrader cell metadata",
      { cells: [{ source: "", metadata: { nbgrader: { grade: true } } }] },
    ],
    ["cell tags", { cells: [{ source: "", metadata: { tags: ["x"] } }] }],
    [
      "notebook metadata beyond the kernel",
      { cells: [], metadata: { nbgrader: { __altered: false } } },
    ],
    ["not a notebook", undefined],
  ])("treats %s as content", (_label, ipynb) => {
    expect(isPlaceholderIpynb(ipynb)).toBe(false);
  });
});

describe("ipynbTextHasContent", () => {
  it("is false only for empty files and empty notebooks", () => {
    expect(ipynbTextHasContent("")).toBe(false);
    expect(ipynbTextHasContent(" \n")).toBe(false);
    expect(ipynbTextHasContent(JSON.stringify(PLACEHOLDER))).toBe(false);
    expect(ipynbTextHasContent(JSON.stringify(LAB))).toBe(true);
  });

  it("fails closed on text that does not parse (a file still being written)", () => {
    expect(ipynbTextHasContent(JSON.stringify(LAB).slice(0, 40))).toBe(true);
  });
});

function memoryFs(files: Record<string, string>, readError?: Error) {
  return {
    files,
    readFile: jest.fn(async (path: string) => {
      if (readError) throw readError;
      if (!(path in files)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return Buffer.from(files[path]);
    }),
    writeFile: jest.fn(async (path: string, data: string) => {
      files[path] = data;
    }),
    stat: jest.fn(async (path: string) => {
      if (!(path in files)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { size: files[path].length, mtimeMs: 1 };
    }),
  } as any;
}

const blobStore = {
  loadBlob: jest.fn(async () => undefined),
  saveBlob: jest.fn(async () => {
    throw Error("no blobs expected");
  }),
} as any;

describe("saveJupyterIpynb onlyIfNoContent", () => {
  const save = (fs, path = "a.ipynb") =>
    saveJupyterIpynb({
      project_id: "00000000-0000-4000-8000-000000000001",
      path,
      ipynb: PLACEHOLDER,
      fs,
      blobStore,
      options: { onlyIfNoContent: true },
    });

  it("refuses to replace a file with content", async () => {
    const fs = memoryFs({ "a.ipynb": JSON.stringify(LAB) });
    const result = await save(fs);
    expect(result.skipped).toBe("disk_has_content");
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(JSON.parse(fs.files["a.ipynb"])).toEqual(LAB);
  });

  it("refuses when the file was written after the client decided to save", async () => {
    // The client saw an empty file; the course copy lands before the save
    // reaches the project host. The check happens there, right before writing.
    const fs = memoryFs({ "a.ipynb": "" });
    fs.files["a.ipynb"] = JSON.stringify(LAB);
    const result = await save(fs);
    expect(result.skipped).toBe("disk_has_content");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("refuses when the file is partially written (does not parse)", async () => {
    const fs = memoryFs({ "a.ipynb": JSON.stringify(LAB).slice(0, 50) });
    expect((await save(fs)).skipped).toBe("disk_has_content");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("refuses when the file cannot be read", async () => {
    const fs = memoryFs({ "a.ipynb": "" }, new Error("EIO"));
    expect((await save(fs)).skipped).toBe("disk_has_content");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["empty", { "a.ipynb": "" }],
    ["itself an empty notebook", { "a.ipynb": JSON.stringify(PLACEHOLDER) }],
  ])("writes when the file is %s", async (_label, files) => {
    const fs = memoryFs({ ...files });
    const result = await save(fs);
    expect(result.skipped).toBeUndefined();
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it("writes normally without the option", async () => {
    const fs = memoryFs({ "a.ipynb": JSON.stringify(LAB) });
    const result = await saveJupyterIpynb({
      project_id: "00000000-0000-4000-8000-000000000001",
      path: "a.ipynb",
      ipynb: PLACEHOLDER,
      fs,
      blobStore,
    });
    expect(result.skipped).toBeUndefined();
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });
});
