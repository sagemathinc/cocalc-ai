/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MulticellOutputHandler, restoreKernelFromIpynb } from "../control";

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
