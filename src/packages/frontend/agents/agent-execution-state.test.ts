/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { namedAgentExecutionState } from "./agent-execution-state";

describe("named agent execution state", () => {
  it("recognizes executable ACP threads", () => {
    expect(namedAgentExecutionState({ agent_kind: "acp" })).toBe("enabled");
    expect(namedAgentExecutionState({ acp_config: { model: "codex" } })).toBe(
      "enabled",
    );
  });

  it("distinguishes explicit disablement from incomplete legacy metadata", () => {
    expect(namedAgentExecutionState({ agent_kind: "none" })).toBe("disabled");
    expect(namedAgentExecutionState({})).toBe("legacy-missing");
    expect(
      namedAgentExecutionState({ agent_kind: null, acp_config: null }),
    ).toBe("legacy-missing");
  });
});
