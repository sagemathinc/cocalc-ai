/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { List, Map } from "immutable";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import {
  createJupyterSyncFilesystem,
  hydrateNotebookFromIpynbIfNeeded,
  loadKernelSpecsIntoStore,
  MulticellOutputHandler,
  notebookCellsMatchExpected,
  restoreKernelFromIpynb,
} from "../control";

jest.mock("@cocalc/jupyter/kernel/kernel-data", () => ({
  get_kernel_data: jest.fn(),
}));

const { get_kernel_data } = jest.requireMock(
  "@cocalc/jupyter/kernel/kernel-data",
);

describe("restoreKernelFromIpynb", () => {
  function createActions(kernel: string | null = null) {
    return {
      store: {
        get: (key: string) => (key === "kernel" ? kernel : undefined),
      } as any,
      setState: jest.fn(),
      syncdb: {
        set: jest.fn(),
        commit: jest.fn(),
        save: jest.fn(async () => {}),
      } as any,
    };
  }

  it("recovers the kernel from notebook metadata when backend state is missing it", async () => {
    const actions = createActions();
    const restored = await restoreKernelFromIpynb({
      actions,
      fs: {
        readFile: async () =>
          Buffer.from(
            JSON.stringify({
              metadata: { kernelspec: { name: "python3" } },
            }),
          ),
      },
      path: "/tmp/test.ipynb",
    });

    expect(restored).toBe(true);
    expect(actions.syncdb.set).toHaveBeenCalledWith({
      type: "settings",
      kernel: "python3",
    });
    expect(actions.syncdb.commit).toHaveBeenCalled();
    expect(actions.syncdb.save).toHaveBeenCalled();
    expect(actions.setState).toHaveBeenCalledWith({ kernel: "python3" });
  });

  it("does nothing when the backend already has a kernel", async () => {
    const actions = createActions("python3");
    const readFile = jest.fn(async () => Buffer.from(""));
    const restored = await restoreKernelFromIpynb({
      actions,
      fs: { readFile },
      path: "/tmp/test.ipynb",
    });

    expect(restored).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    expect(actions.syncdb.set).not.toHaveBeenCalled();
  });

  it("reads the original ipynb file even when started from the syncdb path", async () => {
    const actions = createActions();
    const readFile = jest.fn(async () =>
      Buffer.from(
        JSON.stringify({
          metadata: { kernelspec: { name: "python3" } },
        }),
      ),
    );
    const restored = await restoreKernelFromIpynb({
      actions,
      fs: { readFile },
      path: "/tmp/.test.ipynb.sage-jupyter2",
    });

    expect(restored).toBe(true);
    expect(readFile).toHaveBeenCalledWith("/tmp/test.ipynb");
  });

  it("falls back to reading the absolute notebook path directly when project fs rejects it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jupyter-control-"));
    const notebookPath = join(dir, "test.ipynb");
    try {
      await writeFile(
        notebookPath,
        JSON.stringify({
          metadata: { kernelspec: { name: "python3" } },
        }),
      );
      const actions = createActions();
      const restored = await restoreKernelFromIpynb({
        actions,
        fs: {
          readFile: async () => {
            const err: NodeJS.ErrnoException = new Error("missing");
            err.code = "ENOENT";
            throw err;
          },
        },
        path: notebookPath,
      });

      expect(restored).toBe(true);
      expect(actions.syncdb.set).toHaveBeenCalledWith({
        type: "settings",
        kernel: "python3",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing for an empty ipynb file", async () => {
    const actions = createActions();
    const restored = await restoreKernelFromIpynb({
      actions,
      fs: { readFile: async () => Buffer.alloc(0) },
      path: "/tmp/test.ipynb",
    });

    expect(restored).toBe(false);
    expect(actions.syncdb.set).not.toHaveBeenCalled();
  });
});

