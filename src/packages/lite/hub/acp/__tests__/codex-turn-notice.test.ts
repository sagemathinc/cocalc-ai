/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/conat/hub/call-hub", () => jest.fn());

import {
  buildCodexTurnNoticeOptions,
  codexTurnNotifyPreference,
  publishCodexTurnNotice,
  shouldNotifyOnCodexTurnFinish,
} from "../codex-turn-notice";
import callHub from "@cocalc/conat/hub/call-hub";

describe("codex turn completion notices", () => {
  it("only notifies when the thread config enables it", () => {
    expect(shouldNotifyOnCodexTurnFinish(undefined)).toBe(false);
    expect(shouldNotifyOnCodexTurnFinish({})).toBe(false);
    expect(shouldNotifyOnCodexTurnFinish({ notifyOnTurnFinish: true })).toBe(
      true,
    );
    expect(codexTurnNotifyPreference({ notifyOnTurnFinish: false })).toBe(
      false,
    );
    expect(codexTurnNotifyPreference({})).toBeUndefined();
    expect(
      codexTurnNotifyPreference({
        get: (key: string) => (key === "notifyOnTurnFinish" ? true : undefined),
      } as any),
    ).toBe(true);
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
        agent_label: "Claude",
      }),
    ).toEqual({
      account_id: "acct-1",
      source_project_id: "project-1",
      source_path: "work/chat.chat",
      source_fragment_id: "chat=123",
      thread_id: "thread-1",
      thread_label: "Fix tests",
      title: "Claude turn finished",
      body_markdown: "Claude finished working in **Fix tests**.",
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
    expect(result.title).toBe("Agent turn ended with an error");
    expect(result.severity).toBe("warning");
    expect(result.body_markdown).toContain("Agent finished with an error");
    expect(result.body_markdown).toContain("Something broke");
  });

  it("publishes notices through the current project-authenticated client", async () => {
    const client = {} as any;
    (callHub as jest.Mock).mockResolvedValueOnce(undefined);

    await expect(
      publishCodexTurnNotice({
        client,
        project_id: "project-1",
        notice: {
          account_id: "acct-1",
          source_project_id: "project-1",
          source_path: "work/chat.chat",
          thread_id: "thread-1",
          title: "Codex turn finished",
          body_markdown: "done",
        },
      }),
    ).resolves.toBeUndefined();

    expect(callHub).toHaveBeenCalledWith({
      client,
      project_id: "project-1",
      name: "notifications.createCodexTurnNotice",
      args: [
        expect.objectContaining({
          account_id: "acct-1",
          source_project_id: "project-1",
          source_path: "work/chat.chat",
          thread_id: "thread-1",
        }),
      ],
      timeout: 20_000,
    });
  });
});
