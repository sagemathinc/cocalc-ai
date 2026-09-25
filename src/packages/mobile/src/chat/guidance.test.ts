/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProjectedChatMessage } from "@cocalc/chat-client";
import { activityGuidanceSections, inlineGuidance } from "./guidance";

function message(
  message_id: string,
  role: ProjectedChatMessage["role"],
  overrides: Partial<ProjectedChatMessage> = {},
): ProjectedChatMessage {
  return {
    message_id,
    thread_id: "thread",
    sender_id: role,
    role,
    content: message_id,
    date: `2026-09-22T00:00:0${message_id.length}.000Z`,
    generating: false,
    ...overrides,
  };
}

test("attaches durable guidance to the active assistant turn in order", () => {
  const prompt = message("prompt", "human");
  const assistant = message("assistant", "agent", {
    parent_message_id: prompt.message_id,
    generating: true,
  });
  const first = message("first", "human", {
    guidance: true,
    parent_message_id: assistant.message_id,
    date: "2026-09-22T00:00:03.000Z",
  });
  const second = message("second", "human", {
    guidance: true,
    parent_message_id: first.message_id,
    date: "2026-09-22T00:00:04.000Z",
  });
  const rows = inlineGuidance([prompt, assistant, first, second]);
  assert.deepEqual(
    rows.map(({ item }) => item.message_id),
    ["prompt", "assistant"],
  );
  assert.deepEqual(
    rows[1].guidance.map(({ message_id }) => message_id),
    ["first", "second"],
  );
});

test("keeps guidance visible if its assistant is outside the loaded window", () => {
  const guidance = message("guidance", "human", {
    guidance: true,
    parent_message_id: "older-assistant",
  });
  assert.deepEqual(inlineGuidance([guidance]), [
    { item: guidance, guidance: [] },
  ]);
});

test("places guidance between compact agent preview messages", () => {
  const assistant = message("assistant", "agent", {
    generating: true,
    activity: {
      state: "ready",
      events: [
        {
          seq: 1,
          time: 1000,
          type: "event",
          event: { type: "message", text: "I found the bug. ", delta: true },
        },
        {
          seq: 2,
          time: 3000,
          type: "event",
          event: { type: "message", text: "I am fixing it.", delta: true },
        },
      ],
    },
  });
  const guidance = message("guidance", "human", {
    guidance: true,
    guidance_delivered_at_ms: 2000,
    content: "Please check the tests too.",
  });
  const sections = activityGuidanceSections(assistant, [guidance]);
  assert.deepEqual(
    sections.map((section) => section.kind),
    ["activity", "guidance", "activity"],
  );
  assert.match(
    sections[0].kind === "activity" ? sections[0].markdown : "",
    /found the bug/,
  );
  assert.match(
    sections[2].kind === "activity" ? sections[2].markdown : "",
    /fixing it/,
  );
  assert.doesNotMatch(
    sections[2].kind === "activity" ? sections[2].markdown : "",
    /found the bug/,
  );
});

test("keeps delivered guidance in place after a completed turn is reopened", () => {
  const assistant = message("assistant", "agent", {
    content: "Final answer.",
    activity: {
      state: "ready",
      source: "recovered",
      events: [
        {
          seq: 1,
          time: 1000,
          type: "event",
          event: { type: "message", text: "Checking tests. ", delta: true },
        },
        {
          seq: 2,
          time: 3000,
          type: "event",
          event: { type: "message", text: "Final answer.", delta: false },
        },
      ],
    },
  });
  const guidance = message("guidance", "human", {
    guidance: true,
    guidance_delivered_at_ms: 2000,
    content: "Please include the edge case.",
  });
  const sections = activityGuidanceSections(assistant, [guidance]);
  assert.deepEqual(
    sections.map((section) => section.kind),
    ["activity", "guidance"],
  );
  assert.match(
    sections[0].kind === "activity" ? sections[0].markdown : "",
    /Checking tests/,
  );
});
