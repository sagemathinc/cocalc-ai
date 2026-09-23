/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProjectedChatMessage } from "@cocalc/chat-client";
import { inlineGuidance } from "./guidance";

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
