import {
  createPlusAgentSdkBridge,
  type AgentActionEnvelope,
  type AgentActionResult,
  type AgentCapabilityManifestEntry,
} from "@cocalc/ai/agent-sdk";
import { CodexExecAgent } from "@cocalc/ai/acp";
import { account_id as ACCOUNT_ID } from "@cocalc/backend/data";
import type { AcpStreamPayload } from "@cocalc/conat/ai/acp/types";
import { fsClient, fsSubject } from "@cocalc/conat/files/fs";
import { projectApiClient } from "@cocalc/conat/project/api";
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentManifestEntry,
  AgentPlanRequest,
  AgentPlanResponse,
  AgentRunRequest,
  AgentRunResponse,
  AgentRunState,
  AgentRunStep,
} from "@cocalc/conat/hub/api/agent";
import { conat } from "@cocalc/conat/client";
import { project_id as LOCAL_PROJECT_ID } from "@cocalc/project/data";
import { callRemoteHub, hasRemote, project_id as REMOTE_PROJECT_ID } from "../remote";
import { getLiteServerSettings } from "./settings";

function getProjectId(): string {
  return REMOTE_PROJECT_ID || LOCAL_PROJECT_ID;
}

async function getCustomize(fields?: string[]) {
  if (!hasRemote) {
    return {};
  }
  return await callRemoteHub({
    name: "system.getCustomize",
    args: fields == null ? [] : [fields],
  });
}

async function ping() {
  if (!hasRemote) {
    return { now: Date.now() };
  }
  return await callRemoteHub({ name: "system.ping", args: [] });
}

function createBridge({
  defaults,
}: {
  defaults?: { projectId?: string; accountId?: string };
}) {
  const projectId = defaults?.projectId ?? getProjectId();
  const conatClient = conat();
  return createPlusAgentSdkBridge({
    hub: {
      system: { ping, getCustomize },
      projects: {
        createProject: async () => {
          throw Error("Creating projects is not supported in lite mode");
        },
      },
    },
    project: projectApiClient({ project_id: projectId }),
    fs: fsClient({
      client: conatClient,
      subject: fsSubject({ project_id: projectId }),
    }),
    defaults: {
      accountId: ACCOUNT_ID,
      projectId,
      ...defaults,
    },
  });
}

function normalizeResult(result: AgentActionResult): AgentExecuteResponse {
  return {
    status: result.status,
    requestId: result.requestId,
    actionType: result.actionType,
    result: result.result,
    error: result.error,
    reason: result.reason,
    blockedByPolicy: result.blockedByPolicy,
    requiresConfirmation: result.requiresConfirmation,
    idempotentReplay: result.idempotentReplay,
  };
}

