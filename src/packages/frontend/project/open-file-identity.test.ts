import { fromJS } from "immutable";

import {
  applyWorkspaceSelectionForForegroundOpen,
  canonicalPath,
  ensureProjectIsOpenWithRetry,
  findOpenDisplayPathForSyncPath,
  isTransientProjectOpenError,
  isTransientSyncIdentityResolutionError,
  log_file_open,
  log_opened_time,
  mark_open_phase,
  open_file,
  resolveSyncPath,
  resolveSyncPathWithRetry,
} from "./open-file";
import * as workspaceRecordsRuntime from "./workspaces/records-runtime";
import * as workspaceSelectionRuntime from "./workspaces/selection-runtime";
import { termPath } from "@cocalc/util/terminal/names";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeOpenFilesHarness() {
  const openFilesState = new Map<string, Record<string, any>>();
  const open_files = {
    has(path: string) {
      return openFilesState.has(path);
    },
    set(path: string, key: string, value: any) {
      const entry = openFilesState.get(path) ?? {};
      entry[key] = value;
      openFilesState.set(path, entry);
    },
    delete(path: string) {
      openFilesState.delete(path);
    },
  };
  const store = {
    get(key: string) {
      if (key === "open_files") {
        return {
          has: (path: string) => openFilesState.has(path),
          forEach: (cb: (value: any, key: string) => void) => {
            openFilesState.forEach((value, key) => cb(value, key));
          },
          getIn: (path: [string, string]) =>
            openFilesState.get(path[0])?.[path[1]],
        };
      }
      return undefined;
    },
    getIn(path: [string, string, string]) {
      if (path[0] !== "open_files") {
        return undefined;
      }
      return openFilesState.get(path[1])?.[path[2]];
    },
  };
  return { open_files, openFilesState, store };
}

describe("canonicalPath", () => {
  const HOME = "/home/wstein/work";

  it("keeps ipynb path unchanged", () => {
    expect(canonicalPath("/root/notebook.ipynb")).toBe("/root/notebook.ipynb");
  });

  it("maps non-hidden term files to numbered term identity", () => {
    expect(canonicalPath("/root/shell.term")).toBe(
      termPath({ path: "/root/shell.term", cmd: "", number: 0 }),
    );
  });

  it("keeps hidden term files unchanged", () => {
    expect(canonicalPath("/root/.shell.term")).toBe("/root/.shell.term");
  });

  it("normalizes relative paths to absolute using project home", () => {
    expect(canonicalPath("notes/todo.md", HOME)).toBe(
      "/home/wstein/work/notes/todo.md",
    );
  });
});

describe("findOpenDisplayPathForSyncPath", () => {
  function mkActions(openFilesObj) {
    return {
      get_store: () =>
        fromJS({
          open_files: openFilesObj,
        }),
    } as any;
  }

  it("finds an already-open alias tab by matching sync_path", () => {
    const actions = mkActions({
      "/root/link.txt": { sync_path: "/root/real.txt" },
      "/root/other.txt": { sync_path: "/root/other.txt" },
    });
    expect(findOpenDisplayPathForSyncPath(actions, "/root/real.txt")).toBe(
      "/root/link.txt",
    );
  });

  it("ignores the excluded display path", () => {
    const actions = mkActions({
      "/root/link.txt": { sync_path: "/root/real.txt" },
    });
    expect(
      findOpenDisplayPathForSyncPath(
        actions,
        "/root/real.txt",
        "/root/link.txt",
      ),
    ).toBeUndefined();
  });

  it("ignores tabs that do not have a sync_path", () => {
    const actions = mkActions({
      "/root/link.txt": { ext: "txt" },
      "/root/other.txt": { sync_path: "/root/other.txt" },
    });
    expect(
      findOpenDisplayPathForSyncPath(actions, "/root/real.txt"),
    ).toBeUndefined();
  });
});

describe("resolveSyncPath", () => {
  const HOME = "/root";

  it("uses canonicalSyncIdentityPath for sync identity resolution", async () => {
    const fs = {
      canonicalSyncIdentityPath: jest.fn().mockResolvedValue("/x/a.txt"),
    };
    await expect(resolveSyncPath(fs, "/x/a.txt", HOME)).resolves.toBe(
      "/x/a.txt",
    );
    expect(fs.canonicalSyncIdentityPath).toHaveBeenCalledWith("/x/a.txt");
  });

  it("fails closed when canonical sync identity support is unavailable", async () => {
    await expect(resolveSyncPath({}, "/root/link.txt", HOME)).rejects.toThrow(
      "canonicalSyncIdentityPath",
    );
  });

  it("fails closed when canonical sync identity resolution throws", async () => {
    const fs = {
      canonicalSyncIdentityPath: jest.fn().mockRejectedValue(new Error("boom")),
    };
    await expect(resolveSyncPath(fs, "/root/link.txt", HOME)).rejects.toThrow(
      "boom",
    );
  });
});

