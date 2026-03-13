import {
  pathMatchesRoot,
  resolveWorkspaceForPath,
  selectionForPath,
  selectionMatchesPath,
} from "./state";
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
    created_at: 1,
    updated_at: 1,
    source: "manual",
  };
}

describe("project workspaces path matching", () => {
  it("matches only whole path prefixes", () => {
    expect(pathMatchesRoot("/a/b/c.txt", "/a/b")).toBe(true);
    expect(pathMatchesRoot("/a/b", "/a/b")).toBe(true);
    expect(pathMatchesRoot("/a/bad/file.txt", "/a/b")).toBe(false);
  });

  it("uses the longest matching workspace prefix", () => {
    const records = [
      record("/home/wstein/build", "1"),
      record("/home/wstein/build/cocalc-lite3", "2"),
    ];
    expect(
      resolveWorkspaceForPath(
        records,
        "/home/wstein/build/cocalc-lite3/src/index.ts",
      )?.workspace_id,
    ).toBe("2");
  });

  it("treats the canonical workspace chat as inside the workspace", () => {
    const records = [
      {
        ...record("/repo/a", "a"),
        chat_path: "/home/user/.local/share/cocalc/workspaces/me/a.chat",
      },
    ];
    expect(
      resolveWorkspaceForPath(
        records,
        "/home/user/.local/share/cocalc/workspaces/me/a.chat",
      )?.workspace_id,
    ).toBe("a");
  });

  it("supports all, unscoped, and specific workspace selections", () => {
    const records = [record("/repo/a", "a")];
    expect(
      selectionMatchesPath({ kind: "all" }, records, "/repo/a/file.ts"),
    ).toBe(true);
    expect(
      selectionMatchesPath(
        { kind: "workspace", workspace_id: "a" },
        records,
        "/repo/a/file.ts",
      ),
    ).toBe(true);
    expect(
      selectionMatchesPath(
        { kind: "workspace", workspace_id: "a" },
        records,
        "/repo/b/file.ts",
      ),
    ).toBe(false);
    expect(
      selectionMatchesPath({ kind: "unscoped" }, records, "/repo/b/file.ts"),
    ).toBe(true);
  });

  it("resolves selection for paths inside and outside workspaces", () => {
    const records = [record("/repo/a", "a")];
    expect(selectionForPath(records, "/repo/a/file.ts")).toEqual({
      kind: "workspace",
      workspace_id: "a",
    });
    expect(selectionForPath(records, "/repo/b/file.ts")).toEqual({
      kind: "unscoped",
    });
  });
});