function randomRequestId(prefix = "agent-plan"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function getPlannerCodexModel(explicit?: string): string {
  if (
    typeof explicit === "string" &&
    explicit.trim() &&
    explicit.includes("codex")
  ) {
    return explicit.trim();
  }
  const settings = getLiteServerSettings();
  const configured =
    typeof settings?.default_llm === "string" && settings.default_llm.trim()
      ? settings.default_llm.trim()
      : "";
  if (configured.includes("codex")) {
    return configured;
  }
  return "gpt-5.1-codex-mini";
}

let plannerCodexAgent: Promise<CodexExecAgent> | undefined;

async function getPlannerCodexAgent(): Promise<CodexExecAgent> {
  plannerCodexAgent ??= CodexExecAgent.create({
    binaryPath: process.env.COCALC_CODEX_BIN,
    cwd: process.cwd(),
  });
  return await plannerCodexAgent;
}

function compactManifest(
  manifest: AgentManifestEntry[],
): Array<{
  actionType: string;
  summary: string;
  argsSchema?: unknown;
  riskLevel: string;
  sideEffectScope: string;
  requiresConfirmationByDefault: boolean;
  supportsDryRun: boolean;
}> {
  return manifest.map((entry) => ({
    actionType: entry.actionType,
    summary: entry.summary,
    argsSchema: entry.argsSchema,
    riskLevel: entry.riskLevel,
    sideEffectScope: entry.sideEffectScope,
    requiresConfirmationByDefault: entry.requiresConfirmationByDefault,
    supportsDryRun: entry.supportsDryRun,
  }));
}

function buildPlannerSystemPrompt(maxActions: number): string {
  return [
    "You are the CoCalc navigator planner.",
    "Translate the user request into a short list of agent actions.",
    "Return strict JSON only. No markdown, no backticks, no commentary.",
    "Output schema:",
    '{ "summary": string, "actions": [{ "actionType": string, "args": object, "target"?: object }] }',
    `Include at most ${maxActions} actions.`,
    "Only use actionType values present in the provided capability manifest.",
    "Prefer safe/read actions when unsure.",
    "If no valid action is possible, return actions as an empty array and explain in summary.",
  ].join("\n");
}

function buildPlannerInput({
  prompt,
  defaults,
  manifest,
}: {
  prompt: string;
  defaults?: AgentPlanRequest["defaults"];
  manifest: AgentManifestEntry[];
}): string {
  return [
    `User request:\n${prompt}`,
    `Defaults:\n${JSON.stringify(defaults ?? {}, null, 2)}`,
    `Capability manifest:\n${JSON.stringify(compactManifest(manifest), null, 2)}`,
  ].join("\n\n");
}

function buildPlannerCodexPrompt({
  prompt,
  defaults,
  manifest,
  maxActions,
}: {
  prompt: string;
  defaults?: AgentPlanRequest["defaults"];
  manifest: AgentManifestEntry[];
  maxActions: number;
}): string {
  return [
    buildPlannerSystemPrompt(maxActions),
    "",
    buildPlannerInput({
      prompt,
      defaults,
      manifest,
    }),
  ].join("\n");
}

function truncateString(value: string, max = 600): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function compactRunStepsForPrompt(
  steps: AgentRunStep[],
): Array<Record<string, unknown>> {
  return steps.map((step) => ({
    stepIndex: step.stepIndex,
    actionType: step.action?.actionType,
    status: step.execution?.status,
    observation:
      typeof step.observation === "string"
        ? truncateString(step.observation, 300)
        : undefined,
  }));
}

function buildRunnerSystemPrompt(stepNumber: number): string {
  return [
    "You are the CoCalc navigator executor.",
    "Pick the SINGLE best next action to advance the goal.",
    "Return strict JSON only. No markdown, no backticks.",
    "Output schema:",
    '{ "summary": string, "actions": [{ "actionType": string, "args": object, "target"?: object }] }',
    "Rules:",
    "- Return exactly one action in actions when more work is needed.",
    "- Return an empty actions array when the task is complete.",
    "- Use only actionType values from the provided capability manifest.",
    `- You are choosing action for step ${stepNumber}.`,
  ].join("\n");
}

function buildRunnerInput({
  goal,
  defaults,
  manifest,
  steps,
}: {
  goal: string;
  defaults?: AgentRunRequest["defaults"];
  manifest: AgentManifestEntry[];
  steps: AgentRunStep[];
}): string {
  return [
    `Goal:\n${goal}`,
    `Defaults:\n${JSON.stringify(defaults ?? {}, null, 2)}`,
    `Previous steps:\n${JSON.stringify(compactRunStepsForPrompt(steps), null, 2)}`,
    `Capability manifest:\n${JSON.stringify(compactManifest(manifest), null, 2)}`,
  ].join("\n\n");
}

function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fence?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw Error("planner did not return valid JSON");
  }
}

function normalizeTarget(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const target: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0) {
      target[k] = v;
    }
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

function normalizeAction(value: unknown): AgentActionEnvelope | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const actionType0 = value.actionType ?? value.action_type;
  if (typeof actionType0 !== "string" || actionType0.trim().length === 0) {
    return undefined;
  }
  const args = value.args ?? value.arguments ?? {};
  const riskLevel0 = value.riskLevel ?? value.risk_level;
  const requiresConfirmation0 =
    value.requiresConfirmation ?? value.requires_confirmation;
  const idempotencyKey0 = value.idempotencyKey ?? value.idempotency_key;
  return {
    actionType: actionType0.trim(),
    args,
    target: normalizeTarget(value.target),
    riskLevel:
      riskLevel0 === "read" ||
      riskLevel0 === "write" ||
      riskLevel0 === "destructive" ||
      riskLevel0 === "access" ||
      riskLevel0 === "billing" ||
      riskLevel0 === "network" ||
      riskLevel0 === "install"
        ? riskLevel0
        : undefined,
    requiresConfirmation:
      typeof requiresConfirmation0 === "boolean"
        ? requiresConfirmation0
        : undefined,
    idempotencyKey:
      typeof idempotencyKey0 === "string" ? idempotencyKey0 : undefined,
  };
}

function parsePlannerOutput({
  raw,
  maxActions,
}: {
  raw: string;
  maxActions: number;
}): {
  summary?: string;
  actions: AgentActionEnvelope[];
} {
  const parsed = extractJsonFromText(raw);
  if (!isRecord(parsed)) {
    throw Error("planner output must be an object");
  }
  const rawActions = parsed.actions;
  if (!Array.isArray(rawActions)) {
    throw Error("planner output is missing actions array");
  }
  const actions = rawActions
    .map((entry) => normalizeAction(entry))
    .filter((entry): entry is AgentActionEnvelope => entry != null)
    .slice(0, maxActions);
  const summary =
    typeof parsed.summary === "string" ? parsed.summary.trim() : undefined;
  return { summary, actions };
}

