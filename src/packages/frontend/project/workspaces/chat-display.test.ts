/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";
import { generatedWorkspaceChatLabel } from "./chat-display";
import type { WorkspaceRecord } from "@cocalc/conat/workspaces";

describe("generatedWorkspaceChatLabel", () => {
  it("labels generated workspace chats with the workspace title", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
        {
          workspace_id: "ws-1",
          chat_path: "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
          theme: { title: "Repo" } as WorkspaceRecord["theme"],
        },
      ),
    ).toBe("Repo Chat");
  });

  it("does not relabel ordinary chat files inside the workspace root", () => {
    expect(
      generatedWorkspaceChatLabel("/home/user/project/repo/lite3.chat", {
        workspace_id: "ws-1",
        chat_path: "/home/user/project/repo/lite3.chat",
        theme: { title: "Repo" } as WorkspaceRecord["theme"],
      }),
    ).toBeUndefined();
  });

  it("still relabels generated chats for a home-directory workspace", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/workspaces/acct/ws-home.chat",
        {
          workspace_id: "ws-home",
          chat_path:
            "/home/user/.local/share/cocalc/workspaces/acct/ws-home.chat",
          theme: { title: "HOME" } as WorkspaceRecord["theme"],
        },
      ),
    ).toBe("HOME Chat");
  });

  it("labels the current account implicit navigator chat as the main chat", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/navigator-acct-1.chat",
        null,
        { currentAccountId: "acct-1" },
      ),
    ).toBe("Main Chat");
  });

  it("labels the unsuffixed implicit navigator chat as the main chat", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/navigator.chat",
        null,
        { currentAccountId: "acct-1" },
      ),
    ).toBe("Main Chat");
  });

  it("labels another user's implicit navigator chat by display name", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/navigator-acct-2.chat",
        null,
        {
          currentAccountId: "acct-1",
          userMap: fromJS({
            "acct-2": {
              first_name: "Ada",
              last_name: "Lovelace",
              display_name: "Ada L.",
            },
          }),
        },
      ),
    ).toBe("Ada L.'s Main Chat");
  });

  it("falls back to first and last name for another user's navigator chat", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/navigator-acct-2.chat",
        null,
        {
          currentAccountId: "acct-1",
          userMap: fromJS({
            "acct-2": {
              first_name: "Ada",
              last_name: "Lovelace",
            },
          }),
        },
      ),
    ).toBe("Ada Lovelace's Main Chat");
  });

  it("falls back to account id for another user's navigator chat", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/navigator-acct-2.chat",
        null,
        { currentAccountId: "acct-1" },
      ),
    ).toBe("acct-2's Main Chat");
  });

  it("does not relabel ordinary chat files near local cocalc metadata", () => {
    expect(
      generatedWorkspaceChatLabel(
        "/home/user/.local/share/cocalc/project-notes.chat",
        null,
        { currentAccountId: "acct-1" },
      ),
    ).toBeUndefined();
  });
});
