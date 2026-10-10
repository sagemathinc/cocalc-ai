/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A proposed sensor script is reviewed by an agent with a clean context, not
// left for a person to read line by line. CoCalc starts the review itself: a
// new thread, with the proposing agent's harness, model and payment (or a
// chosen model), in a chat of its own for that sensor, so the agent's chat
// is not cluttered and nobody has to set up a reviewer.

import { redux } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { initChat } from "@cocalc/frontend/chat/register";
import { newest_content } from "@cocalc/frontend/chat/utils";
import { field } from "@cocalc/frontend/chat/access";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "@cocalc/frontend/chat/harness-credential-selection";
import {
  readAgentSubscriptionSelection,
  writeAgentSubscriptionSelection,
} from "./agent-subscription-selection";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type {
  AgentSensor,
  ScriptSensorSpec,
} from "@cocalc/conat/agents/sensors";
import { joinAbsolutePath } from "@cocalc/util/path-model";

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

async function readyChat(
  project_id: string,
  path: string,
): Promise<ChatActions> {
  const actions = initChat(project_id, path);
  if (actions.syncdb?.get_state?.() === "ready") return actions;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out opening the review chat"));
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
  return {
    thread_id,
    text,
    generating: reply ? field<boolean>(reply, "generating") === true : true,
    verdict: reviewVerdict(text),
  };
}

/**
 * Start a review of the sensor's pending (or current) spec: a new thread with
 * the proposing agent's settings, read-only, and the review prompt.
 */
export async function startSensorReview({
  agent,
  sensor,
  spec,
  hash,
  account_id,
  model,
}: {
  agent: NamedAgent;
  sensor: AgentSensor;
  spec: ScriptSensorSpec;
  /** The spec's hash (pending_hash or script_hash). */
  hash: string;
  account_id?: string;
  /** Another model of the same harness; default the agent's own. */
  model?: string;
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
  const path = sensorReviewChatPath(project_id, sensor.sensor_id);
  if (!(await fs.exists(path))) {
    await projectActions.ensureContainingDirectoryExists(path);
    await fs.writeFile(path, "");
  }
  const actions = await readyChat(project_id, path);
  const runtime = settings.agent_runtime;
  const { sessionId: _session, ...agentConfig } = settings.acp_config ?? {};
  const codexConfig = {
    ...agentConfig,
    ...(model ? { model } : {}),
    // A reviewer reads; it never changes the project.
    sessionMode: "read-only" as const,
  };
  const thread_id = actions.createEmptyThread({
    name: sensorReviewThreadName(spec.title, hash),
    threadAgent: runtime
      ? { mode: "acp", runtime }
      : {
          mode: "codex",
          model: codexConfig.model ?? settings.agent_model,
          codexConfig,
        },
  });
  if (!thread_id) throw new Error("Unable to start the review");
  // Paid the way the agent is.
  if (runtime) {
    const credential = readHarnessCredentialSelection({
      accountId: account_id,
      projectId: project_id,
      threadKey: agent.thread_id,
    });
    if (credential)
      writeHarnessCredentialSelection({
        accountId: account_id,
        projectId: project_id,
        threadKey: thread_id,
        credential,
      });
  } else {
    writeAgentSubscriptionSelection({
      accountId: account_id,
      projectId: project_id,
      threadId: thread_id,
      credentialId: readAgentSubscriptionSelection({
        accountId: account_id,
        projectId: project_id,
        threadId: agent.thread_id,
      }),
    });
    actions.setCodexConfig(thread_id, codexConfig);
  }
  const chatIdentity = actions.reserveChatSendIdentity({
    reply_thread_id: thread_id,
  });
  const sent = actions.sendChat({
    input: sensorReviewPrompt(spec),
    reply_thread_id: thread_id,
    acpConfigOverride: runtime ? undefined : codexConfig,
    chatIdentity,
  });
  await actions.syncdb?.save();
  await actions.save_to_disk();
  if (!sent) throw new Error("The review could not start");
  return { thread_id, text: "", generating: true };
}
