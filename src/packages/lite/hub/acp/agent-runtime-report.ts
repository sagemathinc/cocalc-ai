/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The runtime (Codex, Claude Code or a generic ACP harness) is a server-side
// fact about an agent, so lists can show it without loading the chat. The
// host reports it once per conversation per process when admitting a turn;
// this fills in agents registered before runtimes were recorded.

import type { AcpJobRequest } from "@cocalc/conat/ai/acp/types";
import { agentRuntimeFromProfile } from "@cocalc/util/ai/agent-runtime-kind";
import { hubApi } from "../api";

const MAX_REPORTED = 10_000;
const reported = new Set<string>();

type Reporter = (opts: {
  account_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  runtime: ReturnType<typeof agentRuntimeFromProfile>;
}) => Promise<void>;

let reporter: Reporter = async (opts) => {
  await hubApi.agent.reportRuntime(opts);
};

/** Tests only. */
export function setAgentRuntimeReporterForTests(next?: Reporter) {
  reported.clear();
  reporter =
    next ??
    (async (opts) => {
      await hubApi.agent.reportRuntime(opts);
    });
}

export function reportAgentRuntimeOnce(request: AcpJobRequest): void {
  const path = request.chat?.path;
  const thread_id = request.chat?.thread_id;
  if (!path || !thread_id || !path.endsWith(".chat")) return;
  const runtime = agentRuntimeFromProfile(request.runtime?.profile);
  const project_id = request.chat?.project_id ?? request.project_id;
  const key = JSON.stringify([project_id, path, thread_id, runtime]);
  if (reported.has(key)) return;
  if (reported.size >= MAX_REPORTED) reported.clear();
  reported.add(key);
  void reporter({
    account_id: request.account_id,
    project_id,
    path,
    thread_id,
    runtime,
  }).catch(() => {
    // Older hubs lack this API; try again on a later turn.
    reported.delete(key);
  });
}