function summarizeExecutionObservation(result: AgentExecuteResponse): string {
  if (result.status === "failed") {
    return `failed: ${result.error ?? "unknown error"}`;
  }
  if (result.status === "blocked") {
    return `blocked: ${result.reason ?? result.error ?? "confirmation required"}`;
  }
  const payload =
    result.result == null ? "" : truncateString(JSON.stringify(result.result), 800);
  return payload ? `completed: ${payload}` : "completed";
}

function normalizeRunState(
  opts: AgentRunRequest,
): { goal: string; state: AgentRunState } {
  const state0 = opts.state;
  const goal =
    (typeof state0?.goal === "string" && state0.goal.trim()) ||
    (typeof opts.prompt === "string" && opts.prompt.trim()) ||
    "";
  if (!goal) {
    throw Error("prompt must be non-empty");
  }
  const steps = Array.isArray(state0?.steps) ? state0!.steps : [];
  const state: AgentRunState = {
    goal,
    steps: steps.map((step, i) => ({
      stepIndex: Number.isInteger(step?.stepIndex) ? step.stepIndex : i,
      planner: step?.planner,
      action: step?.action,
      execution: step?.execution,
      observation: step?.observation,
    })),
    pendingConfirmation: state0?.pendingConfirmation,
    summary: state0?.summary,
  };
  return { goal, state };
}

async function runPlannerWithCodex({
  account_id,
  prompt,
  defaults,
  manifest,
  maxActions,
  model,
}: {
  account_id: string;
  prompt: string;
  defaults?: AgentPlanRequest["defaults"];
  manifest: AgentManifestEntry[];
  maxActions: number;
  model?: string;
}): Promise<string> {
  const agent = await getPlannerCodexAgent();
  const codexPrompt = buildPlannerCodexPrompt({
    prompt,
    defaults,
    manifest,
    maxActions,
  });
  return await runCodexPrompt({
    agent,
    account_id,
    prompt: codexPrompt,
    model,
  });
}

async function runCodexPrompt({
  agent,
  account_id,
  prompt,
  model,
}: {
  agent: CodexExecAgent;
  account_id: string;
  prompt: string;
  model?: string;
}): Promise<string> {
  let finalResponse = "";
  let lastError = "";
  await agent.evaluate({
    account_id,
    prompt,
    stream: async (payload?: AcpStreamPayload | null) => {
      if (payload == null) return;
      if (payload.type === "summary") {
        finalResponse = payload.finalResponse ?? "";
        return;
      }
      if (payload.type === "error") {
        lastError = payload.error;
      }
    },
    config: {
      model: getPlannerCodexModel(model),
      sessionMode: "read-only",
    },
  });
  const raw = finalResponse.trim();
  if (raw.length > 0) {
    return raw;
  }
  throw Error(lastError || "Codex planner returned no output");
}

