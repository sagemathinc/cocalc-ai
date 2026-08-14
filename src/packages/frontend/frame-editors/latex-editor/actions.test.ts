import { List, Map } from "immutable";
import * as CodeMirror from "codemirror";
import { Actions } from "./actions";
import { EventEmitter } from "events";

// Capture the callbacks the editor gives the coordinator, so the join path
// can be exercised without a real DKV.
let capturedCallbacks: any;
jest.mock("@cocalc/frontend/frame-editors/generic/build-coordinator", () => ({
  BuildCoordinator: class {
    constructor(_project_id: string, _path: string, callbacks: any) {
      capturedCallbacks = callbacks;
    }
    setLocalBuildId() {}
    publishBuildStart() {}
    publishBuildFinished() {}
    requestStop() {}
    reconcileRunningBuild() {}
    resetRuntimeState() {}
    ensureConnected() {}
    close() {}
  },
}));

describe("LaTeX persisted source change builds", () => {
  function createActions() {
    const build = jest.fn(async () => undefined);
    const parentBuild = jest.fn(async () => undefined);
    const actions: any = Object.create(Actions.prototype);
    actions.redux = {
      getStore: () =>
        Map({
          is_ready: true,
          editor_settings: Map({
            build_on_save: true,
          }),
        }),
      getEditorActions: jest.fn(() => ({
        auto_build: parentBuild,
      })),
    };
    actions._syncstring = {
      to_str: () => "\\documentclass{article}\\n\\begin{document}Hi\\n",
    };
    actions.not_ready = () => false;
    actions.parent_file = null;
    actions.path = "paper.tex";
    actions.project_id = "project-1";
    actions._last_syncstring_hash = undefined;
    actions.is_likely_master = () => true;
    actions.auto_build = build;
    return { actions, build, parentBuild };
  }

  it("builds once for a filesystem-originated persisted change", async () => {
    const { actions, build } = createActions();
    await (actions as any).maybeBuildAfterPersistedSourceChange();
    await (actions as any).maybeBuildAfterPersistedSourceChange();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith("");
  });

  it("builds the parent master file for included documents", async () => {
    const { actions, build, parentBuild } = createActions();
    actions.parent_file = "master.tex";
    await (actions as any).maybeBuildAfterPersistedSourceChange();
    expect(parentBuild).toHaveBeenCalledTimes(1);
    expect(parentBuild).toHaveBeenCalledWith("");
    expect(build).not.toHaveBeenCalled();
  });

  it("skips build-on-save while account settings are not loaded", async () => {
    const { actions, build } = createActions();
    actions.redux.getStore = () =>
      Map({
        // is_ready missing — settings may not reflect the user's preference
        editor_settings: Map({ build_on_save: true }),
      });
    await (actions as any).maybeBuildAfterPersistedSourceChange();
    expect(build).not.toHaveBeenCalled();
  });
});

describe("LaTeX included-file chat ownership", () => {
  it("yields standalone marker rendering to the parent editor", () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "chapter.tex";
    actions.parent_file = undefined;
    actions._chatMarkersOwnedByParent = false;
    actions._yieldChatMarkersToParent = jest.fn();

    actions.set_parent_file("master.tex");

    expect(actions.parent_file).toBe("master.tex");
    expect(actions._yieldChatMarkersToParent).toHaveBeenCalledTimes(1);
  });

  it("keeps marker ownership when the file is its own parent", () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "master.tex";
    actions._yieldChatMarkersToParent = jest.fn();

    actions.set_parent_file("master.tex");

    expect(actions._yieldChatMarkersToParent).not.toHaveBeenCalled();
  });
});

describe("LaTeX empty anchor reconciliation", () => {
  it("follows an edited marker using the frame-tree thread selection", () => {
    const setThreadAnchor = jest.fn(() => true);
    const renameThread = jest.fn();
    const frameTreeActions = {
      _get_frame_data: jest.fn((_frameId: string, key: string) =>
        key === "selectedThreadKey" ? "thread-1" : undefined,
      ),
    };
    const chatActions = {
      frameId: "chat-frame",
      frameTreeActions,
      store: Map(),
      listThreadConfigRows: () => [
        {
          thread_id: "thread-1",
          anchor: { id: "old-hash", path: "123.tex" },
        },
      ],
      getThreadIndex: () =>
        new globalThis.Map([["thread-1", { messageCount: 0 }]]),
      setThreadAnchor,
      renameThread,
    };
    const actions: any = Object.create(Actions.prototype);
    actions.path = "main.tex";
    actions._getChatActionsForMarkerReconciliation = () => chatActions;

    actions._reconcileEmptyAnchorThread(
      "123.tex",
      [{ hash: "old-hash", line: 0, col: 0 }],
      [{ hash: "new-hash", line: 0, col: 0 }],
    );

    expect(frameTreeActions._get_frame_data).toHaveBeenCalledWith(
      "chat-frame",
      "selectedThreadKey",
    );
    expect(setThreadAnchor).toHaveBeenCalledWith("thread-1", {
      id: "new-hash",
      path: "123.tex",
    });
    expect(renameThread).toHaveBeenCalledWith(
      "thread-1",
      "new-hash (123.tex:1)",
    );
  });
});

