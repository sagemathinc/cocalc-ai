/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { agentSessionMarkdownLinkBasePath } from "./agent-link-base";

describe("agentSessionMarkdownLinkBasePath", () => {
  it("uses live thread working directory metadata for markdown link resolution", () => {
    expect(
      agentSessionMarkdownLinkBasePath(
        {
          chat_path: "/home/user/.local/share/cocalc/workspaces/acct/ws.chat",
          working_directory: "/home/user/stale",
        },
        { acp_config: { workingDirectory: "/home/user/project" } },
      ),
    ).toBe("/home/user/project/.cocalc-agent-links");
  });

  it("falls back to the indexed agent session working directory", () => {
    expect(
      agentSessionMarkdownLinkBasePath({
        chat_path: "/home/user/.local/share/cocalc/navigator.chat",
        working_directory: "/home/user/repo",
      }),
    ).toBe("/home/user/repo/.cocalc-agent-links");
  });

  it("keeps the chat path when no working directory is known", () => {
    expect(
      agentSessionMarkdownLinkBasePath({
        chat_path: "/home/user/project/agent.chat",
      }),
    ).toBe("/home/user/project/agent.chat");
  });
});
