/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { projectAgentSessions } from "./agent-sessions";

function session(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "session-1",
    project_id: "project-1",
    account_id: "account-1",
    chat_path: "/chat.chat",
    thread_key: "thread-1",
    title: "Thread",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    status: "idle",
    entrypoint: "global",
    ...overrides,
  };
}

describe("projectAgentSessions", () => {
  it("isolates projects and deduplicates a chat/thread identity", () => {
    const rows = projectAgentSessions(
      {
        "project-1::old": session(),
        "project-1::new": session({
          session_id: "session-2",
          title: "Newer",
          updated_at: "2026-01-02T00:00:00.000Z",
        }),
        "project-2::other": session({
          project_id: "project-2",
          session_id: "other",
        }),
      },
      "project-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("session-2");
    expect(rows[0].title).toBe("Newer");
  });
});