describe("LaTeX included-file table of contents", () => {
  function createDiskScanActions({
    readFile,
    rows = [],
  }: {
    readFile: jest.Mock;
    rows?: any[];
  }) {
    const main = "/home/user/project/main.tex";
    const subfile = "/home/user/project/123.tex";
    let state = Map({
      switch_to_files: List([main, subfile]),
    });
    const actions: any = Object.create(Actions.prototype);
    actions.path = main;
    actions.project_id = "project-1";
    actions.canonical_paths = {};
    actions._state = "open";
    actions._chatMarkerScanners = {};
    actions.store = {
      get: (key: string) => state.get(key),
    };
    actions.setState = jest.fn((update) => {
      state = state.merge(update);
    });
    actions.updateTableOfContents = jest.fn();
    actions.redux = {
      getEditorActions: jest.fn(() => undefined),
      getProjectActions: jest.fn(() => ({
        fs: () => ({ readFile }),
      })),
    };
    actions._getAnchoredThreadRows = () => rows;
    return {
      actions,
      main,
      subfile,
      getState: () => state,
      setState: (update: any) => {
        state = state.merge(update);
      },
    };
  }

  it("lists build-discovered subfiles even without headings or annotations", () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "/home/user/project/main.tex";
    actions.project_id = "project-1";
    actions.canonical_paths = {};
    actions.store = Map({
      switch_to_files: List([
        "/home/user/project/main.tex",
        "/home/user/project/123.tex",
        "/home/user/project/456.tex",
      ]),
    });
    actions.redux = {
      getEditorActions: jest.fn(() => undefined),
    };
    const entries: any[] = [{ id: "2", value: "After", level: 1 }];

    actions._appendSubfileTocEntries(
      entries,
      "\\include{123}\n\\section{After}",
    );

    expect(entries.map(({ value }) => value)).toEqual([
      "**123.tex**",
      "After",
      "**456.tex**",
    ]);
    expect(entries[0].extra).toEqual(
      expect.objectContaining({
        kind: "line",
        path: "/home/user/project/123.tex",
        line: 0,
      }),
    );
  });

  it("scans unopened source and suppresses stale thread-config anchors", async () => {
    const readFile = jest.fn(async () =>
      [
        "\\section{Disk section}",
        "% chat: live-one",
        "middle",
        "% chat: live-two",
      ].join("\n"),
    );
    const { actions, subfile, getState } = createDiskScanActions({
      readFile,
      rows: [
        {
          thread_id: "thread-live",
          anchor: {
            id: "live-one",
            path: "/home/user/project/123.tex",
          },
        },
        {
          thread_id: "thread-stale",
          anchor: {
            id: "deleted-marker",
            path: "/home/user/project/123.tex",
          },
        },
        {
          thread_id: "thread-archived",
          archived: true,
          anchor: {
            id: "archived-marker",
            path: "/home/user/project/123.tex",
          },
        },
      ],
    });

    await actions._scanDiskChatSubfiles();

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(getState().getIn(["chat_markers", subfile]).toJS()).toEqual([
      {
        hash: "live-one",
        line: 1,
        col: 0,
      },
      {
        hash: "live-two",
        line: 3,
        col: 0,
      },
    ]);
    const entries: any[] = [{ id: "2", value: "After", level: 1 }];

    actions._appendSubfileTocEntries(
      entries,
      "\\include{123}\n\\section{After}",
    );

    expect(entries.map(({ value }) => value)).toEqual([
      "**123.tex**",
      "Disk section",
      "Chat live-one (line 2)",
      "Chat live-two (line 4)",
      "After",
    ]);
    expect(entries[2].extra).toEqual(
      expect.objectContaining({
        kind: "chat",
        hash: "live-one",
        path: "/home/user/project/123.tex",
        line: 1,
      }),
    );
  });

  it("prefers live subfile headings over disk-scanned headings", async () => {
    const { actions, subfile } = createDiskScanActions({
      readFile: jest.fn(async () => "\\section{Disk section}"),
    });
    await actions._scanDiskChatSubfiles();
    actions.redux.getEditorActions.mockReturnValue({
      _syncstring: {
        to_str: () => "\\section{Live section}",
      },
    });

    const entries: any[] = [];
    actions._appendSubfileTocEntries(entries, "\\include{123}");

    expect(entries.map(({ value }) => value)).toEqual([
      "**123.tex**",
      "Live section",
    ]);
    expect(entries[1].extra).toEqual(
      expect.objectContaining({
        kind: "line",
        path: subfile,
        line: 0,
      }),
    );
  });

  it("drops a disk result when a live scanner attaches in flight", async () => {
    let finishRead!: (value: string) => void;
    const readFile = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    );
    const { actions, subfile, getState } = createDiskScanActions({ readFile });

    const scan = actions._scanDiskChatSubfiles();
    await Promise.resolve();
    actions._chatMarkerScanners[subfile] = {
      dispose: jest.fn(),
      rescan: jest.fn(),
    };
    finishRead("% chat: disk-result");
    await scan;

    expect(getState().get("chat_markers")).toBeUndefined();
    expect(actions._diskSubfileHeadings?.has(subfile) ?? false).toBe(false);
  });

  it("keeps a failed disk read header-only", async () => {
    const { actions } = createDiskScanActions({
      readFile: jest.fn(async () => {
        throw Error("missing");
      }),
      rows: [
        {
          thread_id: "thread-stale",
          anchor: {
            id: "stale",
            path: "/home/user/project/123.tex",
          },
        },
      ],
    });

    await actions._scanDiskChatSubfiles();
    const entries: any[] = [];
    actions._appendSubfileTocEntries(entries, "\\include{123}");

    expect(entries.map(({ value }) => value)).toEqual(["**123.tex**"]);
  });

  it("removes disk-derived state when a path leaves the candidates", async () => {
    const { actions, main, subfile, getState, setState } =
      createDiskScanActions({
        readFile: jest.fn(async () => "% chat: live-one"),
      });
    await actions._scanDiskChatSubfiles();
    expect(getState().hasIn(["chat_markers", subfile])).toBe(true);

    setState({ switch_to_files: List([main]) });
    await actions._scanDiskChatSubfiles();

    expect(getState().hasIn(["chat_markers", subfile])).toBe(false);
    expect(getState().hasIn(["chat_bookmarks", subfile])).toBe(false);
    expect(actions._diskSubfileHeadings.has(subfile)).toBe(false);
  });

  it("trusts a loaded subfile scan over remote thread metadata", () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "/home/user/project/main.tex";
    actions.project_id = "project-1";
    actions.canonical_paths = {};
    actions.store = Map({
      switch_to_files: List([
        "/home/user/project/main.tex",
        "/home/user/project/123.tex",
      ]),
      chat_markers: Map({
        "/home/user/project/123.tex": List(),
      }),
    });
    actions.redux = {
      getEditorActions: jest.fn(() => undefined),
    };
    actions._getAnchoredThreadRows = () => [
      {
        thread_id: "thread-1",
        anchor: {
          id: "removed-chat",
          path: "/home/user/project/123.tex",
        },
      },
    ];
    const entries: any[] = [];

    actions._appendSubfileTocEntries(entries, "\\include{123}");

    expect(entries.map(({ value }) => value)).toEqual(["**123.tex**"]);
  });
});

