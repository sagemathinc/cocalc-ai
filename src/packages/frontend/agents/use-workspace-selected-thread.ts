/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";

export function useWorkspaceSelectedThread(agentId: string, threadId: string) {
  const [selection, setSelection] = useState({
    agentId,
    sourceThreadId: threadId,
    threadId,
  });
  useEffect(() => {
    setSelection((current) =>
      current.agentId === agentId && current.sourceThreadId === threadId
        ? current
        : { agentId, sourceThreadId: threadId, threadId },
    );
  }, [agentId, threadId]);
  // A .chat file can hold multiple named agents. Its workspace stays mounted
  // while the route changes, so a prior agent's local thread cannot win.
  const selectedThread =
    selection.agentId === agentId && selection.sourceThreadId === threadId
      ? selection.threadId
      : threadId;
  const setSelectedThread = (nextThreadId: string) =>
    setSelection({ agentId, sourceThreadId: threadId, threadId: nextThreadId });
  return [selectedThread, setSelectedThread] as const;
}
