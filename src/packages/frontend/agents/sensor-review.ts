/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A proposed sensor script is reviewed by an agent with a clean context, not
// left for a person to read line by line. CoCalc starts the review itself: a
// new thread, with the proposing agent's harness, model and payment (or
// another Codex or Claude model), in a chat of its own for that sensor, so the
// agent's chat is not cluttered and nobody has to set up a reviewer.

import { redux } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { initChat } from "@cocalc/frontend/chat/register";
import { copyPaymentSelection } from "@cocalc/frontend/chat/payment-selection-store";
import { newest_content } from "@cocalc/frontend/chat/utils";
import { field } from "@cocalc/frontend/chat/access";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type {
  AgentSensor,
  ScriptSensorSpec,
} from "@cocalc/conat/agents/sensors";
import { joinAbsolutePath } from "@cocalc/util/path-model";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
} from "@cocalc/util/ai/codex";

export type ReviewVerdict = "safe" | "concerns" | "reject";

export function sensorReviewChatPath(
  project_id: string,
  sensor_id: string,
): string {
  return joinAbsolutePath(
    getProjectHomeDirectory(project_id),
    `.local/share/cocalc/sensor-reviews/${sensor_id}.chat`,
  );
}

/** Reviews are of an exact spec, so they still apply once it is approved. */
export function sensorReviewThreadName(title: string, hash: string): string {
  return `Review: ${title.slice(0, 80)} (spec ${hash.slice(0, 12)})`;
}

/** The fixed instructions and the exact spec the person is asked to approve. */
export function sensorReviewPrompt(spec: ScriptSensorSpec): string {
  return [
    "You are reviewing a sensor script before a person approves it. You have",
    "a clean context: judge only what is below. Do not run the script and do",
    "not change any files.",
    "",
    "A sensor runs unattended on its schedule, like a command in the agent's",
    "turn: in the project's software, as the approving person, with the",
    'connectors listed in "uses" (cocalc, github, cloudflare) if that person',
    "turned them on for the agent. It wakes the agent by printing",
    '{"wake": true, "summary": ..., "data": ...}.',
    "",
    "Answer in Markdown, short. The first line must be exactly one of:",
    "Verdict: Looks safe",
    "Verdict: Has concerns",
    "Verdict: Do not approve",
    "Then, in a few bullets:",
    "- What it does, in plain words, and whether that matches its purpose.",
    "- What it reads, and anything it changes, deletes or sends anywhere.",
    '- Network access and connectors it actually uses, versus "uses".',
    "- How often it can wake the agent, and anything wasteful or broken.",
    "- Anything a careful person should know before approving.",
    "",
    "The sensor:",
    "```json",
    JSON.stringify(
      {
        title: spec.title,
        purpose: spec.purpose,
        language: spec.language,
        uses: spec.uses,
        schedule: spec.schedule,
        timeout_seconds: spec.timeout_seconds,
        max_wakes_per_day: spec.max_wakes_per_day,
      },
      null,
      2,
    ),
    "```",
    "The script:",
    "````",
    spec.script,
    "````",
  ].join("\n");
}

export function reviewVerdict(text: string): ReviewVerdict | undefined {
  const first = text.trimStart().split("\n", 1)[0]?.toLowerCase() ?? "";
  if (!first.startsWith("verdict:")) return;
  if (first.includes("do not approve")) return "reject";
  if (first.includes("concern")) return "concerns";
  if (first.includes("looks safe")) return "safe";
  return;
}

// Our own instance, so a chat that is also open as a file (the agent's chat
// in its tab, or a review someone opened) is not registered twice.
const REVIEW_INSTANCE = { instanceKey: "sensor-review" };

async function readyChat(
  project_id: string,
  path: string,
): Promise<ChatActions> {
  const actions: ChatActions =
    (redux.getEditorActions(project_id, path) as any)?.getChatActions?.() ??
    initChat(project_id, path, REVIEW_INSTANCE);
  if (actions.syncdb?.get_state?.() === "ready") return actions;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out opening the chat"));
    }, 15_000);
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      actions.syncdb?.removeListener?.("ready", ready);
      actions.syncdb?.removeListener?.("error", failed);
    };
    actions.syncdb?.once?.("ready", ready);
    actions.syncdb?.once?.("error", failed);
  });
  return actions;
}

/**
 * Who reviews: a model of Codex or Claude, written "codex:<model>" or
 * "claude:<model>", or "same" for the agent's own (custom) harness.
 */
export type ReviewerChoice = string;

export interface ReviewerOption {
  value: ReviewerChoice;
  label: string;
}

