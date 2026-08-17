/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { openJupyterLiveRunStore } from "@cocalc/conat/project/jupyter/live-run";
import NotebookEditor, {
  insertNotebookCellBelow,
  notebookOutputFromMessage,
} from "./notebook-editor";
import type { ExternalMergeHandle } from "./external-merge";

jest.mock("@cocalc/conat/project/jupyter/live-run", () => ({
  openJupyterLiveRunStore: jest.fn(),
}));

jest.mock("./codemirror-editor", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const Editor = React.forwardRef<any, any>((props, ref) => {
    const [value, setValue] = React.useState(props.initialValue);
    React.useImperativeHandle(ref, () => ({
      focus: jest.fn(),
      getValue: () => value,
      markClean: jest.fn(),
      rebaseValue: (_base: string, next: string) => setValue(next),
      replaceValue: setValue,
    }));
    return (
      <textarea
        aria-label={props.ariaLabel}
        onChange={(event) => {
          setValue(event.target.value);
          props.onChange?.(event.target.value);
          props.onDirtyChange?.(true);
        }}
        readOnly={props.readOnly}
        value={value}
      />
    );
  });
  Editor.displayName = "MockCodeMirrorEditor";
  return { __esModule: true, default: Editor };
});

const openJupyterLiveRunStoreMock = jest.mocked(openJupyterLiveRunStore);

class FakeLiveRunStore {
  snapshots: Record<string, any> = {};
  private listeners = new Set<() => void>();

  getAll = () => this.snapshots;
  on = (_event: string, listener: () => void) => {
    this.listeners.add(listener);
  };
  removeListener = (_event: string, listener: () => void) => {
    this.listeners.delete(listener);
  };
  close = jest.fn();
  emitChange = () => {
    for (const listener of this.listeners) listener();
  };
}