describe("hydrateNotebookFromIpynbIfNeeded", () => {
  function createActions(existingCells: any[] = []) {
    return {
      syncdb: {
        get: jest.fn(() => existingCells),
      },
      setToIpynb: jest.fn(async () => {}),
    } as any;
  }

  it("hydrates an empty live notebook from the ipynb file", async () => {
    const actions = createActions();
    const hydrated = await hydrateNotebookFromIpynbIfNeeded({
      actions,
      fs: {
        readFile: async () =>
          Buffer.from(
            JSON.stringify({
              cells: [{ cell_type: "code", source: ["2+3\n"] }],
            }),
          ),
      },
      path: "/tmp/test.ipynb",
    });

    expect(hydrated).toBe(true);
    expect(actions.setToIpynb).toHaveBeenCalledTimes(1);
  });

  it("does nothing when live cells already exist", async () => {
    const actions = createActions([{ type: "cell", id: "abc" }]);
    const readFile = jest.fn(async () => Buffer.from("{}"));
    const hydrated = await hydrateNotebookFromIpynbIfNeeded({
      actions,
      fs: { readFile },
      path: "/tmp/test.ipynb",
    });

    expect(hydrated).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("does nothing when the ipynb has no cells", async () => {
    const actions = createActions();
    const hydrated = await hydrateNotebookFromIpynbIfNeeded({
      actions,
      fs: {
        readFile: async () => Buffer.from(JSON.stringify({ cells: [] })),
      },
      path: "/tmp/test.ipynb",
    });

    expect(hydrated).toBe(false);
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });
});

describe("loadKernelSpecsIntoStore", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("loads real discovered kernels into the project-side store", async () => {
    get_kernel_data.mockResolvedValue([
      {
        name: "python3",
        display_name: "Python 3",
        language: "python",
        argv: ["python3"],
        metadata: {},
      },
      {
        name: "hidden",
        display_name: "Hidden",
        language: "python",
        argv: ["hidden"],
        metadata: { cocalc: { disabled: true } },
      },
    ]);
    const setState = jest.fn();
    const loaded = await loadKernelSpecsIntoStore({
      actions: {
        store: {
          get: (key: string) => {
            if (key === "kernels") {
              return undefined;
            }
            if (key === "kernel") {
              return "python3";
            }
            return undefined;
          },
          get_kernel_selection: () => Map({ python: "python3" }),
          get_default_kernel: () => undefined,
        } as any,
        setState,
      },
    });

    expect(loaded).toBe(true);
    expect(get_kernel_data).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(1);
    const state = setState.mock.calls[0][0];
    expect(state.kernel_info).toEqual(
      expect.objectContaining({
        name: "python3",
        display_name: "Python 3",
        language: "python",
      }),
    );
    expect(state.kernels.toJS()).toEqual([
      expect.objectContaining({
        name: "python3",
        display_name: "Python 3",
        language: "python",
      }),
    ]);
    expect(state.kernels_by_name.keySeq().toJS()).toEqual(["python3"]);
    expect(state.kernels_by_language.keySeq().toJS()).toEqual(["python"]);
  });

  it("does nothing when kernels are already loaded", async () => {
    const loaded = await loadKernelSpecsIntoStore({
      actions: {
        store: {
          get: (key: string) =>
            key === "kernels" ? Map({ already: "loaded" }) : undefined,
        } as any,
        setState: jest.fn(),
      },
    });

    expect(loaded).toBe(false);
    expect(get_kernel_data).not.toHaveBeenCalled();
  });
});

describe("notebookCellsMatchExpected", () => {
  function createCells() {
    return Map({
      a: Map({ id: "a", cell_type: "code", input: "2+3" }),
      b: Map({ id: "b", cell_type: "markdown", input: "hello" }),
      c: Map({ id: "c", cell_type: "code", input: "print(5)" }),
    });
  }

  it("requires the exact expected cell order when provided", () => {
    const cells = createCells();
    const cellList = List(["a", "b", "c"]);

    expect(
      notebookCellsMatchExpected({
        cells,
        cellList,
        expectedCellCount: 3,
        expectedCellIdsInOrder: ["a", "b", "c"],
      }),
    ).toBe(true);
    expect(
      notebookCellsMatchExpected({
        cells,
        cellList,
        expectedCellCount: 3,
        expectedCellIdsInOrder: ["b", "a", "c"],
      }),
    ).toBe(false);
  });

  it("still validates cell content alongside order", () => {
    const cells = createCells();
    const cellList = List(["a", "b", "c"]);

    expect(
      notebookCellsMatchExpected({
        cells,
        cellList,
        expectedCellIdsInOrder: ["a", "b", "c"],
        expectedCells: [{ id: "b", cell_type: "markdown", input: "hello" }],
      }),
    ).toBe(true);
    expect(
      notebookCellsMatchExpected({
        cells,
        cellList,
        expectedCellIdsInOrder: ["a", "b", "c"],
        expectedCells: [{ id: "b", cell_type: "code" }],
      }),
    ).toBe(false);
  });
});

describe("MulticellOutputHandler", () => {
  it("clears durable stale output as soon as a cell starts running", () => {
    const actions = {
      set_runtime_cell_state: jest.fn(),
      _set: jest.fn(),
      processOutput: jest.fn(),
      save_asap: jest.fn(),
    };
    const handler = new MulticellOutputHandler(
      {
        a: {
          id: "a",
          exec_count: 17,
          output: { 0: { text: "old output" } },
        },
      } as any,
      actions,
    );

    handler.process({
      id: "a",
      content: { execution_state: "busy" },
    });

    expect(actions._set).toHaveBeenCalledWith(
      {
        type: "cell",
        id: "a",
        output: null,
        exec_count: null,
      },
      true,
    );
    expect(actions.save_asap).toHaveBeenCalledTimes(1);
  });

  it("keeps fallback output local until terminal flush", () => {
    const actions = {
      set_runtime_cell_state: jest.fn(),
      _set: jest.fn(),
      processOutput: jest.fn(),
      save_asap: jest.fn(),
    };
    const handler = new MulticellOutputHandler(
      { a: { id: "a" } } as any,
      actions,
    );

    handler.process({
      id: "a",
      content: { execution_state: "busy" },
    });
    handler.process({
      id: "a",
      msg_type: "stream",
      content: { name: "stdout", text: "x\n" },
    });
    handler.done();

    expect(actions._set).toHaveBeenCalled();
    expect(actions._set.mock.calls[0][1]).toBe(true);
    expect(actions._set.mock.calls.some((call) => call[1] === false)).toBe(
      true,
    );
    expect(actions._set.mock.calls.at(-1)?.[1]).toBe(true);
  });
});

describe("createJupyterSyncFilesystem", () => {
  it("preserves absolute sync identities for project-home files in unsafe mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "jupyter-control-home-"));
    try {
      const fs = new SandboxedFilesystem(home, { unsafeMode: true });
      const wrapped = createJupyterSyncFilesystem(fs);
      const syncPath = join(home, ".widgets.ipynb.sage-jupyter2");
      await writeFile(syncPath, "{}");

      expect(await wrapped.readFile(syncPath, "utf8")).toBe("{}");
      expect(await wrapped.canonicalSyncIdentityPath?.(syncPath)).toBe(
        syncPath,
      );
      expect(await wrapped.canonicalSyncFsPath?.(syncPath)).toBe(syncPath);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("supports absolute notebook paths outside the project home in unsafe mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "jupyter-control-home-"));
    const outside = await mkdtemp(join(tmpdir(), "jupyter-control-outside-"));
    try {
      const fs = new SandboxedFilesystem(home, { unsafeMode: true });
      const wrapped = createJupyterSyncFilesystem(fs);
      const notebookPath = join(outside, "test.ipynb");
      const syncPath = join(outside, ".test.ipynb.sage-jupyter2");
      await writeFile(notebookPath, "{}");
      await writeFile(syncPath, "[]");

      expect(await wrapped.readFile(notebookPath, "utf8")).toBe("{}");
      expect(await wrapped.readFile(syncPath, "utf8")).toBe("[]");
      expect(await wrapped.canonicalSyncIdentityPath?.(syncPath)).toBe(
        syncPath,
      );
      expect(await wrapped.canonicalSyncFsPath?.(syncPath)).toBe(syncPath);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
