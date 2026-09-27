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

  it.each(["throws", "not-ok"])(
    "applies fresh actionable questions even when settled history %s",
    async (failure) => {
      const old = record("old-thread", "pending");
      const fresh = record("new-thread", "pending");
      let current = old;
      jest
        .mocked(webapp_client.conat_client.attentionAcp)
        .mockImplementation(async (request: any) => {
          if (request.state === "all") {
            if (failure === "throws") throw Error("history unavailable");
            return { ok: false, error: "history unavailable" };
          }
          return { ok: true, records: [current] };
        });
      const hook = renderHook(() =>
        useCodexAttentionSummary({
          active: true,
          account_id: "account-1",
          project_id: "project-1",
          path: "agent.chat",
        }),
      );
      await waitFor(() => expect(hook.result.current.records).toEqual([old]));
      current = fresh;
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => expect(hook.result.current.records).toEqual([fresh]));
      expect(hook.result.current.targetByThread.get("new-thread")).toBe(
        fresh.attention_id,
      );
      expect(hook.result.current.targetByThread.has("old-thread")).toBe(false);
      hook.unmount();
    },
  );

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

  it("keeps stale synchronous questions visible without counting them as pending", async () => {
    const stale = {
      ...record("thread-1", "stale"),
      source_kind: "codex_sync_question" as const,
    };
    jest.mocked(webapp_client.conat_client.attentionAcp).mockResolvedValue({
      ok: true,
      records: [stale, record("thread-2", "answered")],
    });
    const hook = renderHook(() =>
      useCodexAttentionSummary({
        active: true,
        account_id: "account-1",
        project_id: "project-1",
        path: "agent.chat",
      }),
    );
    await waitFor(() => expect(hook.result.current.records).toEqual([stale]));
    expect(hook.result.current.count).toBe(0);
    expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
      expect.objectContaining({ action: "list", state: "actionable" }),
    );
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
        { ...record("thread-3", "pending"), response_submitted_at: 2 },
      ]),
    ]).toEqual([
      ["thread-1", 2],
      ["thread-2", 1],
    ]);
  });

  it("retains submitted questions without badges or repeat notifications", async () => {
    const pending = record("thread-1", "pending");
    let current = pending;
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        records:
          request.state === "all" || current.state === "pending"
            ? [current]
            : [],
      }));
    const hook = renderHook(() =>
      useCodexAttentionSummary({
        active: true,
        account_id: "account-1",
        project_id: "project-1",
        path: "agent.chat",
      }),
    );
    await waitFor(() => expect(hook.result.current.count).toBe(1));
    current = { ...pending, response_submitted_at: 2, updated_at: 2 };
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(hook.result.current.count).toBe(0));
    expect(hook.result.current.records).toEqual([current]);
    expect(hook.result.current.targetByThread.size).toBe(0);
    expect(showCodexNotificationBestEffort).toHaveBeenLastCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({
          summary: expect.objectContaining({ attention_state: "resolved" }),
        }),
      }),
    );
    current = { ...current, state: "answered", updated_at: 3 };
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(hook.result.current.records).toEqual([current]));
    expect(hook.result.current.count).toBe(0);
    hook.unmount();
  });

  it("does not let submitted history displace open requests or another account's data", async () => {
    const pending = record("open", "pending");
    const submitted = {
      ...record("done", "answered"),
      response_submitted_at: 2,
    };
    let resolved = false;
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        records:
          request.state === "actionable"
            ? [
                pending,
                ...(resolved ? [] : [{ ...submitted, state: "pending" }]),
              ]
            : [
                submitted,
                {
                  ...submitted,
                  attention_id: "other-account",
                  account_id: "account-2",
                },
              ],
      }));
    const hook = renderHook(() =>
      useCodexAttentionSummary({
        active: true,
        account_id: "account-1",
        project_id: "project-1",
        path: "agent.chat",
      }),
    );
    await waitFor(() => expect(hook.result.current.records).toHaveLength(2));
    expect(webapp_client.conat_client.attentionAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "all" }),
    );
    resolved = true;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(hook.result.current.records).toEqual([submitted, pending]),
    );
    expect(hook.result.current.count).toBe(1);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledTimes(4),
    );
    expect(
      jest
        .mocked(webapp_client.conat_client.attentionAcp)
        .mock.calls.filter(([request]) => request.state === "all"),
    ).toHaveLength(1);
    hook.unmount();
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