/** Claude Code's model aliases; each is the newest of its family. */
export const CLAUDE_REVIEW_MODELS = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

function claudeModelOf(runtime: any): string | undefined {
  return runtime?.settings?.configOptions?.find(
    (option: { id: string }) => option?.id === "model",
  )?.value;
}

/** The reviewer a thread's settings amount to, e.g. "Codex · gpt-5.5". */
export function reviewerOf(settings: any): ReviewerOption {
  const runtime = settings?.agent_runtime;
  if (runtime) {
    if (runtime.profile?.id !== "claude-code")
      return { value: "same", label: "Custom harness" };
    // Without a chosen model CoCalc runs the newest Opus.
    const model = claudeModelOf(runtime) ?? "opus";
    return {
      value: `claude:${model}`,
      label: reviewerLabel(`claude:${model}`),
    };
  }
  const model =
    settings?.acp_config?.model ??
    settings?.agent_model ??
    DEFAULT_CODEX_MODEL_NAME;
  return { value: `codex:${model}`, label: reviewerLabel(`codex:${model}`) };
}

export function reviewerLabel(choice: ReviewerChoice): string {
  const [harness, ...rest] = choice.split(":");
  const model = rest.join(":");
  if (harness === "codex") return `Codex · ${model}`;
  if (harness === "claude")
    return `Claude · ${
      CLAUDE_REVIEW_MODELS.find(({ value }) => value === model)?.label ?? model
    }`;
  return "Custom harness";
}

/**
 * A reviewer never has more access than the agent that wrote the script:
 * clicking Review must not hand an agent-written prompt to a more powerful
 * agent. Codex reviews read-only, so any agent's script can go to Codex.
 * Claude Code has no read-only mode CoCalc enforces (its permission requests
 * are allowed), so Claude reviews only a Claude agent's scripts.
 */
export function reviewerAllowed(
  choice: ReviewerChoice,
  own: ReviewerChoice,
): boolean {
  if (choice.startsWith("codex:")) return true;
  if (choice.startsWith("claude:")) return own.startsWith("claude:");
  return choice === own;
}

/**
 * The models to choose from, the agent's own first and marked as such; a
 * Codex model when the agent's own may not review (a custom harness).
 */
export function reviewerOptions(
  own: ReviewerOption | undefined,
  agentName: string,
): ReviewerOption[] {
  const all = [
    ...DEFAULT_CODEX_MODELS.map(({ name }) => `codex:${name}`),
    ...CLAUDE_REVIEW_MODELS.map(({ value }) => `claude:${value}`),
  ].filter((value) => own && reviewerAllowed(value, own.value));
  const others = all
    .filter((value) => value !== own?.value)
    .map((value) => ({ value, label: reviewerLabel(value) }));
  if (!own || own.value === "same") return others;
  return [
    { value: own.value, label: `${own.label} (same as @${agentName})` },
    ...others,
  ];
}

/** What a review starts with: the agent's own model, else Codex's default. */
export function defaultReviewer(own: ReviewerOption): ReviewerChoice {
  return own.value === "same" ? `codex:${DEFAULT_CODEX_MODEL_NAME}` : own.value;
}

/** The agent's own model, the default reviewer. */
export async function agentReviewer(
  agent: NamedAgent,
): Promise<ReviewerOption> {
  const source = await readyChat(agent.endpoint.project_id, agent.path);
  return reviewerOf(
    source.getThreadMetadata?.(agent.thread_id, { threadId: agent.thread_id }),
  );
}

/** The review chat for a sensor, if one exists already. */
export async function openSensorReviewChat(
  project_id: string,
  sensor_id: string,
): Promise<ChatActions | undefined> {
  const path = sensorReviewChatPath(project_id, sensor_id);
  const fs = redux.getProjectActions(project_id)?.fs?.();
  if (!fs || !(await fs.exists(path))) return;
  return await readyChat(project_id, path);
}

export interface SensorReview {
  thread_id: string;
  text: string;
  generating: boolean;
  verdict?: ReviewVerdict;
  /** Who reviewed, e.g. "Claude · Opus". */
  reviewer?: string;
}

