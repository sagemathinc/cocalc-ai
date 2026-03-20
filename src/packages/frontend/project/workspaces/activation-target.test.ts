import { getWorkspaceActivationTarget } from "./activation-target";
import type { WorkspaceRecord } from "./types";

function record(root_path: string, workspace_id: string): WorkspaceRecord {
  return {
    workspace_id,
    project_id: "p",
    root_path,
    theme: {
      title: root_path,
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
    source: "manual",
  };
}

describe("workspace activation target", () => {
  const workspaceA = record("/repo/a", "a");
  const workspaceB = record("/repo/b", "b");
  const records = [workspaceA, workspaceB];
  const resolveWorkspaceForPath = (path: string) =>
    records.find(
      (record) =>
        path === record.root_path || path.startsWith(`${record.root_path}/`),
    ) ?? null;

  it("prefers the currently active open file when it already belongs to the workspace", () => {
    expect(
      getWorkspaceActivationTarget({
        record: workspaceA,
        activePath: "/repo/a/current.ts",
        openFilesOrder: ["/repo/a/current.ts", "/repo/b/other.ts"],
        resolveWorkspaceForPath,
      }),
    ).toEqual({ kind: "file", path: "/repo/a/current.ts" });
  });

  it("falls back to the workspace last active open file", () => {
    expect(
      getWorkspaceActivationTarget({
        record: { ...workspaceA, last_active_path: "/repo/a/last.ts" },
        activePath: "/repo/b/other.ts",
        openFilesOrder: ["/repo/b/other.ts", "/repo/a/last.ts"],
        resolveWorkspaceForPath,
      }),
    ).toEqual({ kind: "file", path: "/repo/a/last.ts" });
  });

  it("uses the first open file in the workspace when no more specific match exists", () => {
    expect(
      getWorkspaceActivationTarget({
        record: workspaceA,
        activePath: "/repo/b/other.ts",
        openFilesOrder: [
          "/repo/b/other.ts",
          "/repo/a/one.ts",
          "/repo/a/two.ts",
        ],
        resolveWorkspaceForPath,
      }),
    ).toEqual({ kind: "file", path: "/repo/a/one.ts" });
  });

  it("falls back to the workspace root when no open files belong to the workspace", () => {
    expect(
      getWorkspaceActivationTarget({
        record: workspaceA,
        activePath: "/repo/b/other.ts",
        openFilesOrder: ["/repo/b/other.ts"],
        resolveWorkspaceForPath,
      }),
    ).toEqual({ kind: "directory", path: "/repo/a" });
  });
});
