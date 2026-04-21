import { fromJS } from "immutable";

import {
  applyWorkspaceSelectionForForegroundOpen,
  canonicalPath,
  findOpenDisplayPathForSyncPath,
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

  it("does not treat permanent support failures as retryable", () => {
    expect(
      isTransientSyncIdentityResolutionError(
        new Error("canonicalSyncIdentityPath unavailable"),
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