describe("LaTeX initial build", () => {
  it("saves explicit build command changes to the aux syncdb file", () => {
    const syncdb = {
      set: jest.fn(),
      commit: jest.fn(),
      save_to_disk: jest.fn(async () => undefined),
    };
    const actions: any = Object.create(Actions.prototype);
    actions._syncdb = syncdb;
    actions._state = "open";
    actions.isClosed = () => false;
    actions.is_read_only_preview = () => false;
    actions.path = "a.tex";
    actions.setState = jest.fn();
    actions.set_error = jest.fn();

    actions.set_build_command("pdflatex a.tex");

    expect(syncdb.set).toHaveBeenCalledWith({
      key: "build_command",
      value: "pdflatex a.tex",
    });
    expect(syncdb.commit).toHaveBeenCalled();
    expect(syncdb.save_to_disk).toHaveBeenCalled();
    expect(actions.setState).toHaveBeenCalledWith({
      build_command: "pdflatex a.tex",
    });
  });

  it("does not persist the fallback default build command", () => {
    const syncdb = {
      set: jest.fn(),
      commit: jest.fn(),
    };
    const actions: any = Object.create(Actions.prototype);
    actions._syncdb = syncdb;
    actions.path = "paper.tex";
    actions.knitr = false;
    actions.output_directory = "build-dir";
    actions.engine_config = undefined;
    actions.setState = jest.fn();

    const command = (actions as any).set_default_build_command();

    expect(command).toEqual([
      "latexmk",
      "-pdf",
      "-f",
      "-g",
      "-bibtex",
      "-deps",
      "-synctex=1",
      "-interaction=nonstopmode",
      "-output-directory=build-dir",
      "paper.tex",
    ]);
    expect(actions.setState).toHaveBeenCalledWith({
      build_command: List(command),
    });
    expect(syncdb.set).not.toHaveBeenCalled();
    expect(syncdb.commit).not.toHaveBeenCalled();
  });

  it("waits for the source syncstring before deciding whether to build on open", async () => {
    const syncstring = new EventEmitter() as any;
    let syncState = "loading";
    syncstring.is_fake = false;
    syncstring.get_state = () => syncState;
    syncstring.to_str = () =>
      syncState === "ready"
        ? "\\documentclass{article}\n\\begin{document}Hi\n\\end{document}\n"
        : "";

    const syncdb = new EventEmitter() as any;
    syncdb.is_fake = false;
    syncdb.get_state = () => "ready";
    syncdb.get_one = jest.fn(() => undefined);
    syncdb.on = jest.fn();

    const forceBuild = jest.fn(async () => undefined);
    const actions: any = Object.create(Actions.prototype);
    actions._state = "open";
    actions._syncstring = syncstring;
    actions._syncdb = syncdb;
    actions._init_syncdb = jest.fn();
    actions.isClosed = () => false;
    actions.is_read_only_preview = () => false;
    actions.setState = jest.fn();
    actions.set_default_build_command = jest.fn(() => ["latexmk"]);
    actions.force_build = forceBuild;
    actions.path = "paper.tex";
    actions.knitr = false;
    actions.redux = {
      getStore: () => ({
        get: (key: string) => (key === "is_ready" ? true : undefined),
        getIn: (keys: string[]) =>
          keys[0] === "editor_settings" && keys[1] === "build_on_save"
            ? true
            : undefined,
        waitUntilReady: async () => true,
      }),
    };
    // No PDF output yet — auto-build on open should proceed.
    actions.fs = () => ({ exists: async () => false });

    const promise = (actions as any).init_config();
    await Promise.resolve();
    expect(forceBuild).not.toHaveBeenCalled();

    syncState = "ready";
    syncstring.emit("ready");
    await promise;

    expect(forceBuild).toHaveBeenCalledTimes(1);
  });
});

