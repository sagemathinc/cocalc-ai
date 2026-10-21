/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { codexTurnToastDescription } from "./codex-turn-toast";

describe("the in-page agent turn toast", () => {
  it("says a paused turn is paused, not finished", () => {
    const text = codexTurnToastDescription({
      severity: "info",
      thread_label: "Refactor",
      agent_label: "Claude",
      turn_state: "paused",
    });
    expect(text).toMatch(/Claude is paused in Refactor/);
    expect(text).not.toMatch(/finished/);
    expect(
      codexTurnToastDescription({ severity: "info", thread_label: "Refactor" }),
    ).toBe("The agent finished working in Refactor.");
  });
});