describe("isTransientSyncIdentityResolutionError", () => {
  it("treats file-server init failures as retryable", () => {
    expect(
      isTransientSyncIdentityResolutionError(
        new Error("file server not initialized"),
      ),
    ).toBe(true);
  });

  it("treats project-host routing failures as retryable", () => {
    expect(
      isTransientSyncIdentityResolutionError(
        new Error(
          "unable to route 'filesystem' to project-host for project project-1",
        ),
      ),
    ).toBe(true);
  });

  it("treats file-server readiness timeouts as retryable", () => {
    expect(
      isTransientSyncIdentityResolutionError(
        new Error('timeout of 30000ms waiting for "info"'),
      ),
    ).toBe(true);
  });

  it("treats closed filesystem client errors as retryable", () => {
    expect(isTransientSyncIdentityResolutionError(new Error("closed"))).toBe(
      true,
    );
    expect(
      isTransientSyncIdentityResolutionError(
        new Error('once: "info" not emitted before "closed"'),
      ),
    ).toBe(true);
  });

  it("does not treat permanent support failures as retryable", () => {
    expect(
      isTransientSyncIdentityResolutionError(
        new Error("canonicalSyncIdentityPath unavailable"),
      ),
    ).toBe(false);
  });

  it("does not misclassify unrelated errors that merely mention a closed filename", () => {
    expect(
      isTransientSyncIdentityResolutionError(
        new Error(
          "backend returned invalid canonical sync identity for '/root/closed.txt'",
        ),
      ),
    ).toBe(false);
  });
});

describe("resolveSyncPathWithRetry", () => {
  const HOME = "/root";

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("retries transient file-server initialization failures", async () => {
    const fs = {
      canonicalSyncIdentityPath: jest
        .fn()
        .mockRejectedValueOnce(new Error("file server not initialized"))
        .mockResolvedValue("/root/file.txt"),
    };
    await expect(
      resolveSyncPathWithRetry(fs, "/root/file.txt", HOME),
    ).resolves.toBe("/root/file.txt");
    expect(fs.canonicalSyncIdentityPath).toHaveBeenCalledTimes(2);
  });

  it("retries transient project-host routing failures", async () => {
    const fs = {
      canonicalSyncIdentityPath: jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "unable to route 'filesystem' to project-host for project project-1",
          ),
        )
        .mockResolvedValue("/root/file.txt"),
    };
    await expect(
      resolveSyncPathWithRetry(fs, "/root/file.txt", HOME),
    ).resolves.toBe("/root/file.txt");
    expect(fs.canonicalSyncIdentityPath).toHaveBeenCalledTimes(2);
  });

  it("retries transient closed-client failures until canonical identity resolution succeeds", async () => {
    const fs = {
      canonicalSyncIdentityPath: jest
        .fn()
        .mockRejectedValueOnce(new Error("closed"))
        .mockResolvedValue("/root/file.txt"),
    };
    await expect(
      resolveSyncPathWithRetry(fs, "/root/file.txt", HOME),
    ).resolves.toBe("/root/file.txt");
    expect(fs.canonicalSyncIdentityPath).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the open is cancelled", async () => {
    const fs = {
      canonicalSyncIdentityPath: jest
        .fn()
        .mockRejectedValue(new Error("file server not initialized")),
    };
    let open = true;
    const promise = resolveSyncPathWithRetry(fs, "/root/file.txt", HOME, {
      isOpen: () => open,
    });
    open = false;
    await expect(promise).rejects.toThrow("cancelled");
  });

  it("fails immediately on permanent canonical identity errors", async () => {
    const fs = {
      canonicalSyncIdentityPath: jest.fn().mockRejectedValue(new Error("boom")),
    };
    await expect(
      resolveSyncPathWithRetry(fs, "/root/file.txt", HOME),
    ).rejects.toThrow("boom");
    expect(fs.canonicalSyncIdentityPath).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientProjectOpenError", () => {
  it("treats project-open timeouts as retryable", () => {
    expect(isTransientProjectOpenError(new Error("timeout -- 30000 ms"))).toBe(
      true,
    );
    expect(
      isTransientProjectOpenError(
        new Error("project is not running. Please try again in a moment"),
      ),
    ).toBe(true);
    expect(
      isTransientProjectOpenError(
        new Error(
          "unable to route 'filesystem' to project-host for project p; project host id unavailable",
        ),
      ),
    ).toBe(true);
  });

  it("does not treat permanent project-open failures as retryable", () => {
    expect(isTransientProjectOpenError(new Error("permission denied"))).toBe(
      false,
    );
  });
});

