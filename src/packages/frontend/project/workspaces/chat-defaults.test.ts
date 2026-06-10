/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  defaultWorkingDirectoryForChat,
  workingDirectoryForProjectFile,
} from "./chat-working-directory";
import type { WorkspaceRecord } from "./types";

function workspaceRecord(
  root_path: string,
  workspace_id: string,
  chat_path: string,
): WorkspaceRecord {
  return {
    workspace_id,
    project_id: "project-1",
    root_path,
    theme: {
      title: "Workspace",
      description: "",
      color: null,
      accent_color: null,
      icon: null,
      image_blob: null,
    },
    pinned: false,
    last_used_at: null,
    last_active_path: null,
    chat_path,
    notice_thread_id: null,
    notice: null,
    activity_viewed_at: null,
    activity_running_at: null,
    created_at: 1,
    updated_at: 1,
    source: "manual",
  };
}

describe("defaultWorkingDirectoryForChat", () => {
  it("uses the workspace root when provided", () => {
    expect(
      defaultWorkingDirectoryForChat(
        "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
        "/home/user/project/repo",
      ),
    ).toBe("/home/user/project/repo");
  });

  it("falls back to the chat directory when no workspace root is known", () => {
    expect(
      defaultWorkingDirectoryForChat("/home/user/project/lite3.chat"),
    ).toBe("/home/user/project");
  });

  it("uses project home for generated project-home chats", () => {
    expect(
      defaultWorkingDirectoryForChat(
        "/home/user/.local/share/cocalc/navigator.chat",
        undefined,
        "/home/user",
      ),
    ).toBe("/home/user");
  });

  it("uses the workspace root for generated workspace chats during tab activation", () => {
    const chatPath = "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat";
    expect(
      workingDirectoryForProjectFile(chatPath, {
        projectHomeDirectory: "/home/user",
        workspaceRecords: [
          workspaceRecord("/home/user/project/repo", "ws-1", chatPath),
        ],
      }),
    ).toBe("/home/user/project/repo");
  });
});
