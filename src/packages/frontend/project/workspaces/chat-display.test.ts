/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generatedWorkspaceChatLabel } from "./chat-display";
import type { WorkspaceRecord } from "@cocalc/conat/workspaces";

describe("generatedWorkspaceChatLabel", () => {
  it("labels generated workspace chats with the workspace title", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
        {
          root_path: "/home/user/project/repo",
          chat_path: "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
          theme: { title: "Repo" } as WorkspaceRecord["theme"],
        },
      ),
    ).toBe("Repo Chat");
  });

  it("does not relabel ordinary chat files inside the workspace root", () => {
    expect(
      generatedWorkspaceChatLabel("/home/user/project/repo/lite3.chat", {
        root_path: "/home/user/project/repo",
        chat_path: "/home/user/project/repo/lite3.chat",
        theme: { title: "Repo" } as WorkspaceRecord["theme"],
      }),
    ).toBeUndefined();
  });
});