const baseContents = JSON.stringify({
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      id: "cell-1",
      metadata: {},
      outputs: [],
      source: "print('hello')",
    },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

async function setup({
  base = baseContents,
  editorRef,
  latest = baseContents,
  snapshots = {},
}: {
  base?: string;
  editorRef?: RefObject<ExternalMergeHandle | null>;
  latest?: string;
  snapshots?: Record<string, any>;
} = {}) {
  const liveRunStore = new FakeLiveRunStore();
  liveRunStore.snapshots = snapshots;
  openJupyterLiveRunStoreMock.mockResolvedValue(liveRunStore as any);
  const filesystem = {
    readFile: jest.fn(async () => latest),
    writeFileIfUnchanged: jest.fn(async () => undefined),
  };
  const signal = jest.fn(async () => undefined);
  const getKernelStatus = jest.fn(async () => ({
    backend_state: "running",
    kernel_state: "idle",
  }));
  const session = {
    ensureProjectRunning: jest.fn(async () => undefined),
    openProjectApi: jest.fn(async () => ({
      api: { jupyter: { getKernelStatus, signal } },
      lease: { client: {} },
    })),
  };
  await act(async () => {
    render(
      <NotebookEditor
        baseContents={base}
        filesystem={filesystem as any}
        notebook={JSON.parse(base)}
        path="/home/user/test.ipynb"
        project={
          {
            host_id: "host-1",
            project_id: "11111111-1111-4111-8111-111111111111",
            title: "Test",
          } as any
        }
        readOnly={false}
        ref={editorRef}
        session={session as any}
      />,
    );
    await Promise.resolve();
  });
  return { filesystem, getKernelStatus, liveRunStore, session, signal };
}

test("opening executable notebook controls does not start project compute", async () => {
  const { filesystem, session } = await setup();

  expect(await screen.findByText("Kernel: idle")).toBeVisible();
  expect(filesystem.readFile).not.toHaveBeenCalled();
  expect(session.ensureProjectRunning).not.toHaveBeenCalled();
});

test("renders Markdown cells until explicitly edited", async () => {
  const markdownContents = JSON.stringify({
    ...JSON.parse(baseContents),
    cells: [
      {
        cell_type: "markdown",
        id: "markdown-1",
        metadata: {},
        source: "## Rendered heading",
      },
    ],
  });
  await setup({ base: markdownContents, latest: markdownContents });

  expect(
    await screen.findByRole("heading", { name: "Rendered heading" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: "Source for cell 1" }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit markdown cell 1" }));
  expect(
    screen.getByRole("textbox", { name: "Source for cell 1" }),
  ).toHaveValue("## Rendered heading");

  fireEvent.click(
    screen.getByRole("button", { name: "Finish editing markdown cell 1" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Rendered heading" }),
  ).toBeVisible();
});

test("saving uses a conflict-safe write without starting compute", async () => {
  const { filesystem, session } = await setup();
  fireEvent.change(screen.getByRole("textbox", { name: "Source for cell 1" }), {
    target: { value: "print('changed')" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save notebook" }));

  await waitFor(() =>
    expect(filesystem.writeFileIfUnchanged).toHaveBeenCalledWith(
      "/home/user/test.ipynb",
      expect.stringContaining("print('changed')"),
      baseContents,
      true,
    ),
  );
  expect(session.ensureProjectRunning).not.toHaveBeenCalled();
});

test("merges independent notebook cells and saves against the newer base", async () => {
  const base = JSON.stringify({
    ...JSON.parse(baseContents),
    cells: [
      JSON.parse(baseContents).cells[0],
      {
        cell_type: "code",
        execution_count: null,
        id: "cell-2",
        metadata: {},
        outputs: [],
        source: "print('second')",
      },
    ],
  });
  const remoteNotebook = JSON.parse(base);
  remoteNotebook.cells[1].source = "print('remote')";
  const remote = JSON.stringify(remoteNotebook);
  const editorRef = createRef<ExternalMergeHandle>();
  const { filesystem } = await setup({ base, editorRef });
  fireEvent.change(screen.getByRole("textbox", { name: "Source for cell 1" }), {
    target: { value: "print('local')" },
  });

  let result;
  act(() => {
    result = editorRef.current?.mergeExternal(remote);
  });

  expect(result).toEqual({ clean: true, dirty: true });
  expect(
    screen.getByRole("textbox", { name: "Source for cell 1" }),
  ).toHaveValue("print('local')");
  expect(
    screen.getByRole("textbox", { name: "Source for cell 2" }),
  ).toHaveValue("print('remote')");
  expect(screen.getByText(/merged into your notebook draft/i)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Save notebook" }));
  await waitFor(() =>
    expect(filesystem.writeFileIfUnchanged).toHaveBeenCalledWith(
      "/home/user/test.ipynb",
      expect.stringMatching(/print\('local'\)[\s\S]*print\('remote'\)/),
      remote,
      true,
    ),
  );
});

test("retains a notebook draft when both sides changed one cell", async () => {
  const remoteNotebook = JSON.parse(baseContents);
  remoteNotebook.cells[0].source = "print('remote')";
  const editorRef = createRef<ExternalMergeHandle>();
  await setup({ editorRef });
  fireEvent.change(screen.getByRole("textbox", { name: "Source for cell 1" }), {
    target: { value: "print('local')" },
  });

  let result;
  act(() => {
    result = editorRef.current?.mergeExternal(JSON.stringify(remoteNotebook));
  });

  expect(result).toEqual({
    clean: false,
    message:
      "Automatic notebook merging was unsafe. Your draft was retained unchanged.",
  });
  expect(
    screen.getByRole("textbox", { name: "Source for cell 1" }),
  ).toHaveValue("print('local')");
  expect(screen.getByText(/use Full CoCalc to resolve/i)).toBeVisible();
});

test("a changed canonical notebook blocks execution before compute starts", async () => {
  const { filesystem, session } = await setup({
    latest: `${baseContents}\n`,
  });
  fireEvent.click(screen.getByRole("button", { name: "Run all" }));

  expect(
    await screen.findByText(/changed on the server.*Nothing was executed/i),
  ).toBeVisible();
  expect(filesystem.writeFileIfUnchanged).not.toHaveBeenCalled();
  expect(session.ensureProjectRunning).not.toHaveBeenCalled();
});

test("reattaches to a project-host run without submitting it again", async () => {
  const finishedContents = JSON.stringify({
    ...JSON.parse(baseContents),
    cells: [
      {
        ...JSON.parse(baseContents).cells[0],
        execution_count: 1,
        outputs: [{ output_type: "stream", name: "stdout", text: "done\n" }],
      },
    ],
  });
  const activeSnapshot = {
    active: {
      path: "/home/user/test.ipynb",
      run_id: "existing-run",
      updated_at_ms: Date.now(),
      batches: [
        {
          id: "existing-run:1",
          path: "/home/user/test.ipynb",
          run_id: "existing-run",
          seq: 1,
          sent_at_ms: Date.now(),
          mesgs: [
            {
              id: "cell-1",
              lifecycle: "cell_start",
              msg_type: "cell_start",
              run_id: "existing-run",
            },
          ],
        },
      ],
    },
  };
  const { filesystem, liveRunStore, session } = await setup({
    latest: finishedContents,
    snapshots: activeSnapshot,
  });

  expect(
    await screen.findByText("Kernel: reattached to active execution"),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Run all" })).toBeDisabled();
  expect(session.ensureProjectRunning).not.toHaveBeenCalled();

  liveRunStore.snapshots.active = {
    ...liveRunStore.snapshots.active,
    done: true,
    updated_at_ms: Date.now(),
    batches: [
      ...liveRunStore.snapshots.active.batches,
      {
        id: "existing-run:2",
        path: "/home/user/test.ipynb",
        run_id: "existing-run",
        seq: 2,
        sent_at_ms: Date.now(),
        mesgs: [
          {
            lifecycle: "run_done",
            msg_type: "run_done",
            run_id: "existing-run",
          },
        ],
      },
    ],
  };
  await act(async () => {
    liveRunStore.emitChange();
    await Promise.resolve();
  });

  expect(await screen.findByText("Kernel: idle")).toBeVisible();
  expect(filesystem.readFile).toHaveBeenCalledTimes(1);
  expect(screen.getByText("done")).toBeVisible();
  expect(session.ensureProjectRunning).not.toHaveBeenCalled();
});

test("can interrupt a reattached run", async () => {
  const { session, signal } = await setup({
    snapshots: {
      active: {
        path: "/home/user/test.ipynb",
        run_id: "existing-run",
        updated_at_ms: Date.now(),
        batches: [],
      },
    },
  });

  fireEvent.click(await screen.findByRole("button", { name: "Interrupt" }));

  await waitFor(() =>
    expect(signal).toHaveBeenCalledWith({
      path: "/home/user/.test.ipynb.sage-jupyter2",
      signal: "SIGINT",
    }),
  );
  expect(session.ensureProjectRunning).not.toHaveBeenCalled();
});

test("adds, moves, and deletes focused notebook cells", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "Add markdown cell" }));

  expect(
    screen.getByRole("textbox", { name: "Source for cell 2" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Move cell 2 up" }));
  expect(screen.getByText("markdown cell 1")).toBeVisible();

  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete cell 1" }));
  expect(screen.queryByText("markdown cell 1")).not.toBeInTheDocument();
  confirm.mockRestore();
});

test("inserts a code cell directly below the selected cell", () => {
  const notebook = JSON.parse(baseContents);
  const inserted = insertNotebookCellBelow(notebook, 0);

  expect(inserted.notebook.cells).toHaveLength(2);
  expect(inserted.notebook.cells[1]).toMatchObject({
    cell_type: "code",
    id: inserted.cellId,
    outputs: [],
    source: "",
  });
  expect(notebook.cells).toHaveLength(1);
});

test("converts only bounded safe Jupyter output", () => {
  expect(
    notebookOutputFromMessage({
      msg_type: "display_data",
      content: {
        data: {
          "application/javascript": "window.pwned = true",
          "text/html": "<script>window.pwned = true</script>",
          "text/plain": "safe text",
        },
      },
    } as any),
  ).toEqual({
    data: {
      "text/html": "[unsafe rich output omitted]",
      "text/plain": "safe text",
    },
    execution_count: null,
    metadata: {},
    output_type: "display_data",
  });

  const output = notebookOutputFromMessage({
    msg_type: "stream",
    content: { name: "stdout", text: "x".repeat(100_100) },
  } as any);
  expect(`${output?.text}`).toHaveLength(100_019);
  expect(`${output?.text}`.endsWith("[output truncated]")).toBe(true);
});