describe("ensureProjectIsOpenWithRetry", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("retries transient project-open failures until the project opens", async () => {
    const actions = {
      ensureProjectIsOpen: jest
        .fn()
        .mockRejectedValueOnce(new Error("timeout -- 30000 ms"))
        .mockResolvedValue(undefined),
    };
    await expect(
      ensureProjectIsOpenWithRetry(actions, {
        foreground_project: true,
      }),
    ).resolves.toBeUndefined();
    expect(actions.ensureProjectIsOpen).toHaveBeenCalledTimes(2);
    expect(actions.ensureProjectIsOpen).toHaveBeenNthCalledWith(1, true);
  });

  it("stops retrying when the tab is closed", async () => {
    const actions = {
      ensureProjectIsOpen: jest
        .fn()
        .mockRejectedValue(new Error("project is not running")),
    };
    let open = true;
    const promise = ensureProjectIsOpenWithRetry(actions, {
      isOpen: () => open,
    });
    open = false;
    await expect(promise).rejects.toThrow("cancelled");
  });
});

describe("open-file logging updates", () => {
  const PROJECT_ID = "00000000-0000-4000-8000-000000000123";
  const PATH = "/root/open-log-test.txt";

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps filename/action in open update writes", () => {
    const log = jest.fn().mockReturnValue("open-log-entry-id");
    const mark_file = jest.fn();
    jest.spyOn(redux as any, "getProjectActions").mockReturnValue({ log });
    jest.spyOn(redux as any, "getActions").mockReturnValue({ mark_file });
    jest
      .spyOn(webapp_client.file_client as any, "is_deleted")
      .mockReturnValue(false);

    log_file_open(PROJECT_ID, PATH);
    mark_open_phase(PROJECT_ID, PATH, "optimistic_ready", { bytes: 12 });
    log_opened_time(PROJECT_ID, PATH);

    expect(log).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "open",
        action: "open",
        filename: PATH,
      }),
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "open",
        action: "open",
        filename: PATH,
        open_phase: "optimistic_ready",
      }),
      "open-log-entry-id",
    );
    expect(log).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event: "open",
        action: "open",
        filename: PATH,
        time: expect.any(Number),
      }),
      "open-log-entry-id",
    );
  });
});

