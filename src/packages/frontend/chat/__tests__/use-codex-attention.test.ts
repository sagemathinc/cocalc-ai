/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { pendingAttentionByThread } from "../use-codex-attention";

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
});