describe("LaTeX chat marker resolution", () => {
  function createResolutionActions(chatActions: any) {
    const actions: any = Object.create(Actions.prototype);
    actions._state = "open";
    actions.path = "paper.tex";
    actions.project_id = "project-1";
    actions.getAnchorLabel = () => "anchor (paper.tex:4)";
    actions._waitForReadyChatActions = jest.fn(async () => chatActions);
    actions.store = {
      get: (key: string) =>
        key === "chat_markers"
          ? Map({
              "paper.tex": List([Map({ hash: "anchor-1", line: 3, col: 0 })]),
            })
          : undefined,
    };
    actions._removeChatMarkersForHash = jest.fn(async () => true);
    return actions;
  }

  it("resolves a hydrated thread before removing its marker", async () => {
    let liveKeys = ["thread-1"];
    let resolvedRows: any[] = [];
    const resolveAnchoredThread = jest.fn(() => {
      liveKeys = [];
      resolvedRows = [
        {
          thread_id: "thread-1",
          resolved: {
            account_id: "user-1",
            at: "now",
            anchorId: "anchor-1",
          },
        },
      ];
      return true;
    });
    const chatActions = {
      listAnchoredThreadKeys: jest.fn(() => liveKeys),
      listThreadConfigRows: jest.fn(() => resolvedRows),
      resolveAnchoredThread,
    };
    const actions = createResolutionActions(chatActions);

    await actions.resolveChatMarker("anchor-1", true);

    expect(resolveAnchoredThread).toHaveBeenCalledWith("thread-1", {
      label: "anchor (paper.tex:4)",
    });
    expect(actions._removeChatMarkersForHash).toHaveBeenCalledWith(
      "paper.tex",
      "anchor-1",
    );
    expect(
      actions._removeChatMarkersForHash.mock.invocationCallOrder[0],
    ).toBeLessThan(resolveAnchoredThread.mock.invocationCallOrder[0]);
  });

  it("allows removing a marker that has no chat thread", async () => {
    const chatActions = {
      listAnchoredThreadKeys: jest.fn(() => []),
      listThreadConfigRows: jest.fn(() => []),
      resolveAnchoredThread: jest.fn(),
    };
    const actions = createResolutionActions(chatActions);

    await actions.resolveChatMarker("anchor-1", false);

    expect(chatActions.resolveAnchoredThread).not.toHaveBeenCalled();
    expect(actions._removeChatMarkersForHash).toHaveBeenCalledWith(
      "paper.tex",
      "anchor-1",
    );
  });

  it("does not resolve the thread when its source marker cannot be removed", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const chatActions = {
      listAnchoredThreadKeys: jest.fn(() => ["thread-1"]),
      listThreadConfigRows: jest.fn(() => []),
      resolveAnchoredThread: jest.fn(),
    };
    const actions = createResolutionActions(chatActions);
    actions._removeChatMarkersForHash.mockResolvedValue(false);

    await actions.resolveChatMarker("anchor-1", true);

    expect(chatActions.resolveAnchoredThread).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("removes markers from unopened disk-scanned subfiles", async () => {
    const path = "/home/user/project/chapter.tex";
    let diskText = ["intro", "% chat: anchor-1", "outro"].join("\n");
    const readFile = jest.fn(async () => diskText);
    const writeFileDelta = jest.fn(async (_path, text) => {
      diskText = text;
    });
    let state = Map({
      chat_markers: Map({
        [path]: List([Map({ hash: "anchor-1", line: 1, col: 0 })]),
      }),
      chat_bookmarks: Map(),
    });
    const actions: any = Object.create(Actions.prototype);
    actions.path = "/home/user/project/main.tex";
    actions.project_id = "project-1";
    actions.redux = {
      getEditorActions: jest.fn(() => undefined),
    };
    actions._get_project_actions = () => ({
      fs: () => ({ readFile, writeFileDelta }),
    });
    actions.store = { get: (key: string) => state.get(key) };
    actions.setState = jest.fn((update) => {
      state = state.merge(update);
    });
    actions.updateTableOfContents = jest.fn();

    await expect(
      actions._removeChatMarkersForHash(path, "anchor-1"),
    ).resolves.toBe(true);

    expect(writeFileDelta).toHaveBeenCalledWith(
      path,
      ["intro", "outro"].join("\n"),
      {
        baseContents: ["intro", "% chat: anchor-1", "outro"].join("\n"),
        minLength: 0,
      },
    );
    expect(diskText).not.toContain("% chat: anchor-1");
    expect(state.getIn(["chat_markers", path]).size).toBe(0);
    expect(actions.updateTableOfContents).toHaveBeenCalledTimes(1);
  });

  it("preserves live CodeMirror edits that are ahead of the syncstring", async () => {
    const path = "paper.tex";
    let syncText = ["stale", "% chat: anchor-1"].join("\n");
    let liveText = ["pending local edit", "% chat: anchor-1"].join("\n");
    const cm = {
      getValue: jest.fn(() => liveText),
      getWrapperElement: jest.fn(() => ({ isConnected: true })),
      setValueNoJump: jest.fn((value: string) => {
        liveText = value;
      }),
    };
    const olderCm = {
      getValue: jest.fn(() => syncText),
      getWrapperElement: jest.fn(() => ({ isConnected: true })),
      setValueNoJump: jest.fn(),
    };
    const actions: any = Object.create(Actions.prototype);
    actions.path = path;
    actions._syncstring = {
      to_str: jest.fn(() => syncText),
    };
    actions._cm = { older: olderCm, "cm-1": cm };
    actions._get_cm = jest.fn(() => cm);
    actions._chatMarkerScanners = {};
    actions._clearChatTextDecorations = jest.fn();
    actions.set_value = jest.fn((value: string) => {
      syncText = value;
      liveText = value;
    });
    actions.syncstring_commit = jest.fn();

    await expect(
      actions._removeChatMarkersForHash(path, "anchor-1"),
    ).resolves.toBe(true);

    expect(actions.set_value).toHaveBeenCalledWith("pending local edit");
    expect(syncText).toBe("pending local edit");
    expect(liveText).toBe("pending local edit");
  });
});

describe("LaTeX anchor pane targeting", () => {
  it("switches the last focused subfile pane back to the master", async () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "main.tex";
    actions._get_most_recent_active_frame_id_of_type = jest.fn(() => "cm-1");
    actions._get_frame_node = jest.fn(() => Map({ path: "123.tex" }));
    actions.switch_to_file = jest.fn(async () => "cm-1");
    actions._waitForSourcePane = jest.fn();

    const frameId = await actions._switchFocusedSourceTo("main.tex");

    expect(frameId).toBe("cm-1");
    expect(actions.switch_to_file).toHaveBeenCalledWith("main.tex", "cm-1");
    expect(actions._waitForSourcePane).toHaveBeenCalledWith("main.tex", "cm-1");
  });

  it("reuses the focused pane when it already shows the target file", async () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "main.tex";
    actions._get_most_recent_active_frame_id_of_type = jest.fn(() => "cm-1");
    actions._get_frame_node = jest.fn(() => Map({ path: "main.tex" }));
    actions.switch_to_file = jest.fn();
    actions._waitForSourcePane = jest.fn();

    const frameId = await actions._switchFocusedSourceTo("main.tex");

    expect(frameId).toBe("cm-1");
    expect(actions.switch_to_file).not.toHaveBeenCalled();
    expect(actions._waitForSourcePane).toHaveBeenCalledWith("main.tex", "cm-1");
  });
});

describe("LaTeX TOC pane targeting", () => {
  it("switches a subfile pane to the master for a master bookmark", async () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "main.tex";
    actions._switchFocusedSourceTo = jest.fn(async () => "cm-1");
    actions._gotoSourceLine = jest.fn();

    await actions.scrollToHeading({
      id: "12-bookmark-review",
      value: "review",
      level: 6,
    });

    expect(actions._switchFocusedSourceTo).toHaveBeenCalledWith("main.tex");
    expect(actions._gotoSourceLine).toHaveBeenCalledWith(
      "main.tex",
      12,
      "cm-1",
    );
  });

  it("targets the same focused pane for a subfile bookmark", async () => {
    const actions: any = Object.create(Actions.prototype);
    actions.path = "main.tex";
    actions._switchFocusedSourceTo = jest.fn(async () => "cm-1");
    actions._gotoSourceLine = jest.fn();

    await actions.scrollToHeading({
      id: "sub:123.tex:5-bookmark-review",
      value: "review",
      level: 6,
      extra: { kind: "line", path: "123.tex", line: 4 },
    });

    expect(actions._switchFocusedSourceTo).toHaveBeenCalledWith("123.tex");
    expect(actions._gotoSourceLine).toHaveBeenCalledWith("123.tex", 5, "cm-1");
  });

  it("moves and focuses through the actions that own the target file", async () => {
    const targetActions = {
      programmatically_goto_line: jest.fn(async () => undefined),
    };
    const actions: any = Object.create(Actions.prototype);
    actions._actionsForChatPath = jest.fn(() => targetActions);
    actions.set_active_id = jest.fn();

    await actions._gotoSourceLine("123.tex", 5, "cm-1");

    expect(actions.set_active_id).toHaveBeenCalledWith("cm-1", true);
    expect(targetActions.programmatically_goto_line).toHaveBeenCalledWith(
      5,
      true,
      true,
      "cm-1",
    );
  });
});

