/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isCodexAgentMessageAuthor } from "../message-author";

describe("isCodexAgentMessageAuthor", () => {
  it("recognizes a Codex-authored message in a Codex thread", () => {
    expect(
      isCodexAgentMessageAuthor({
        threadModel: "gpt-daybreak-blue-latest",
        senderId: "gpt-daybreak-blue-latest",
        historyAuthorId: "gpt-daybreak-blue-latest",
      }),
    ).toBe(true);
  });

  it("recognizes explicit ACP assistant metadata", () => {
    expect(
      isCodexAgentMessageAuthor({
        threadModel: "gpt-daybreak-blue-latest",
        senderId: "legacy-agent-id",
        hasAcpAssistantMetadata: true,
      }),
    ).toBe(true);
  });

  it("does not treat another human collaborator as Codex", () => {
    expect(
      isCodexAgentMessageAuthor({
        threadModel: "gpt-daybreak-blue-latest",
        senderId: "00000000-0000-4000-8000-000000000002",
        historyAuthorId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toBe(false);
  });

  it("does not relabel assistants in non-Codex threads", () => {
    expect(
      isCodexAgentMessageAuthor({
        threadModel: false,
        senderId: "openai-codex-agent",
        historyAuthorId: "openai-codex-agent",
      }),
    ).toBe(false);
  });
});
