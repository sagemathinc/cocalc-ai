/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { renderHook, waitFor } from "@testing-library/react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { showCodexNotificationBestEffort } from "@cocalc/frontend/notifications/codex-turn-toast";
import {
  pendingAttentionByThread,
  useCodexAttentionSummary,
} from "../use-codex-attention";
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { attentionAcp: jest.fn() },
  },
}));

jest.mock("@cocalc/frontend/notifications/codex-turn-toast", () => ({
  showCodexNotificationBestEffort: jest.fn(async () => undefined),
}));

function record(
  thread_id: string,
  state: AcpAttentionRecord["state"],
): AcpAttentionRecord {
  return {
    attention_id: `${thread_id}-${state}`,
    project_id: "project-1",
    account_id: "account-1",
    path: "agent.chat",
    thread_id,
    source_kind: "codex_async_question",
    source_id: `${thread_id}-${state}`,
    attention_kind: "question",
    is_blocking: false,
    title: "Question",
    questions: [],
    state,
    created_at: 1,
    updated_at: 1,
  };
}

describe("Codex attention summaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("tracks native attention and clears it after resolution", async () => {
    const pending = record("thread-1", "pending");
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockResolvedValueOnce({ ok: true, records: [pending] })
      .mockResolvedValue({ ok: true, records: [] });
    const hook = renderHook(() =>
      useCodexAttentionSummary({
        active: true,
        account_id: "account-1",
        project_id: "project-1",
        path: "agent.chat",
      }),
    );
    await waitFor(() => expect(hook.result.current.count).toBe(1));
    expect(hook.result.current.targetByThread.get("thread-1")).toBe(
      pending.attention_id,
    );
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(hook.result.current.count).toBe(0));
    expect(showCodexNotificationBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({
          summary: expect.objectContaining({
            attention_id: pending.attention_id,
            attention_state: "resolved",
          }),
        }),
      }),
    );
    hook.unmount();
  });

  it("retains ordinary attention across transient service failures", async () => {
    const pending = record("thread-1", "pending");
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockResolvedValue({ ok: true, records: [pending] });
    const hook = renderHook(() =>
      useCodexAttentionSummary({
        active: true,
        account_id: "account-1",
        project_id: "project-1",
        path: "agent.chat",
      }),
    );
    await waitFor(() => expect(hook.result.current.records).toEqual([pending]));
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockRejectedValue(new Error("unavailable"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(hook.result.current.records).toEqual([pending]));
    hook.unmount();
  });

  it("drops the previous human's attention on account switch even when new reads fail", async () => {
    const pending = record("thread-1", "pending");
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockResolvedValueOnce({ ok: true, records: [pending] })
      .mockRejectedValue(new Error("unavailable"));
    const hook = renderHook(
      ({ account_id }) =>
        useCodexAttentionSummary({
          active: true,
          account_id,
          project_id: "project-1",
          path: "agent.chat",
        }),
      { initialProps: { account_id: "account-1" } },
    );
    await waitFor(() => expect(hook.result.current.records).toEqual([pending]));
    hook.rerender({ account_id: "account-2" });
    expect(hook.result.current.records).toEqual([]);
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalled(),
    );
    expect(hook.result.current.count).toBe(0);
    hook.unmount();
  });

  it("counts only pending attention per thread", () => {
    expect([
      ...pendingAttentionByThread([
        record("thread-1", "pending"),
        { ...record("thread-1", "pending"), attention_id: "second" },
        record("thread-1", "answered"),
        record("thread-2", "pending"),
      ]),
    ]).toEqual([
      ["thread-1", 2],
      ["thread-2", 1],
    ]);
  });

  it("delivers pending notifications and closes them after resolution", async () => {
    const pending = record("thread-1", "pending");
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockResolvedValueOnce({ ok: true, records: [pending] } as any)
      .mockResolvedValue({ ok: true, records: [] } as any);

    const hook = renderHook(() =>
      useCodexAttentionSummary({
        active: true,
        project_id: "project-1",
        path: "agent.chat",
      }),
    );
    await waitFor(() => expect(hook.result.current.records).toEqual([pending]));
    expect(showCodexNotificationBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({
          summary: expect.objectContaining({ attention_state: "pending" }),
        }),
      }),
    );

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(hook.result.current.records).toEqual([]));
    expect(showCodexNotificationBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({
          summary: expect.objectContaining({ attention_state: "resolved" }),
        }),
      }),
    );
    hook.unmount();
  });
});