describe("LaTeX invalid chat marker timing", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not inject a new invalid diagnostic while an id is being typed", () => {
    jest.useFakeTimers();
    let text = "";
    let state = Map();
    const syncstring = new EventEmitter() as EventEmitter & {
      get_state: () => string;
      to_str: () => string;
    };
    syncstring.get_state = () => "ready";
    syncstring.to_str = () => text;

    const actions: any = Object.create(Actions.prototype);
    actions._state = "open";
    actions.path = "123.tex";
    actions._syncstring = syncstring;
    actions.store = { get: (key: string) => state.get(key) };
    actions.setState = (updates: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(updates)) {
        state = state.set(key, value);
      }
    };
    actions._chatMarkerScanners = {};
    actions._reconcileEmptyAnchorThread = jest.fn();
    actions._updateChatGutters = jest.fn();
    actions._refreshChatMarkerText = jest.fn();
    actions._refreshCursorInsert = jest.fn();
    actions._ensureChatGutterUI = jest.fn();
    const invalidMarkers = () =>
      state.get("invalid_chat_markers")?.get("123.tex") ?? List();

    actions._attachChatMarkerScanner(actions, "123.tex");

    text = "% chat: su";
    syncstring.emit("change");
    jest.advanceTimersByTime(300);
    expect(invalidMarkers().size).toBe(0);

    jest.advanceTimersByTime(900);
    expect(invalidMarkers().toJS()).toEqual([{ text: "su", line: 0, col: 0 }]);

    text = "% chat: subfile-123";
    syncstring.emit("change");
    jest.advanceTimersByTime(300);
    expect(invalidMarkers().size).toBe(0);
    expect(state.getIn(["chat_markers", "123.tex"]).toJS()).toEqual([
      { hash: "subfile-123", line: 0, col: 0 },
    ]);

    actions._chatMarkerScanners["123.tex"].dispose();
  });

  it("scans the mounted CodeMirror buffer instead of a stale syncstring", () => {
    let state = Map();
    const syncstring = new EventEmitter() as EventEmitter & {
      get_state: () => string;
      to_str: () => string;
    };
    syncstring.get_state = () => "ready";
    syncstring.to_str = () => "% chat: stale-anchor";
    const cm = {
      getValue: () => "\n% chat: live-anchor",
      getWrapperElement: () => ({ isConnected: true }),
    };

    const actions: any = Object.create(Actions.prototype);
    actions._state = "open";
    actions.path = "123.tex";
    actions._syncstring = syncstring;
    actions._cm = { "cm-1": cm };
    actions.store = { get: (key: string) => state.get(key) };
    actions.setState = (updates: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(updates)) {
        state = state.set(key, value);
      }
    };
    actions._chatMarkerScanners = {};
    actions._reconcileEmptyAnchorThread = jest.fn();
    actions._updateChatGutters = jest.fn();
    actions._refreshChatMarkerText = jest.fn();
    actions._refreshCursorInsert = jest.fn();
    actions._ensureChatGutterUI = jest.fn();

    actions._attachChatMarkerScanner(actions, "123.tex");

    expect(state.getIn(["chat_markers", "123.tex"]).toJS()).toEqual([
      { hash: "live-anchor", line: 1, col: 0 },
    ]);
    actions._chatMarkerScanners["123.tex"].dispose();
  });
});

describe("LaTeX chat marker locking", () => {
  it("keeps the left boundary editable and protects the right boundary", () => {
    const textMarker = {};
    const cm = {
      markText: jest.fn(() => textMarker),
    };
    const actions: any = Object.create(Actions.prototype);

    const result = actions._createChatTextMarker({
      cm,
      hash: "20260727-abcdefgh",
      path: "123.tex",
      from: { line: 4, ch: 0 },
      to: { line: 4, ch: 29 },
      locked: true,
    });

    expect(result).toBe(textMarker);
    expect(cm.markText).toHaveBeenCalledWith(
      { line: 4, ch: 0 },
      { line: 4, ch: 29 },
      expect.objectContaining({
        readOnly: true,
        atomic: true,
        inclusiveLeft: false,
        inclusiveRight: true,
      }),
    );
  });

  it("allows insertion before a locked marker but rejects its right edge", () => {
    const doc = new (CodeMirror as any).Doc("x% chat: HASH");
    const cm = {
      markText: doc.markText.bind(doc),
    };
    const actions: any = Object.create(Actions.prototype);

    actions._createChatTextMarker({
      cm,
      hash: "HASH",
      path: "123.tex",
      from: { line: 0, ch: 1 },
      to: { line: 0, ch: 13 },
      locked: true,
    });

    doc.replaceRange("y", { line: 0, ch: 1 });
    expect(doc.getValue()).toBe("xy% chat: HASH");

    doc.replaceRange("z", { line: 0, ch: 14 });
    expect(doc.getValue()).toBe("xy% chat: HASH");
  });

  it("leaves both boundaries editable before the first message", () => {
    const cm = {
      markText: jest.fn(() => ({})),
    };
    const actions: any = Object.create(Actions.prototype);

    actions._createChatTextMarker({
      cm,
      hash: "draft-anchor",
      path: "123.tex",
      from: { line: 4, ch: 0 },
      to: { line: 4, ch: 20 },
      locked: false,
    });

    expect(cm.markText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        readOnly: false,
        atomic: false,
        inclusiveLeft: false,
        inclusiveRight: false,
      }),
    );
  });
});

