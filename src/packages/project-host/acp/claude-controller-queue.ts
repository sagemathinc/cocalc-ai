/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_CONTROLLER_BUSY,
  CLAUDE_CONTROLLER_FENCED,
} from "@cocalc/util/ai/claude-controller-ownership";
import { manageClaudeControllerOwnership } from "./claude-subscription-registry";

/** Wait only before native startup: no model/tool work is ever replayed. */
export async function acquireClaudeController(options: {
  projectId: string;
  accountId: string;
  credentialId: string;
  holder: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  manage?: typeof manageClaudeControllerOwnership;
  pollMs?: number;
}): Promise<void> {
  const {
    signal,
    timeoutMs = 15 * 60_000,
    pollMs = 1000,
    manage = manageClaudeControllerOwnership,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  for (;;) {
    signal?.throwIfAborted();
    const result = await manage({
      projectId: options.projectId,
      accountId: options.accountId,
      credentialId: options.credentialId,
      holder: options.holder,
      operation: "acquire",
    });
    if (result === "acquired") return;
    if (result === "released") throw Error(CLAUDE_CONTROLLER_FENCED);
    if (Date.now() >= deadline)
      throw Object.assign(
        Error(
          "Claude subscription is in use; wait for its active turn to finish and retry",
        ),
        { code: CLAUDE_CONTROLLER_BUSY },
      );
    await delay(
      Math.min(
        pollMs * Math.min(8, 2 ** polls++) * (0.5 + Math.random()),
        Math.max(0, deadline - Date.now()),
      ),
      undefined,
      { signal },
    );
  }
}
