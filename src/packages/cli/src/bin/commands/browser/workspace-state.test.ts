import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceRecord } from "@cocalc/conat/workspaces";
import { summarizeBrowserWorkspaceState } from "./workspace-state";

function workspace(overrides: Partial<WorkspaceRecord>): WorkspaceRecord {
  const now = 1;
  return {
    workspace_id: "ws-1",
    project_id: "proj-1",
    root_path: "/project/root",
    theme: {
      title: "Root",
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
    created_at: now,
    updated_at: now,
    source: "manual",
    ...overrides,
  };
}

test("summarizeBrowserWorkspaceState maps files into workspace and unscoped buckets", () => {
  const summary = summarizeBrowserWorkspaceState({
    records: [
      workspace({
        workspace_id: "ws-1",
        root_path: "/project/root",
        theme: { ...workspace({}).theme, title: "Root" },
      }),
      workspace({
        workspace_id: "ws-2",
        root_path: "/project/other",
        chat_path: "/project/.local/share/cocalc/workspaces/a/ws-2.chat",
        theme: { ...workspace({}).theme, title: "Other" },
      }),
    ],
    selection: { kind: "workspace", workspace_id: "ws-2" },
    openFiles: [
      { project_id: "proj-1", path: "/project/root/a.ts", title: "a.ts" },
      {
        project_id: "proj-1",
        path: "/project/.local/share/cocalc/workspaces/a/ws-2.chat",
        title: "ws-2.chat",
      },
      {
        project_id: "proj-1",
        path: "/project/random.txt",
        title: "random.txt",
      },
    ],
  });

  assert.equal(summary.selection_label, "Other");
  assert.equal(summary.open_file_count, 3);
  assert.equal(summary.visible_file_count, 1);
  assert.equal(summary.unscoped_open_file_count, 1);
  assert.equal(summary.selected_workspace?.workspace_id, "ws-2");
  assert.deepEqual(
    summary.open_files.map((row) => ({
      path: row.path,
      workspace_id: row.workspace_id,
      kind: row.kind,
      in_selected_scope: row.in_selected_scope,
    })),
    [
      {
        path: "/project/root/a.ts",
        workspace_id: "ws-1",
        kind: "workspace",
        in_selected_scope: false,
      },
      {
        path: "/project/.local/share/cocalc/workspaces/a/ws-2.chat",
        workspace_id: "ws-2",
        kind: "workspace",
        in_selected_scope: true,
      },
      {
        path: "/project/random.txt",
        workspace_id: null,
        kind: "unscoped",
        in_selected_scope: false,
      },
    ],
  );
});
