import type { DocumentBuildSnapshot } from "@cocalc/app-document-build";
import { Map as ImmutableMap } from "immutable";

jest.mock("@cocalc/frontend/monitoring/ux-latency-trace", () => ({
  afterNextPaint: (callback: () => void) => callback(),
  UxLatencyTrace: class {
    mark = jest.fn();
    record = jest.fn();
  },
}));

import { Actions } from "./actions";

function terminalSnapshot(
  state: DocumentBuildSnapshot["state"] = "succeeded",
): DocumentBuildSnapshot {
  return {
    build_id: "build-1",
    identity: {
      kind: "latex",
      logical_path: "/home/user/paper.tex",
      working_path: "/home/user/paper.tex",
      resource_key: "/home/user/paper.tex",
    },
    state,
    seq: 1,
    submitted_at: 100,
    started_at: 110,
    ended_at: 120,
    build_timeout_ms: 60_000,
    force: false,
    stages: [],
    diagnostics: [],
    dependencies: [],
    artifacts:
      state === "succeeded"
        ? [{ path: "/home/user/paper.pdf", type: "pdf" }]
        : [],
    exit_code: state === "succeeded" ? 0 : 1,
  };
}

function createActions() {
  let state = ImmutableMap<string, any>({
    build_logs: ImmutableMap(),
    value: "saved source",
  });
  const actions: any = Object.create(Actions.prototype);
  const start = jest.fn(async () => terminalSnapshot());
  const cancel = jest.fn(async () => terminalSnapshot("canceled"));
  actions.project_id = "project-1";
  actions.path = "/home/user/paper.tex";
  actions.knitr = false;
  actions.bad_filename = false;
  actions.is_building = false;
  actions.build_snapshot_seq = new Map();
  actions.refreshed_build_ids = new Set();
  actions.terminal_build_snapshots = new Map();
  actions.build_waiters = new Map();
  actions.document_build_api = () => ({ start, cancel });
  actions.store = {
    get: (key: string) => state.get(key),
    getIn: (path: string[]) => state.getIn(path),
  };
  actions.setState = jest.fn((patch: Record<string, unknown>) => {
    state = state.merge(patch);
  });
  actions.set_error = jest.fn();
  actions.set_status = jest.fn();
  actions.save_all = jest.fn(async () => undefined);
  actions.build_command_save = Promise.resolve();
  actions.last_save_time = jest.fn(() => 123);
  actions.get_output_directory = jest.fn(() => "/tmp/output");
  actions._has_frame_of_type = jest.fn(() => false);
  actions.update_gutters = jest.fn();
  actions.update_gutters_soon = jest.fn(async () => undefined);
  actions.check_for_fatal_error = jest.fn();
  actions.update_pdf = jest.fn();
  actions.set_switch_to_files = jest.fn(async () => undefined);
  actions.is_read_only_preview = jest.fn(() => false);
  return { actions, cancel, start };
}

test("saves sources and persisted config before submitting the build", async () => {
  const { actions, start } = createActions();
  let releaseConfigSave!: () => void;
  actions.build_command_save = new Promise<void>((resolve) => {
    releaseConfigSave = resolve;
  });

  const build = actions.build_document(undefined, true);
  await Promise.resolve();
  await Promise.resolve();
  expect(actions.save_all).toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();

  releaseConfigSave();
  await build;
  expect(start).toHaveBeenCalledWith({
    path: "/home/user/paper.tex",
    expected_source_hash: expect.any(Number),
    force: true,
    output_directory: "/tmp/output",
  });
  expect(actions.update_pdf).toHaveBeenCalledWith(120, true);
});

test("uses a stable generation only for build-on-save submissions", async () => {
  const { actions, start } = createActions();

  await actions.build_document(undefined, false, "save:chapter.tex:17");

  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ generation: "save:chapter.tex:17" }),
  );
});

test("queues a new saved generation while an older build is active", async () => {
  const { actions, start } = createActions();
  actions.is_building = true;

  await actions.build_document(undefined, false, "save:chapter.tex:18");

  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ generation: "save:chapter.tex:18" }),
  );
});

test("submits the logical Knitr source instead of its generated tex path", async () => {
  const { actions, start } = createActions();
  actions.knitr = true;
  actions.filename_knitr = "/home/user/paper.rnw";
  start.mockResolvedValue({
    ...terminalSnapshot(),
    identity: {
      kind: "knitr",
      logical_path: "/home/user/paper.rnw",
      working_path: "/home/user/paper.tex",
      resource_key: "/home/user/paper.tex",
    },
  });

  await actions.build_document();
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/home/user/paper.rnw" }),
  );
});

test("cancels the active project-side build id", async () => {
  const { actions, cancel } = createActions();
  actions.active_build_id = "build-1";

  await actions.stop_build();

  expect(cancel).toHaveBeenCalledWith("build-1");
  expect(actions.active_build_id).toBeUndefined();
  expect(actions.set_status).toHaveBeenLastCalledWith("");
});

describe("failed build toast", () => {
  function failedSnapshot(
    overrides: Partial<DocumentBuildSnapshot> = {},
  ): DocumentBuildSnapshot {
    return { ...terminalSnapshot("failed"), ...overrides };
  }

  const RUNAWAY = {
    level: "error" as const,
    message: "Runaway argument?",
  } as DocumentBuildSnapshot["diagnostics"][number];

  function createFailingActions(visibleErrorFrame: boolean) {
    const { actions } = createActions();
    actions.document_build_watcher = {
      latestActiveBuildSnapshot: () => undefined,
    };
    actions.toasted_build_ids = new Set();
    actions.hasVisibleErrorDisplayFrame = jest.fn(() => visibleErrorFrame);
    return actions;
  }

  it("does not toast a LaTeX diagnostic that the output panel shows", () => {
    const actions = createFailingActions(true);
    actions.apply_document_build_snapshot(
      failedSnapshot({ diagnostics: [RUNAWAY] }),
    );
    expect(actions.set_error).not.toHaveBeenCalled();
  });

  it("toasts the diagnostic when no error frame is visible", () => {
    const actions = createFailingActions(false);
    actions.apply_document_build_snapshot(
      failedSnapshot({ diagnostics: [RUNAWAY] }),
    );
    const [{ text }] = actions.set_error.mock.calls[0];
    expect(text).toBe("Building the document failed. Runaway argument?");
  });

  it("stays silent when check_for_fatal_error already reported this build", () => {
    const actions = createFailingActions(false);
    // what check_for_fatal_error does when it toasts
    actions.toasted_build_ids.add("build-1");
    actions.apply_document_build_snapshot(
      failedSnapshot({ diagnostics: [RUNAWAY] }),
    );
    expect(actions.set_error).not.toHaveBeenCalled();
  });

  it("always toasts a pipeline-level failure", () => {
    const actions = createFailingActions(true);
    actions.apply_document_build_snapshot(
      failedSnapshot({
        error: "document build service is unavailable",
        diagnostics: [RUNAWAY],
      }),
    );
    expect(actions.set_error).toHaveBeenCalledWith(
      "document build service is unavailable",
    );
  });
});
