/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The runtime (Codex, Claude Code or a generic ACP harness) is a server-side
// fact about an agent, so lists can show it without loading the chat. The
// host reports it once per conversation per process when admitting a turn;
// this fills in agents registered before runtimes were recorded. Its model
// and effort come from the runtime itself during a turn (Codex's config
// event, an ACP harness's controls), so peers see what actually runs, and
// are reported again whenever they change.

import type {
  AcpJobRequest,
  AcpStreamPayload,
} from "@cocalc/conat/ai/acp/types";
import {
  agentModelFromCodex,
  agentModelFromHarness,
  agentRuntimeFromProfile,
  type AgentRuntimeSummary,
} from "@cocalc/util/ai/agent-runtime-kind";
import { hubApi } from "../api";

const MAX_REPORTED = 10_000;
const reported = new Set<string>();
// The model last reported for each conversation (its key), so a change is
// reported however often it flips back and forth.
const reportedModel = new Map<string, string>();

type Reporter = (opts: {
  account_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  runtime: AgentRuntimeSummary;
}) => Promise<void>;

let reporter: Reporter = async (opts) => {
  await hubApi.agent.reportRuntime(opts);
};

/** Tests only. */
export function setAgentRuntimeReporterForTests(next?: Reporter) {
  reported.clear();
  reportedModel.clear();
  reporter =
    next ??
    (async (opts) => {
      await hubApi.agent.reportRuntime(opts);
    });
}

function conversation(request: AcpJobRequest) {
  const path = request.chat?.path;
  const thread_id = request.chat?.thread_id;
  if (!path || !thread_id || !path.endsWith(".chat")) return;
  const project_id = request.chat?.project_id ?? request.project_id;
  return { project_id, path, thread_id };
}

export function reportAgentRuntimeOnce(request: AcpJobRequest): void {
  const where = conversation(request);
  if (!where) return;
  const runtime = agentRuntimeFromProfile(request.runtime?.profile);
  const key = JSON.stringify([
    where.project_id,
    where.path,
    where.thread_id,
    runtime,
  ]);
  if (reported.has(key)) return;
  if (reported.size >= MAX_REPORTED) reported.clear();
  reported.add(key);
  void reporter({ account_id: request.account_id, ...where, runtime }).catch(
    () => {
      // Older hubs lack this API; try again on a later turn.
      reported.delete(key);
    },
  );
}

/**
 * During a turn: report the model and effort the runtime says it uses
 * (Codex's config event, an ACP harness's controls). The hub keeps the
 * last one; a report is sent only when it changes.
 */
export function reportAgentModelFromEvent(
  request: AcpJobRequest,
  payload: AcpStreamPayload | null | undefined,
): void {
  if (payload?.type !== "event") return;
  const { event } = payload;
  const acp = request.runtime?.kind === "acp";
  let model: Pick<AgentRuntimeSummary, "model" | "model_name" | "effort">;
  if (event.type === "config" && !acp) model = agentModelFromCodex(event);
  else if (event.type === "harness" && event.kind === "controls" && acp) {
    // The harness publishes { profile, controls }; controls of another
    // profile than this turn's runtime say nothing about it.
    const data = event.data as { profile?: any; controls?: unknown };
    const profile = request.runtime?.profile;
    if (
      !profile ||
      data?.profile?.id !== profile.id ||
      data?.profile?.version !== profile.version
    )
      return;
    model = agentModelFromHarness({ controls: data.controls });
  } else return;
  if (!model.model) return;
  const where = conversation(request);
  if (!where) return;
  const runtime = {
    ...agentRuntimeFromProfile(request.runtime?.profile),
    ...model,
  };
  const key = JSON.stringify([where.project_id, where.path, where.thread_id]);
  const value = JSON.stringify(runtime);
  if (reportedModel.get(key) === value) return;
  if (reportedModel.size >= MAX_REPORTED) reportedModel.clear();
  reportedModel.set(key, value);
  void reporter({ account_id: request.account_id, ...where, runtime }).catch(
    () => {
      // Sent again by the next event that says it (this turn or a later one).
      if (reportedModel.get(key) === value) reportedModel.delete(key);
    },
  );
}
