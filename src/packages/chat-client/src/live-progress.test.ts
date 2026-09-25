/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import {
  buildLiveProgress,
  isProgressQuestion,
  LiveProgressContext,
} from "./live-progress";
import type { ChatSnapshot, ProjectedChatMessage } from "./types";

const agent: ProjectedChatMessage = {
  message_id: "agent-1",
  thread_id: "thread-1",
  sender_id: "__codex__",
  role: "agent",
  content: "",
  date: "2026-09-25T00:00:00.000Z",
  generating: true,
  state: "running",
  activity: {
    state: "ready",
    source: "live-preview",
    events: [
      {
        seq: 1,
        type: "event",
        event: { type: "message", text: "I found the issue.", delta: false },
      },
      {
        seq: 2,
        type: "event",
        event: {
          type: "terminal",
          phase: "data",
          terminalId: "secret",
          chunk: "private command output",
        },
      },
      {
        seq: 3,
        type: "event",
        event: {
          type: "message",
          text: "I found the issue.\n\nI am checking tests.",
          delta: false,
        },
      },
    ],
  },
};

function snapshot(message: ProjectedChatMessage = agent): ChatSnapshot {
  return {
    revision: 1,
    connection: "connected",
    ready: true,
    project_id: "project-1",
    path: "/home/user/agent.chat",
    selected_thread_id: "thread-1",
    threads: [
      {
        thread_id: "thread-1",
        state: "running",
        active_message_id: message.message_id,
      },
    ],
    messages: [message],
  };
}

it("reports recent compact agent text without duplicating cumulative snapshots or exposing tools", () => {
  const progress = buildLiveProgress(snapshot(), "thread-1");
  expect(progress.text).toContain("I found the issue");
  expect(progress.text).toContain("I am checking tests");
  expect(progress.text.match(/I found the issue/g)).toHaveLength(1);
  expect(progress.text).not.toMatch(/terminal|private command output/);
  expect(progress.canGuide).toBe(true);
});

it("reports a running turn conservatively when no agent preview is available", () => {
  expect(
    buildLiveProgress(snapshot({ ...agent, activity: undefined }), "thread-1")
      .text,
  ).toContain("No recent agent message is available yet");
});

it("does not use a recovered full activity log as voice progress", () => {
  const recovered = {
    ...agent,
    activity: { ...agent.activity!, source: "recovered" as const },
  };
  const progress = buildLiveProgress(snapshot(recovered), "thread-1");
  expect(progress.text).toContain("No recent agent message is available yet");
  expect(progress.text).not.toContain("I found the issue");
});

it("reads only agent text from a legacy phone preview, never later activity sections", () => {
  const legacy = {
    ...agent,
    activity: {
      state: "ready" as const,
      events: [],
      markdown:
        "**Codex activity**\n\nI found the issue.\n\nI am checking tests.\n\n---\n\n**Terminal**\n\nprivate command output",
    },
  };
  const current = snapshot(legacy);
  expect(buildLiveProgress(current, "thread-1").text).not.toContain(
    "I found the issue",
  );
  const progress = buildLiveProgress(current, "thread-1", true);
  expect(progress.text).toContain("I found the issue");
  expect(progress.text).toContain("I am checking tests");
  expect(progress.text).not.toMatch(/Terminal|private command output/);
  const append = jest.fn();
  const context = new LiveProgressContext(append, false, true);
  context.observe(current, "thread-1");
  expect(append).toHaveBeenCalledWith(
    "session.thinking.append",
    expect.stringContaining("I am checking tests"),
    null,
  );
  context.close();
});

it("answers status questions without delegating work and ignores instructions", () => {
  expect(isProgressQuestion("What happened recently?")).toBe(true);
  expect(isProgressQuestion("Please run tests")).toBe(false);
  const append = jest.fn();
  const context = new LiveProgressContext(append);
  context.observe(snapshot(), "thread-1");
  expect(context.answer("What happened recently?")).toContain(
    "I am checking tests",
  );
  expect(context.answer("Which tests are still running?")).toContain(
    "do not show which tests are currently running",
  );
  expect(context.answer("Are you waiting for me?")).toContain(
    "do not confirm whether an approval or reply is pending",
  );
  expect(context.answer("Please run tests")).toBeUndefined();
  expect(append).toHaveBeenCalledWith(
    "session.thinking.append",
    expect.stringContaining("I am checking tests"),
    null,
  );
  context.close();
});

it("keeps unsolicited announcements session-wide instead of inventing a delegation ID", () => {
  const append = jest.fn();
  const context = new LiveProgressContext(append, true);
  context.observe(snapshot(), "thread-1");
  expect(append).toHaveBeenCalledWith(
    "session.commentary.append",
    expect.stringContaining("I am checking tests"),
    null,
  );
  expect(append.mock.calls.every(([, , id]) => id === null)).toBe(true);
  context.close();
});
