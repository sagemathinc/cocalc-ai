/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  buildCodexTurnNoticeOptions,
  shouldNotifyOnCodexTurnFinish,
} from "../codex-turn-notice";

describe("codex turn completion notices", () => {
  it("only notifies when the thread config enables it", () => {
    expect(shouldNotifyOnCodexTurnFinish(undefined)).toBe(false);
    expect(shouldNotifyOnCodexTurnFinish({})).toBe(false);
    expect(shouldNotifyOnCodexTurnFinish({ notifyOnTurnFinish: true })).toBe(
      true,
    );
  });

  it("builds a success notice payload", () => {
    expect(
      buildCodexTurnNoticeOptions({
        account_id: "acct-1",
        source_project_id: "project-1",
        source_path: "work/chat.chat",
        source_fragment_id: "chat=123",
        thread_id: "thread-1",
        thread_label: "Fix tests",
        stable_source_id: "assistant-1",
        terminal_state: "complete",
      }),
    ).toEqual({
      account_id: "acct-1",
      source_project_id: "project-1",
      source_path: "work/chat.chat",
      source_fragment_id: "chat=123",
      thread_id: "thread-1",
      thread_label: "Fix tests",
      title: "Codex turn finished",
      body_markdown: "Codex finished working in **Fix tests**.",
      severity: "info",
      stable_source_id: "assistant-1",
    });
  });

  it("builds an error notice payload with trimmed details", () => {
    const result = buildCodexTurnNoticeOptions({
      account_id: "acct-1",
      source_project_id: "project-1",
      source_path: "work/chat.chat",
      thread_id: "thread-1",
      terminal_state: "error",
      error_text: "Something broke",
    });
    expect(result.title).toBe("Codex turn ended with an error");
    expect(result.severity).toBe("warning");
    expect(result.body_markdown).toContain("Codex finished with an error");
    expect(result.body_markdown).toContain("Something broke");
  });
});
