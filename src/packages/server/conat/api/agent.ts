import {
  createLaunchpadAgentSdkBridge,
  type AgentActionEnvelope,
  type AgentCapabilityManifestEntry,
  type AgentActionResult,
} from "@cocalc/ai/agent-sdk";
import { projectApiClient } from "@cocalc/conat/project/api";
import { fsClient, fsSubject } from "@cocalc/conat/files/fs";
import { conat } from "@cocalc/backend/conat";
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentManifestEntry,
  AgentPlanRequest,
  AgentPlanResponse,
} from "@cocalc/conat/hub/api/agent";
import * as projects from "./projects";
import * as system from "./system";
import { assertCollab } from "./util";
import { evaluate as evaluateLlm } from "@cocalc/server/llm";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  DEFAULT_MODEL,
  isAnthropicModel,
  isCustomOpenAI,
  isGoogleModel,
  isMistralModel,
  isOllamaLLM,
  isOpenAIModel,
} from "@cocalc/util/db-schema/llm-utils";

function createBridge({
  account_id,
  defaults,
}: {
  account_id: string;
  defaults?: { projectId?: string; accountId?: string };
}) {
  const conatClientPromise = conat();
  return createLaunchpadAgentSdkBridge({
    hub: {
      system: {
        ping: () => system.ping(),
        getCustomize: (fields?: string[]) => system.getCustomize(fields),
      },
      projects: {
        createProject: (opts) => projects.createProject({ ...opts, account_id }),
      },
    },
    projectResolver: async (projectId: string) => {
      await assertCollab({ account_id, project_id: projectId });
      return projectApiClient({
        project_id: projectId,
        client: await conatClientPromise,
      });
    },
    fsResolver: async (projectId: string) => {
      await assertCollab({ account_id, project_id: projectId });
      return fsClient({
        client: await conatClientPromise,
        subject: fsSubject({ project_id: projectId }),
      });
    },
    defaults: {
      accountId: account_id,
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

function compactManifest(
  manifest: AgentManifestEntry[],
): Array<{
  actionType: string;
  summary: string;
  riskLevel: string;
  sideEffectScope: string;
  requiresConfirmationByDefault: boolean;
  supportsDryRun: boolean;
}> {
  return manifest.map((entry) => ({
    actionType: entry.actionType,
    summary: entry.summary,
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

async function getPlannerModel(explicit?: string): Promise<string | undefined> {
  if (explicit) {
    return explicit;
  }
  const settings = await getServerSettings();
  const preferred =
    typeof settings?.default_llm === "string" && settings.default_llm.trim()
      ? settings.default_llm.trim()
      : DEFAULT_MODEL;
  const hasKeyForModel = (model: string): boolean => {
    if (isOpenAIModel(model)) {
      return !!settings?.openai_api_key;
    }
    if (isGoogleModel(model)) {
      return !!settings?.google_vertexai_key;
    }
    if (isAnthropicModel(model)) {
      return !!settings?.anthropic_api_key;
    }
    if (isMistralModel(model)) {
      return !!settings?.mistral_api_key;
    }
    if (isCustomOpenAI(model) || isOllamaLLM(model)) {
      return true;
    }
    return true;
  };
  if (hasKeyForModel(preferred)) {
    return preferred;
  }
  if (settings?.openai_api_key) {
    return "gpt-4o-mini-8k";
  }
  return preferred;
}

export async function manifest({
  account_id,
}: {
  account_id?: string;
}): Promise<AgentCapabilityManifestEntry[]> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return createBridge({ account_id }).manifest();
}

export async function execute(
  opts: AgentExecuteRequest,
): Promise<AgentExecuteResponse> {
  const { account_id } = opts;
  if (!account_id) {
    throw Error("must be signed in");
  }
  const bridge = createBridge({
    account_id,
    defaults: opts.defaults,
  });
  const action = opts.action as AgentActionEnvelope;
  const result = await bridge.execute({
    action,
    actor: {
      ...opts.actor,
      accountId: account_id,
      userId: opts.actor?.userId ?? account_id,
    },
    confirmationToken: opts.confirmationToken,
  });
  return normalizeResult(result);
}

export async function plan(opts: AgentPlanRequest): Promise<AgentPlanResponse> {
  const requestId = randomRequestId();
  const { account_id } = opts;
  if (!account_id) {
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
  const bridge = createBridge({ account_id, defaults: opts.defaults });
  const fallbackManifest = bridge.manifest();
  const manifest0 =
    opts.manifest != null && opts.manifest.length > 0
      ? opts.manifest
      : fallbackManifest;
  const manifest = manifest0.filter((entry) => !!entry?.actionType);

  const raw = await evaluateLlm({
    account_id,
    model: await getPlannerModel(opts.model),
    system: buildPlannerSystemPrompt(maxActions),
    input: buildPlannerInput({
      prompt,
      defaults: opts.defaults,
      manifest,
    }),
    maxTokens: 1200,
    tag: "agent-planner",
  });

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
