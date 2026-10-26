/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Decides once whether a new agent starts as Claude rather than Codex (see
// shouldDefaultToClaude), and reports when that is decided: until then the
// form must not create the agent, or a quick submit would create a Codex
// agent the default was about to change. The user's own choice settles it at
// once, and so does a check that takes too long (the agent stays Codex).

import { useCallback, useEffect, useRef, useState } from "react";
import { shouldDefaultToClaude } from "./new-agent-codex-payment";

export const CLAUDE_DEFAULT_TIMEOUT_MS = 8_000;

export function useClaudeRuntimeDefault({
  codexRuntime,
  runtimeChosen,
  codexOwnPlan,
  accountId,
  checkClaude,
  onClaude,
  timeoutMs = CLAUDE_DEFAULT_TIMEOUT_MS,
}: {
  /** Whether the form currently shows a Codex agent. */
  codexRuntime: boolean;
  /** Whether the runtime came from a source agent or the user's choice. */
  runtimeChosen: () => boolean;
  /** Whether Codex would run on the user's own ChatGPT plan; undefined
   * until known. */
  codexOwnPlan: boolean | undefined;
  accountId?: string;
  checkClaude: () => Promise<{
    claudeConnected: boolean;
    claudeIncluded: boolean;
  }>;
  onClaude: () => void;
  timeoutMs?: number;
}): { settled: boolean; settle: () => void } {
  const [settled, setSettled] = useState(
    () => !codexRuntime || runtimeChosen(),
  );
  const settledRef = useRef(settled);
  const settle = useCallback(() => {
    settledRef.current = true;
    setSettled(true);
  }, []);
  const latest = useRef({ checkClaude, onClaude, runtimeChosen });
  latest.current = { checkClaude, onClaude, runtimeChosen };

  useEffect(() => {
    if (settledRef.current) return;
    const timer = setTimeout(settle, timeoutMs);
    return () => clearTimeout(timer);
  }, [settle, timeoutMs]);

  useEffect(() => {
    if (settledRef.current) return;
    if (!codexRuntime || latest.current.runtimeChosen()) {
      settle();
      return;
    }
    if (codexOwnPlan == null) return;
    let disposed = false;
    void latest.current
      .checkClaude()
      .catch(() => ({ claudeConnected: false, claudeIncluded: false }))
      .then(({ claudeConnected, claudeIncluded }) => {
        if (disposed || settledRef.current) return;
        if (
          shouldDefaultToClaude({
            runtimeChosen: latest.current.runtimeChosen(),
            claudeConnected,
            claudeIncluded,
            codexOwnPlan,
          })
        ) {
          latest.current.onClaude();
        }
        settle();
      });
    return () => {
      disposed = true;
    };
  }, [codexRuntime, codexOwnPlan, accountId, settle]);

  return { settled, settle };
}