export async function manifest({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<AgentCapabilityManifestEntry[]> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return createBridge({}).manifest();
}

export async function execute(
  opts: AgentExecuteRequest,
): Promise<AgentExecuteResponse> {
  if (!opts.account_id) {
    throw Error("must be signed in");
  }
  const bridge = createBridge({ defaults: opts.defaults });
  const action = opts.action as AgentActionEnvelope;
  const result = await bridge.execute({
    action,
    actor: {
      ...opts.actor,
      accountId: opts.account_id,
      userId: opts.actor?.userId ?? opts.account_id,
    },
    confirmationToken: opts.confirmationToken,
  });
  return normalizeResult(result);
}

export async function plan(opts: AgentPlanRequest): Promise<AgentPlanResponse> {
  const requestId = randomRequestId();
  if (!opts.account_id) {
    throw Error("must be signed in");
  }
  const prompt = opts.prompt?.trim();
  if (!prompt) {
    return {
      status: "failed",
      requestId,
      error: "prompt must be non-empty",
    };
  }
  const maxActions = Math.max(1, Math.min(10, opts.maxActions ?? 3));
  const bridge = createBridge({ defaults: opts.defaults });
  const fallbackManifest = bridge.manifest();
  const manifest0 =
    opts.manifest != null && opts.manifest.length > 0
      ? opts.manifest
      : fallbackManifest;
  const manifest = manifest0.filter((entry) => !!entry?.actionType);
  let raw = "";
  try {
    raw = await runPlannerWithCodex({
      account_id: opts.account_id,
      prompt,
      defaults: opts.defaults,
      manifest,
      maxActions,
      model: opts.model,
    });
  } catch (err) {
    return {
      status: "failed",
      requestId,
      error: `Codex planner failed: ${err}`,
    };
  }
  try {
    const plan = parsePlannerOutput({ raw, maxActions });
    if (plan.actions.length === 0) {
      return {
        status: "failed",
        requestId,
        error:
          plan.summary ??
          "Planner did not return any executable actions for this prompt.",
        raw,
      };
    }
    return {
      status: "planned",
      requestId,
      plan,
      raw,
    };
  } catch (err) {
    return {
      status: "failed",
      requestId,
      error: `${err}`,
      raw,
    };
  }
}

export async function run(opts: AgentRunRequest): Promise<AgentRunResponse> {
  const requestId = randomRequestId("agent-run");
  if (!opts.account_id) {
    throw Error("must be signed in");
  }
  const maxSteps = Math.max(1, Math.min(25, opts.maxSteps ?? 8));
  const dryRun = !!opts.dryRun;
  const { goal, state } = normalizeRunState(opts);
  const bridge = createBridge({ defaults: opts.defaults });
  const fallbackManifest = bridge.manifest();
  const manifest0 =
    opts.manifest != null && opts.manifest.length > 0
      ? opts.manifest
      : fallbackManifest;
  const manifest = manifest0.filter((entry) => !!entry?.actionType);
  const agent = await getPlannerCodexAgent();

  const executeOne = async ({
    action,
    confirmationToken,
  }: {
    action: AgentActionEnvelope;
    confirmationToken?: string;
  }): Promise<AgentExecuteResponse> => {
    const result = await bridge.execute({
      action: { ...action, dryRun },
      actor: {
        accountId: opts.account_id,
        userId: opts.account_id,
      },
      confirmationToken,
    });
    return normalizeResult(result);
  };

  if (state.pendingConfirmation) {
    if (!opts.confirmationToken) {
      return {
        status: "awaiting_confirmation",
        requestId,
        state,
        error: "confirmation token required to continue",
      };
    }
    const pending = state.pendingConfirmation;
    const step = state.steps[pending.stepIndex];
    if (!step) {
      return {
        status: "failed",
        requestId,
        state,
        error: "invalid pending confirmation state",
      };
    }
    const execution = await executeOne({
      action: pending.action as AgentActionEnvelope,
      confirmationToken: opts.confirmationToken,
    });
    step.execution = execution;
    step.observation = summarizeExecutionObservation(execution);
    state.pendingConfirmation = undefined;
    if (execution.status === "blocked") {
      state.pendingConfirmation = {
        stepIndex: pending.stepIndex,
        action: pending.action,
      };
      return {
        status: "awaiting_confirmation",
        requestId,
        state,
        error: execution.reason ?? execution.error,
      };
    }
    if (execution.status === "failed") {
      return {
        status: "failed",
        requestId,
        state,
        error: execution.error ?? "step failed after confirmation",
      };
    }
  }

  while (state.steps.length < maxSteps) {
    let raw = "";
    try {
      raw = await runCodexPrompt({
        agent,
        account_id: opts.account_id,
        prompt: [
          buildRunnerSystemPrompt(state.steps.length + 1),
          "",
          buildRunnerInput({
            goal,
            defaults: opts.defaults,
            manifest,
            steps: state.steps,
          }),
        ].join("\n"),
        model: opts.model,
      });
    } catch (err) {
      return {
        status: "failed",
        requestId,
        state,
        error: `Codex runner failed: ${err}`,
      };
    }
    let parsed;
    try {
      parsed = parsePlannerOutput({ raw, maxActions: 1 });
    } catch (err) {
      return {
        status: "failed",
        requestId,
        state,
        error: `runner output parse failed: ${err}`,
      };
    }
    if (parsed.actions.length === 0) {
      state.summary = parsed.summary ?? "Task completed.";
      return {
        status: "completed",
        requestId,
        state,
      };
    }
    const action = parsed.actions[0];
    const stepIndex = state.steps.length;
    const step: AgentRunStep = {
      stepIndex,
      planner: {
        summary: parsed.summary,
        raw,
      },
      action,
    };
    state.steps.push(step);
    const execution = await executeOne({ action });
    step.execution = execution;
    step.observation = summarizeExecutionObservation(execution);
    if (execution.status === "blocked" && execution.requiresConfirmation) {
      state.pendingConfirmation = {
        stepIndex,
        action,
      };
      return {
        status: "awaiting_confirmation",
        requestId,
        state,
        error: execution.reason ?? execution.error,
      };
    }
    if (execution.status === "failed") {
      return {
        status: "failed",
        requestId,
        state,
        error: execution.error ?? "step execution failed",
      };
    }
  }
  return {
    status: "failed",
    requestId,
    state,
    error: `max steps reached (${maxSteps})`,
  };
}
