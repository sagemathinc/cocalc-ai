/** Share in-flight work with submit; retry failures without duplicating successes. */
export function retryablePreparation<T>() {
  let pending: Promise<T> | undefined;
  return (prepare: () => Promise<T>): Promise<T> => {
    if (!pending) {
      pending = Promise.resolve()
        .then(prepare)
        .catch((error) => {
          pending = undefined;
          throw error;
        });
    }
    return pending;
  };
}

import type { NewAgentRuntimeKind } from "./new-agent-runtime-select";

export interface PreparedFirstAgent {
  projectId: string;
  path: string;
  threadId: string;
  name: string;
  automaticProjectTitle?: string;
  // The agent type the thread was created with (missing: Codex, the only
  // first-run type before the selector was shown there).
  runtimeKind?: NewAgentRuntimeKind;
}

const KEY = "cocalc:prepared-first-agent:";
export function readPreparedFirstAgent(
  accountId?: string,
): PreparedFirstAgent | undefined {
  if (!accountId) return;
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY + accountId) ?? "null");
    if (
      value &&
      ["projectId", "path", "threadId", "name"].every(
        (key) => typeof value[key] === "string" && value[key],
      )
    )
      return value;
  } catch {
    /* A missing checkpoint only means preparation starts normally. */
  }
}

export function writePreparedFirstAgent(
  accountId: string | undefined,
  value?: PreparedFirstAgent,
) {
  if (!accountId) return;
  try {
    if (value) sessionStorage.setItem(KEY + accountId, JSON.stringify(value));
    else sessionStorage.removeItem(KEY + accountId);
  } catch {
    /* The in-memory single flight still prevents duplicate submits. */
  }
}
