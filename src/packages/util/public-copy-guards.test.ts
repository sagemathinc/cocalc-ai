/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { STALE_AGENT_PHRASES } from "./public-copy-guards";

describe("STALE_AGENT_PHRASES", () => {
  it.each([
    "Claude Code, OpenCode, and other shell-based agents run in terminals.",
    "Claude Code, and other shell-based agents run in terminals.",
    "Use Codex, Claude Code, and other command-line agents.",
    "Use Codex, Claude Code, or other terminal agents.",
    "Use Claude Code or another terminal agent.",
    "Use command-line agents such as Claude Code.",
    "Use terminal-native agents such as Claude Code.",
    "Use terminal agents like Claude Code.",
    "Run Claude Code in a terminal, or other shell-based agents.",
    "Review the change before keeping it.",
  ])("flags %j", (text) => {
    expect(text).toMatch(STALE_AGENT_PHRASES);
  });

  it.each([
    "Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals.",
    "Claude Code is an integrated agent (experimental preview).",
    "You can also run Claude Code in a terminal.",
    "Codex and Claude Code work in the same project.",
  ])("allows %j", (text) => {
    expect(text).not.toMatch(STALE_AGENT_PHRASES);
  });
});