describe("LaTeX chat tail tracking", () => {
  it("realigns after the complete CodeMirror operation", () => {
    let eventName: string | undefined;
    let onChanges:
      | ((editor: unknown, changes: Record<string, any>[]) => void)
      | undefined;
    const cm = {
      on: jest.fn((name, callback) => {
        eventName = name;
        onChanges = callback;
      }),
    };
    const actions: any = Object.create(Actions.prototype);
    actions._chatTailTrackingInstalled = new WeakSet();
    actions._syncChatTailPositions = jest.fn();

    actions._ensureChatTailTracking(cm, "123.tex");

    expect(eventName).toBe("changes");
    onChanges?.(cm, [
      {
        from: { line: 8, ch: 0 },
        to: { line: 8, ch: 0 },
        text: ["", "", ""],
      },
      {
        from: { line: 3, ch: 0 },
        to: { line: 4, ch: 0 },
        text: [""],
      },
    ]);
    expect(actions._syncChatTailPositions).toHaveBeenCalledWith(
      "123.tex",
      cm,
      3,
    );
  });

  it("reuses decorations when typing only moves unchanged markers", () => {
    const actions: any = Object.create(Actions.prototype);
    actions._anchorHasMessages = jest.fn(() => true);
    const existing = [
      {
        chatHash: "20260727-abcdefgh",
        chatPath: "123.tex",
        chatLocked: true,
        find: () => ({
          from: { line: 20, ch: 0 },
          to: { line: 20, ch: 29 },
        }),
      },
      {
        invalidChatMarker: true,
        invalidChatText: "bad id",
        find: () => ({
          from: { line: 24, ch: 0 },
          to: { line: 24, ch: 14 },
        }),
      },
    ];

    expect(
      actions._canReuseChatTextDecorations({
        existing,
        // Scanned line numbers changed after inserting text above, but the
        // live TextMarkers have already tracked those movements.
        markers: [{ hash: "20260727-abcdefgh", line: 20, col: 0 }],
        invalidMarkers: [{ text: "bad id", line: 24, col: 0 }],
        path: "123.tex",
      }),
    ).toBe(true);

    expect(
      actions._canReuseChatTextDecorations({
        existing,
        markers: [{ hash: "20260727-abcdefgh", line: 20, col: 0 }],
        invalidMarkers: [{ text: "different id", line: 24, col: 0 }],
        path: "123.tex",
      }),
    ).toBe(false);
  });

  it("sweeps obsolete hosts even when decorations are otherwise reusable", () => {
    const liveHost = { parentNode: { removeChild: jest.fn() } };
    const staleParent = { removeChild: jest.fn() };
    const staleHost = { parentNode: staleParent };
    const cm = {
      getWrapperElement: () => ({
        querySelectorAll: () => [liveHost, staleHost],
      }),
    };
    const actions: any = Object.create(Actions.prototype);

    actions._sweepStaleChatTailHosts(cm, [{ host: liveHost }]);

    expect(liveHost.parentNode.removeChild).not.toHaveBeenCalled();
    expect(staleParent.removeChild).toHaveBeenCalledWith(staleHost);
  });
});

describe("LaTeX chat gutter movement", () => {
  it("does not clear a line that already received a moved surviving icon", () => {
    const host1 = {};
    const host2 = {};
    const root1 = { render: jest.fn(), unmount: jest.fn() };
    const root2 = { render: jest.fn(), unmount: jest.fn() };
    const cm = { setGutterMarker: jest.fn() };
    const cache = {
      "123.tex": new globalThis.Map([
        [
          cm,
          [
            { host: host1, root: root1, line: 5 },
            { host: host2, root: root2, line: 10 },
          ],
        ],
      ]),
    };
    const actions: any = Object.create(Actions.prototype);

    actions._updateNativeGutterHosts({
      path: "123.tex",
      cms: [cm],
      targets: [{ line: 10 }, { line: 15 }],
      cache,
      protectedLines: new Set([10, 15]),
      render: jest.fn(),
    });

    expect(cm.setGutterMarker).toHaveBeenCalledWith(
      5,
      "CodeMirror-latex-chat",
      null,
    );
    expect(cm.setGutterMarker).not.toHaveBeenCalledWith(
      10,
      "CodeMirror-latex-chat",
      null,
    );
    expect(cm.setGutterMarker).toHaveBeenCalledWith(
      10,
      "CodeMirror-latex-chat",
      host1,
    );
    expect(cm.setGutterMarker).toHaveBeenCalledWith(
      15,
      "CodeMirror-latex-chat",
      host2,
    );
  });
});

describe("LaTeX marker insertion", () => {
  it("does not report success when CodeMirror rejects a read-only edit", () => {
    const ownerActions = {
      set_syncstring_to_codemirror: jest.fn(),
      syncstring_commit: jest.fn(),
    };
    const cm = {
      getValue: jest.fn(() => "% chat: locked-anchor"),
      getCursor: jest.fn(() => ({ line: 0, ch: 0 })),
      getLine: jest.fn(() => "% chat: locked-anchor"),
      replaceRange: jest.fn(),
    };
    const actions: any = Object.create(Actions.prototype);
    actions._activeSourceTarget = jest.fn(() => ({
      cm,
      actions: ownerActions,
      path: "123.tex",
      frameId: "cm-1",
    }));

    expect(
      actions._insertMarkerText("% chat: new-anchor", "  % chat: new-anchor"),
    ).toBeUndefined();
    expect(cm.replaceRange).toHaveBeenCalled();
    expect(ownerActions.set_syncstring_to_codemirror).not.toHaveBeenCalled();
    expect(ownerActions.syncstring_commit).not.toHaveBeenCalled();
  });
});

