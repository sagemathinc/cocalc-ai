#!/usr/bin/env ts-node

import {
  applyQueuedUserMessageEditToRequest,
  getLatestQueuedUserMessageContent,
} from "../queued-user-message";

describe("queued user message refresh helpers", () => {
  it("extracts the newest saved message content from chat history", () => {
    expect(
      getLatestQueuedUserMessageContent([
        { content: "edited queued prompt" },
        { content: "original queued prompt" },
      ]),
    ).toBe("edited queued prompt");
  });

  it("ignores blank edited content when refreshing a queued request", () => {
    const request = {
      project_id: "proj-1",
      account_id: "acct-1",
      prompt: "original queued prompt",
      chat: {
        project_id: "proj-1",
        path: "thread.chat",
        thread_id: "thread-1",
        parent_message_id: "user-1",
        message_id: "assistant-1",
        message_date: "2026-05-07T21:00:00.000Z",
        sender_id: "openai-codex-agent",
      },
    };
    expect(
      applyQueuedUserMessageEditToRequest({
        request,
        latestContent: "   ",
      }),
    ).toBe(request);
  });

  it("preserves a hidden ACP prompt when the visible message was not edited", () => {
    const request = {
      project_id: "proj-1",
      account_id: "acct-1",
      prompt: "Detailed hidden onboarding instructions",
      chat: {
        project_id: "proj-1",
        path: "thread.chat",
        thread_id: "thread-1",
        parent_message_id: "user-1",
        message_id: "assistant-1",
        message_date: "2026-05-07T21:00:00.000Z",
        sender_id: "openai-codex-agent",
        user_message_content: "See number theory benchmarks.",
      },
    };
    expect(
      applyQueuedUserMessageEditToRequest({
        request,
        latestContent: "See number theory benchmarks.",
      }),
    ).toBe(request);
  });

  it("preserves recovery guidance behind an unchanged recovery notice", () => {
    const visibleNotice =
      "System recovery: the previous Codex turn stopped unexpectedly.";
    const request = {
      project_id: "proj-1",
      account_id: "acct-1",
      prompt:
        "Continue the interrupted task from its last durable state. Do not restart completed work.",
      chat: {
        project_id: "proj-1",
        path: "thread.chat",
        thread_id: "thread-1",
        parent_message_id: "recovery-1",
        message_id: "assistant-1",
        message_date: "2026-05-07T21:00:00.000Z",
        sender_id: "openai-codex-agent",
        user_message_content: visibleNotice,
      },
    };
    expect(
      applyQueuedUserMessageEditToRequest({
        request,
        latestContent: visibleNotice,
      }),
    ).toBe(request);
  });

  it("uses a real visible-message edit instead of the hidden ACP prompt", () => {
    const request = {
      project_id: "proj-1",
      account_id: "acct-1",
      prompt: "Detailed hidden onboarding instructions",
      chat: {
        project_id: "proj-1",
        path: "thread.chat",
        thread_id: "thread-1",
        parent_message_id: "user-1",
        message_id: "assistant-1",
        message_date: "2026-05-07T21:00:00.000Z",
        sender_id: "openai-codex-agent",
        user_message_content: "See number theory benchmarks.",
      },
    };
    expect(
      applyQueuedUserMessageEditToRequest({
        request,
        latestContent: "Benchmark primality tests instead.",
      }),
    ).toEqual({
      ...request,
      prompt: "Benchmark primality tests instead.",
      chat: {
        ...request.chat,
        user_message_content: "Benchmark primality tests instead.",
      },
    });
  });

  it("replaces the queued prompt and metadata with the newest saved edit", () => {
    const request = {
      project_id: "proj-1",
      account_id: "acct-1",
      prompt: "original queued prompt",
      chat: {
        project_id: "proj-1",
        path: "thread.chat",
        thread_id: "thread-1",
        parent_message_id: "user-1",
        message_id: "assistant-1",
        message_date: "2026-05-07T21:00:00.000Z",
        sender_id: "openai-codex-agent",
        user_message_content: "original queued prompt",
      },
    };
    expect(
      applyQueuedUserMessageEditToRequest({
        request,
        latestContent: "edited queued prompt",
      }),
    ).toEqual({
      ...request,
      prompt: "edited queued prompt",
      chat: {
        ...request.chat,
        user_message_content: "edited queued prompt",
      },
    });
  });
});
