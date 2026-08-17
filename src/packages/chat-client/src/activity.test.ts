/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

import { mergeAcpActivityEvents, projectAcpActivityMarkdown } from "./activity";

describe("ACP activity projection", () => {
  it("recovers intermediate agent text and terminal output", () => {
    const events: AcpStreamMessage[] = [
      {
        type: "event",
        seq: 1,
        event: { type: "message", text: "I will calculate that." },
      },
      {
        type: "event",
        seq: 2,
        event: {
          type: "terminal",
          terminalId: "terminal-1",
          phase: "start",
          command: "bash",
          args: ["-lc", "expr 17 + 45"],
          cwd: "/home/user/project",
        },
      },
      {
        type: "event",
        seq: 3,
        event: {
          type: "terminal",
          terminalId: "terminal-1",
          phase: "data",
          chunk: "62\n",
        },
      },
      {
        type: "event",
        seq: 4,
        event: {
          type: "terminal",
          terminalId: "terminal-1",
          phase: "exit",
          exitStatus: { exitCode: 0 },
        },
      },
      { type: "summary", seq: 5, finalResponse: "Done." },
    ];

    const markdown = projectAcpActivityMarkdown(events) ?? "";
    expect(markdown).toContain("I will calculate that.");
    expect(markdown).toContain("expr 17 + 45");
    expect(markdown).toContain("62");
    expect(markdown).not.toContain("Done.");
  });

  it("merges persisted and live events by sequence", () => {
    const status: AcpStreamMessage = {
      type: "status",
      state: "running",
      seq: 1,
    };
    const summary: AcpStreamMessage = {
      type: "summary",
      finalResponse: "Done.",
      seq: 2,
    };
    expect(mergeAcpActivityEvents([status], [status, summary])).toEqual([
      status,
      summary,
    ]);
  });
});
