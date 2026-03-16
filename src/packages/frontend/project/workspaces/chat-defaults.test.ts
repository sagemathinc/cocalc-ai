/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { defaultWorkingDirectoryForChat } from "./chat-defaults";

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
});