/** The newest review of this exact spec in a sensor's review chat. */
export function findSensorReview(
  actions: ChatActions,
  title: string,
  hash: string,
  account_id?: string,
): SensorReview | undefined {
  const name = sensorReviewThreadName(title, hash);
  const threads = actions
    .listThreadConfigRows()
    .filter((row: any) => row?.name === name)
    .sort((a: any, b: any) =>
      `${b.date ?? ""}`.localeCompare(`${a.date ?? ""}`),
    );
  const thread_id = threads[0]?.thread_id as string | undefined;
  if (!thread_id) return;
  const replies = (actions.getMessagesInThread(thread_id) ?? []).filter(
    (message) => field<string>(message, "sender_id") !== account_id,
  );
  const reply = replies[replies.length - 1];
  const text = reply ? newest_content(reply).trim() : "";
  const settings = actions.getThreadMetadata?.(thread_id, {
    threadId: thread_id,
  });
  return {
    thread_id,
    text,
    generating: reply ? field<boolean>(reply, "generating") === true : true,
    verdict: reviewVerdict(text),
    ...(settings ? { reviewer: reviewerOf(settings).label } : {}),
  };
}

/**
 * Start a review of the sensor's pending (or current) spec: a new thread with
 * the review prompt. The agent's own harness reviews with the agent's
 * settings and payment (copied on the server, so a cold page cannot lose an
 * explicit choice); Codex reviewing another harness's script uses the
 * account's default for Codex.
 */
export async function startSensorReview({
  agent,
  sensor,
  spec,
  hash,
  account_id,
  reviewer,
}: {
  agent: NamedAgent;
  sensor: AgentSensor;
  spec: ScriptSensorSpec;
  /** The spec's hash (pending_hash or script_hash). */
  hash: string;
  account_id?: string;
  /** Default: the agent's own model. */
  reviewer?: ReviewerChoice;
}): Promise<SensorReview> {
  const project_id = sensor.project_id;
  const projectActions = redux.getProjectActions(project_id);
  const fs = projectActions?.fs?.();
  if (!projectActions || !fs)
    throw new Error("The project's files are unavailable; open the project.");
  const source = await readyChat(project_id, agent.path);
  const settings = source.getThreadMetadata?.(agent.thread_id, {
    threadId: agent.thread_id,
  }) as any;
  if (!settings) throw new Error("The agent's settings are unavailable.");
  const own = reviewerOf(settings);
  const choice = reviewer ?? defaultReviewer(own);
  if (!reviewerAllowed(choice, own.value))
    throw new Error(
      `${reviewerLabel(choice)} can't review @${agent.name}'s scripts: it would have more access than @${agent.name}.`,
    );
  const codex = choice.startsWith("codex:");
  const model = choice.slice(choice.indexOf(":") + 1);
  const sameHarness = codex
    ? own.value.startsWith("codex:")
    : own.value.startsWith("claude:") || choice === own.value;
  const path = sensorReviewChatPath(project_id, sensor.sensor_id);
  if (!(await fs.exists(path))) {
    await projectActions.ensureContainingDirectoryExists(path);
    await fs.writeFile(path, "");
  }
  const actions = await readyChat(project_id, path);
  const name = sensorReviewThreadName(spec.title, hash);

  let codexConfig: any;
  let thread_id: string | undefined;
  if (codex) {
    const { sessionId: _session, ...agentConfig } = sameHarness
      ? (settings.acp_config ?? {})
      : {};
    codexConfig = {
      ...agentConfig,
      model,
      // A reviewer reads; it never changes the project.
      sessionMode: "read-only" as const,
    };
    thread_id = actions.createEmptyThread({
      name,
      threadAgent: { mode: "codex", model, codexConfig },
    });
    if (thread_id) actions.setCodexConfig(thread_id, codexConfig);
  } else {
    let runtime = settings.agent_runtime;
    if (choice !== own.value) {
      const options = (runtime.settings?.configOptions ?? []).filter(
        // Fast mode belongs to the agent's model, not necessarily this one.
        ({ id }: { id: string }) => id !== "model" && id !== "fast",
      );
      runtime = {
        ...runtime,
        settings: {
          ...runtime.settings,
          configOptions: [...options, { id: "model", value: model }],
        },
      };
    }
    thread_id = actions.createEmptyThread({
      name,
      threadAgent: { mode: "acp", runtime },
    });
  }
  if (!thread_id) throw new Error("Unable to start the review");
  // Paid the way the agent is; another harness follows the account default.
  if (sameHarness)
    await copyPaymentSelection({
      accountId: account_id,
      from: { project_id, thread_id: agent.thread_id },
      to: { project_id, thread_id },
    });
  const chatIdentity = actions.reserveChatSendIdentity({
    reply_thread_id: thread_id,
  });
  const sent = actions.sendChat({
    input: sensorReviewPrompt(spec),
    reply_thread_id: thread_id,
    acpConfigOverride: codexConfig,
    chatIdentity,
  });
  await actions.syncdb?.save();
  await actions.save_to_disk();
  if (!sent) throw new Error("The review could not start");
  return { thread_id, text: "", generating: true };
}