describe("applyWorkspaceSelectionForForegroundOpen", () => {
  const PROJECT_ID = "project-1";
  const workspaceRecord = {
    workspace_id: "w1",
    project_id: PROJECT_ID,
    root_path: "/repo/workspace",
    theme: {
      title: "workspace",
      description: "",
      color: null,
      accent_color: null,
      icon: null,
      image_blob: null,
    },
    pinned: false,
    last_used_at: null,
    last_active_path: null,
    chat_path: null,
    notice_thread_id: null,
    notice: null,
    activity_viewed_at: null,
    activity_running_at: null,
    created_at: 1,
    updated_at: 1,
    source: "manual" as const,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("promotes unscoped foreground opens into workspaces to all tabs", () => {
    jest
      .spyOn(workspaceRecordsRuntime, "getRuntimeWorkspaceRecords")
      .mockReturnValue([workspaceRecord]);
    jest
      .spyOn(workspaceSelectionRuntime, "loadSessionSelection")
      .mockReturnValue({ kind: "unscoped" });
    const persist = jest.spyOn(
      workspaceSelectionRuntime,
      "persistSessionSelection",
    );
    const dispatch = jest.spyOn(
      workspaceSelectionRuntime,
      "dispatchWorkspaceSelectionEvent",
    );

    applyWorkspaceSelectionForForegroundOpen(
      PROJECT_ID,
      "/repo/workspace/file.ts",
    );

    expect(persist).toHaveBeenCalledWith(PROJECT_ID, { kind: "all" });
    expect(dispatch).toHaveBeenCalledWith(PROJECT_ID, { kind: "all" });
  });

  it("does nothing when the selection already matches", () => {
    jest
      .spyOn(workspaceRecordsRuntime, "getRuntimeWorkspaceRecords")
      .mockReturnValue([workspaceRecord]);
    jest
      .spyOn(workspaceSelectionRuntime, "loadSessionSelection")
      .mockReturnValue({ kind: "all" });
    const persist = jest.spyOn(
      workspaceSelectionRuntime,
      "persistSessionSelection",
    );
    const dispatch = jest.spyOn(
      workspaceSelectionRuntime,
      "dispatchWorkspaceSelectionEvent",
    );

    applyWorkspaceSelectionForForegroundOpen(
      PROJECT_ID,
      "/repo/workspace/file.ts",
    );

    expect(persist).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("respects an explicit workspace selection for foreground opens", () => {
    jest
      .spyOn(workspaceRecordsRuntime, "getRuntimeWorkspaceRecords")
      .mockReturnValue([workspaceRecord]);
    jest
      .spyOn(workspaceSelectionRuntime, "loadSessionSelection")
      .mockReturnValue({ kind: "unscoped" });
    const persist = jest.spyOn(
      workspaceSelectionRuntime,
      "persistSessionSelection",
    );
    const dispatch = jest.spyOn(
      workspaceSelectionRuntime,
      "dispatchWorkspaceSelectionEvent",
    );

    applyWorkspaceSelectionForForegroundOpen(
      PROJECT_ID,
      "/repo/workspace/file.ts",
      { kind: "workspace", workspace_id: "w1" },
    );

    expect(persist).toHaveBeenCalledWith(PROJECT_ID, {
      kind: "workspace",
      workspace_id: "w1",
    });
    expect(dispatch).toHaveBeenCalledWith(PROJECT_ID, {
      kind: "workspace",
      workspace_id: "w1",
    });
  });
});

describe("open_file workspaceSelection passthrough", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts explicit workspaceSelection opts without defaults errors", async () => {
    const workspaceRecord = {
      workspace_id: "w1",
      project_id: "project-1",
      root_path: "/repo/workspace",
      theme: {
        title: "workspace",
        description: "",
        color: null,
        accent_color: null,
        icon: null,
        image_blob: null,
      },
      pinned: false,
      last_used_at: null,
      last_active_path: null,
      chat_path: null,
      notice_thread_id: null,
      notice: null,
      activity_viewed_at: null,
      activity_running_at: null,
      created_at: 1,
      updated_at: 1,
      source: "manual" as const,
    };
    const openProject = jest.fn();
    jest.spyOn(redux as any, "getActions").mockReturnValue({
      open_project: openProject,
    });
    jest.spyOn(redux as any, "getStore").mockReturnValue({
      get: jest.fn().mockReturnValue(false),
    });
    jest
      .spyOn(workspaceRecordsRuntime, "getRuntimeWorkspaceRecords")
      .mockReturnValue([workspaceRecord]);
    jest
      .spyOn(workspaceSelectionRuntime, "loadSessionSelection")
      .mockReturnValue({ kind: "unscoped" });
    const persist = jest.spyOn(
      workspaceSelectionRuntime,
      "persistSessionSelection",
    );
    const actions = {
      project_id: "project-1",
      open_in_new_browser_window: jest.fn(),
    } as any;

    await expect(
      open_file(actions, {
        path: "/repo/workspace/file.ts",
        foreground: true,
        foreground_project: false,
        new_browser_window: true,
        ignore_kiosk: true,
        workspaceSelection: {
          kind: "workspace",
          workspace_id: "w1",
        },
      }),
    ).resolves.toBeUndefined();

    expect(persist).toHaveBeenCalledWith("project-1", {
      kind: "workspace",
      workspace_id: "w1",
    });
  });
});

describe("open_file wait_for_ready", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns immediately for background opens and continues readiness work in the background", async () => {
    const path = "/home/user/background.txt";
    const syncIdentity = deferred<string>();
    const ensureProjectIsOpen = jest.fn().mockResolvedValue(undefined);
    const openProject = jest.fn();
    const saveSession = jest.fn();
    const { open_files, openFilesState, store } = makeOpenFilesHarness();

    jest.spyOn(redux as any, "getStore").mockImplementation((name: string) => {
      if (name === "page") {
        return { get: jest.fn().mockReturnValue(false) };
      }
      return undefined;
    });
    jest
      .spyOn(redux as any, "getActions")
      .mockImplementation((name: string) => {
        if (name === "projects") {
          return { open_project: openProject };
        }
        if (name === "page") {
          return { save_session: saveSession };
        }
        return {};
      });

    const actions = {
      project_id: "project-1",
      get_store: () => store,
      open_files,
      fs: () => ({
        canonicalSyncIdentityPath: jest
          .fn()
          .mockReturnValue(syncIdentity.promise),
      }),
      ensureProjectIsOpen,
      open_in_new_browser_window: jest.fn(),
      foreground_project: jest.fn(),
      set_active_tab: jest.fn(),
      initFileRedux: jest.fn(),
      gotoFragment: jest.fn(),
      open_chat: jest.fn(),
      set_activity: jest.fn(),
    } as any;

    const openPromise = open_file(actions, {
      path,
      foreground: false,
      foreground_project: false,
      wait_for_ready: false,
      change_history: false,
    });
    let resolved = false;
    void openPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(true);

    expect(openFilesState.get(path)?.component).toEqual({});
    expect(ensureProjectIsOpen).not.toHaveBeenCalled();

    syncIdentity.resolve(path);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ensureProjectIsOpen).toHaveBeenCalledWith(false);
    expect(openFilesState.get(path)?.sync_path).toBe(path);
    expect(openFilesState.get(path)?.ext).toBe("txt");
    expect(saveSession).toHaveBeenCalled();
  });
});