describe("LaTeX marker/tail pairing", () => {
  it("drops the paired inline tail when a TextMarker auto-clears", () => {
    const deadMarker = {
      find: jest.fn(() => undefined),
      clear: jest.fn(),
    };
    const liveMarker = {
      invalidChatMarker: true,
      find: jest.fn(() => ({
        from: { line: 2, ch: 0 },
        to: { line: 2, ch: 12 },
      })),
      clear: jest.fn(),
    };
    const deadTail = {
      bookmark: { clear: jest.fn() },
      root: { unmount: jest.fn() },
      host: {},
    };
    const liveTail = {
      bookmark: { clear: jest.fn() },
      root: { unmount: jest.fn() },
      host: {},
    };
    const cm = {};
    const markerMap = new globalThis.Map([[cm, [deadMarker, liveMarker]]]);
    const tailMap = new globalThis.Map([[cm, [deadTail, liveTail]]]);
    const actions: any = Object.create(Actions.prototype);
    actions._chatTextMarkers = { "123.tex": markerMap };
    actions._chatTailHosts = { "123.tex": tailMap };

    actions._refreshChatMarkerLocks();

    expect(markerMap.get(cm)).toEqual([liveMarker]);
    expect(tailMap.get(cm)).toEqual([liveTail]);
    expect(deadMarker.clear).toHaveBeenCalled();
    expect(deadTail.bookmark.clear).toHaveBeenCalled();
    expect(deadTail.root.unmount).toHaveBeenCalled();
    expect(liveTail.bookmark.clear).not.toHaveBeenCalled();
  });
});

describe("LaTeX build ownership", () => {
  function createBuildActions() {
    const actions: any = Object.create(Actions.prototype);
    actions.project_id = "project-1";
    actions.path = "paper.tex";
    actions._state = "open";
    actions.is_building = false;
    actions._pendingBuildRequest = false;
    actions._buildWasStopped = false;
    actions.store = {
      get: jest.fn((key: string) => {
        if (key === "error") return "";
        return undefined;
      }),
    };
    actions.setState = jest.fn();
    actions.set_error = jest.fn();
    actions.set_status = jest.fn();
    actions.save_all = jest.fn(async () => {});
    actions.last_save_time = jest.fn(() => 1);
    actions.buildCoordinator = {
      setLocalBuildId: jest.fn(),
      publishBuildStart: jest.fn(),
      publishBuildFinished: jest.fn(),
      requestStop: jest.fn(),
      reconcileRunningBuild: jest.fn(),
      ensureConnected: jest.fn(),
    };
    return actions;
  }

  it("a build stopped during save cannot publish over its replacement", async () => {
    const actions = createBuildActions();
    let resolveSaveA!: () => void;
    const saveA = new Promise<void>((resolve) => (resolveSaveA = resolve));
    actions.save_all = jest
      .fn()
      .mockImplementationOnce(() => saveA)
      .mockResolvedValue(undefined);
    let resolveB!: () => void;
    const runB = new Promise<void>((resolve) => (resolveB = resolve));
    actions.run_build = jest.fn(() => runB);

    const buildA = actions.buildInternal(undefined, false, false);
    await Promise.resolve();
    await actions.stop_build();
    const buildB = actions.buildInternal(undefined, false, false);
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.buildCoordinator.publishBuildStart).toHaveBeenCalledTimes(1);

    resolveSaveA();
    await buildA;
    expect(actions.buildCoordinator.publishBuildStart).toHaveBeenCalledTimes(1);
    expect(actions.is_building).toBe(true);

    resolveB();
    await buildB;
  });

  it("a stale rejected build cannot stop its replacement", async () => {
    const actions = createBuildActions();
    let rejectA!: (err: Error) => void;
    let resolveB!: () => void;
    const gateA = new Promise<void>((_resolve, reject) => (rejectA = reject));
    const gateB = new Promise<void>((resolve) => (resolveB = resolve));
    actions.run_build = jest
      .fn()
      .mockImplementationOnce(() => gateA)
      .mockImplementationOnce(() => gateB);
    const stopSpy = jest.spyOn(actions, "stop_build");

    const buildA = actions.buildInternal(undefined, false, false);
    await Promise.resolve();
    await Promise.resolve();
    await actions.stop_build();

    const buildB = actions.buildInternal(undefined, false, false);
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.is_building).toBe(true);

    rejectA(new Error("late failure from A"));
    await buildA;

    // Only the explicit stop of A occurred. A's stale catch did not stop B.
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(actions.is_building).toBe(true);
    expect(actions.set_error).not.toHaveBeenCalledWith(
      "Error: late failure from A",
    );

    resolveB();
    await buildB;
    expect(actions.is_building).toBe(false);
  });

  it("project restart resets coordination without killing stale jobs", async () => {
    const actions = createBuildActions();
    actions.is_building = true;
    actions._buildToken = "dead-build";
    actions.store.get = jest.fn((key: string) =>
      key === "build_logs"
        ? Map({
            latex: Map({ type: "async", status: "running", pid: 1234 }),
          })
        : undefined,
    );
    actions.buildCoordinator.resetRuntimeState = jest.fn();
    actions.kill = jest.fn();
    actions._init_pdf_directory_watcher = jest.fn(async () => {});
    actions.update_pdf = jest.fn();

    await actions._handle_project_started();

    expect(actions.buildCoordinator.resetRuntimeState).toHaveBeenCalledTimes(1);
    expect(actions.kill).not.toHaveBeenCalled();
    expect(actions.is_building).toBe(false);
    expect(actions.setState).toHaveBeenCalledWith({ building: false });
  });

  it("does not reset a fresh build twice after observing the stopped edge", async () => {
    const actions = createBuildActions();
    actions.is_building = true;
    actions._buildToken = "fresh-build";
    actions._projectStopObserved = true;
    actions.buildCoordinator.resetRuntimeState = jest.fn();
    actions._init_pdf_directory_watcher = jest.fn(async () => {});
    actions.update_pdf = jest.fn();

    await actions._handle_project_started();

    expect(actions.buildCoordinator.resetRuntimeState).not.toHaveBeenCalled();
    expect(actions.is_building).toBe(true);
    expect(actions._buildToken).toBe("fresh-build");
    expect(actions._projectStopObserved).toBe(false);
  });
});

