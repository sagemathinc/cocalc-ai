import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import type { WorkspaceRecord } from "@cocalc/frontend/project/workspaces/types";

import {
  applyWorkspaceBulkSelection,
  getWorkspaceActivityState,
  workspaceSelectionTagChoices,
} from "./workspaces";

function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    workspace_id: "ws-1",
    project_id: "proj-1",
    root_path: "/repo",
    theme: {
      title: "Workspace",
      description: "",
      color: null,
      accent_color: null,
      icon: null,
      image_blob: null,
    },
    pinned: false,
    strong_theme: false,
    editor_theme: null,
    terminal_theme: null,
    last_used_at: null,
    last_active_path: null,
    chat_path: "/repo/.workspace.chat",
    notice_thread_id: null,
    notice: null,
    activity_viewed_at: null,
    activity_running_at: null,
    created_at: 1,
    updated_at: 1,
    source: "manual",
    ...overrides,
  };
}

function session(
  overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord {
  return {
    session_id: "sess-1",
    project_id: "proj-1",
    account_id: "acct-1",
    chat_path: "/repo/.workspace.chat",
    thread_key: "thread-1",
    title: "Codex",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:10.000Z",
    status: "idle",
    entrypoint: "file",
    ...overrides,
  };
}

describe("getWorkspaceActivityState", () => {
  it("shows running even before a session record lands when chat activity is live", () => {
    const state = getWorkspaceActivityState(workspace(), [], {
      currentRunning: true,
    });
    expect(state?.kind).toBe("running");
    expect(state?.label).toBe("Codex running");
  });

  it("treats an active chat with current chat activity as running", () => {
    const state = getWorkspaceActivityState(
      workspace(),
      [session({ status: "active" })],
      { currentRunning: true },
    );
    expect(state).toEqual({
      kind: "running",
      label: "Codex running",
      color: "processing",
      updatedAt: "2026-03-20T00:00:10.000Z",
    });
  });

  it("uses shared workspace running and viewed timestamps for ready-for-review", () => {
    const record = workspace({
      activity_running_at: Date.parse("2026-03-20T00:00:05.000Z"),
      activity_viewed_at: Date.parse("2026-03-20T00:00:01.000Z"),
    });
    const state = getWorkspaceActivityState(record, [
      session({ status: "active" }),
    ]);
    expect(state).toEqual({
      kind: "done",
      label: "Codex done",
      color: "success",
      updatedAt: "2026-03-20T00:00:10.000Z",
    });
  });

  it("clears ready-for-review after a synced view timestamp catches up", () => {
    const viewedAt = Date.parse("2026-03-20T00:00:10.000Z");
    const record = workspace({
      activity_running_at: Date.parse("2026-03-20T00:00:05.000Z"),
      activity_viewed_at: viewedAt,
    });
    expect(getWorkspaceActivityState(record, [session()])).toBeUndefined();
  });
});

describe("applyWorkspaceBulkSelection", () => {
  const workspaceIds = ["w1", "w2", "w3", "w4"];

  it("selects a contiguous range on shift-click", () => {
    expect(
      applyWorkspaceBulkSelection({
        workspaceIds,
        selectedIds: ["w2"],
        anchorId: "w2",
        clickedId: "w4",
        nextChecked: true,
        shiftKey: true,
      }),
    ).toEqual({
      selectedIds: ["w2", "w3", "w4"],
      anchorId: "w4",
    });
  });

  it("clears a contiguous range on shift-uncheck", () => {
    expect(
      applyWorkspaceBulkSelection({
        workspaceIds,
        selectedIds: ["w1", "w2", "w3", "w4"],
        anchorId: "w2",
        clickedId: "w4",
        nextChecked: false,
        shiftKey: true,
      }),
    ).toEqual({
      selectedIds: ["w1"],
      anchorId: "w4",
    });
  });

  it("falls back to single selection when no valid anchor exists", () => {
    expect(
      applyWorkspaceBulkSelection({
        workspaceIds,
        selectedIds: ["w1"],
        anchorId: null,
        clickedId: "w3",
        nextChecked: true,
        shiftKey: true,
      }),
    ).toEqual({
      selectedIds: ["w1", "w3"],
      anchorId: "w3",
    });
  });
});

describe("workspaceSelectionTagChoices", () => {
  it("only exposes the built-in top-level filters", () => {
    expect(workspaceSelectionTagChoices()).toEqual([
      {
        key: "all",
        label: "All tabs",
        selection: { kind: "all" },
      },
      {
        key: "unscoped",
        label: "Unscoped",
        selection: { kind: "unscoped" },
      },
    ]);
  });
});