describe("LaTeX save-triggered builds", () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  function createSaveActions(hash: () => number | undefined) {
    const actions: any = Object.create(Actions.prototype);
    actions.project_id = "project-1";
    actions.path = "paper.tex";
    actions._state = "open";
    actions.is_building = false;
    actions._pendingBuildRequest = false;
    actions._buildWasStopped = false;
    actions._syncstring = { hash_of_saved_version: hash };
    actions.store = {
      get: jest.fn((key: string) => (key === "error" ? "" : undefined)),
    };
    actions.setState = jest.fn();
    actions.set_error = jest.fn();
    actions.set_status = jest.fn();
    actions.save_all = jest.fn(async () => {});
    actions.last_save_time = jest.fn(() => 1);
    actions.run_build = jest.fn(async () => {});
    actions.buildCoordinator = {
      setLocalBuildId: jest.fn(),
      publishBuildStart: jest.fn(),
      publishBuildFinished: jest.fn(),
      requestStop: jest.fn(),
      reconcileRunningBuild: jest.fn(),
      ensureConnected: jest.fn(),
    };
    return actions;
  }

  it("Ctrl-S builds through the deduped path, not a fresh aggregate", async () => {
    // build() takes a fresh aggregate, which bypasses both the no-op check
    // and cross-client dedup — a save must not do that.
    const actions = createSaveActions(() => 1);
    actions.redux = { getStore: () => ({ getIn: () => true }) };
    actions.is_likely_master = () => true;
    actions.buildInternal = jest.fn(async () => {});

    await actions.explicit_save();

    expect(actions.buildInternal).toHaveBeenCalledTimes(1);
    expect(actions.buildInternal).toHaveBeenCalledWith(undefined, false, false);
  });

  it("does not rebuild for the save the build performed itself", async () => {
    // Regression: a build saves its sources, the syncstring emits
    // "save-to-disk", the handler calls auto_build mid-build and queues a
    // pending request — for the very revision being compiled.
    const actions = createSaveActions(() => 4242);
    let finishRun!: () => void;
    actions.run_build = jest.fn(
      () => new Promise<void>((resolve) => (finishRun = resolve)),
    );

    const build = actions.buildInternal(undefined, false, false);
    await Promise.resolve();
    await Promise.resolve();
    // the build's own save_all lands here
    await actions.buildInternal(undefined, false, false);
    expect(actions._pendingBuildRequest).toBe(true);

    finishRun();
    await build;
    await settle();

    expect(actions.run_build).toHaveBeenCalledTimes(1);
  });

  it("does rebuild when the source changed while the build ran", async () => {
    let hash = 1;
    const actions = createSaveActions(() => hash);
    let finishRun!: () => void;
    actions.run_build = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishRun = resolve)),
      )
      .mockResolvedValue(undefined);

    const build = actions.buildInternal(undefined, false, false);
    await Promise.resolve();
    await Promise.resolve();
    hash = 2; // the user typed and saved during the build
    await actions.buildInternal(undefined, false, false);

    finishRun();
    await build;
    await settle();

    expect(actions.run_build).toHaveBeenCalledTimes(2);
  });

  it("skips an auto build for an unchanged revision", async () => {
    const actions = createSaveActions(() => 7);
    await actions.buildInternal(undefined, false, false);
    expect(actions.run_build).toHaveBeenCalledTimes(1);
    await actions.buildInternal(undefined, false, false);
    expect(actions.run_build).toHaveBeenCalledTimes(1);
  });

  it("tracks sub-file content in the build revision", () => {
    let subHash = 10;
    const actions = createSaveActions(() => 1);
    actions.store.get = jest.fn((key: string) =>
      key === "switch_to_files" ? List(["paper.tex", "ch1.tex"]) : undefined,
    );
    actions.redux = {
      getEditorActions: (_project_id: string, path: string) =>
        path === "ch1.tex"
          ? { _syncstring: { hash_of_saved_version: () => subHash } }
          : undefined,
    };

    const before = actions.sourceRevision();
    subHash = 11; // master untouched, included file edited
    expect(actions.sourceRevision()).not.toBe(before);
  });

  it("recovers the build command when the project becomes reachable", async () => {
    // An editor opened while the project was stopped gave up resolving its
    // build command for good: it could then neither build nor join a
    // collaborator's build, with nothing reported anywhere.
    const actions = createSaveActions(() => 1);
    let buildCommand: string | undefined;
    actions.store.get = jest.fn((key: string) =>
      key === "build_command" ? buildCommand : undefined,
    );
    actions.configureBuildCommand = jest.fn(async () => {
      buildCommand = "latexmk -pdf paper.tex";
      return true;
    });

    await actions.ensureBuildConfig();
    expect(actions.configureBuildCommand).toHaveBeenCalledTimes(1);

    // Already configured: a later signal must not redo the work.
    await actions.ensureBuildConfig();
    expect(actions.configureBuildCommand).toHaveBeenCalledTimes(1);
  });

  it("defers a join it cannot run instead of reporting it as built", async () => {
    // A join that returns normally looks like a completed build to the
    // coordinator: it clears the spinner, records the originator's revision
    // as built, and never joins that build id again. A client that had no
    // build command yet would silently miss the build.
    const actions = createSaveActions(() => 1);
    actions.is_read_only_preview = () => false;
    actions.set_error = jest.fn();
    actions.waitForBuildCommand = jest.fn(async () => undefined);
    actions.run_build = jest.fn(async () => {});
    actions._init_build_coordinator();

    await capturedCallbacks.join("remote-build", 100, false, 99);

    expect(actions.run_build).not.toHaveBeenCalled();
    expect(actions._joinStartedRevision).toBeUndefined();
    expect(actions._deferredJoinBuildId).toBe("remote-build");
  });

  it("retries a deferred join once the build command arrives", async () => {
    const actions = createSaveActions(() => 1);
    actions._deferredJoinBuildId = "remote-build";
    actions.store.get = jest.fn(() => undefined); // no build command yet
    actions.configureBuildCommand = jest.fn(async () => true);

    await actions.ensureBuildConfig();

    expect(actions._deferredJoinBuildId).toBeUndefined();
    expect(
      actions.buildCoordinator.reconcileRunningBuild,
    ).toHaveBeenCalledTimes(1);
  });

  it("does not resolve the build command twice concurrently", async () => {
    const actions = createSaveActions(() => 1);
    actions.store.get = jest.fn(() => undefined); // never configured
    let release!: () => void;
    actions.configureBuildCommand = jest.fn(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    );

    const first = actions.ensureBuildConfig();
    await actions.ensureBuildConfig(); // second signal while the first runs
    expect(actions.configureBuildCommand).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it("never skips when no revision can be computed", async () => {
    const actions = createSaveActions(() => undefined);
    await actions.buildInternal(undefined, false, false);
    await actions.buildInternal(undefined, false, false);
    expect(actions.run_build).toHaveBeenCalledTimes(2);
  });
});
