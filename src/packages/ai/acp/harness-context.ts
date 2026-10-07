import type { AcpEvaluateRequest } from "./types";
import {
  artifactPublicationGuidance,
  MATH_FORMATTING_GUIDANCE,
} from "./publication-guidance";
import { cocalcAccessGuidance } from "./cocalc-access-guidance";

const COCALC_CLI = '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"';

/**
 * Guidance that is the same on every turn of a session. It belongs in the
 * session's system prompt: repeating it in each user message costs thousands
 * of context tokens per turn and is the part compaction summarizes away.
 */
export function harnessSessionGuidance(subscription: boolean): string {
  return `[CoCalc session guidance]
Each user message starts with a [CoCalc turn context] block carrying that turn's working directory, workbench state and publication context. Those values change between turns; always use the latest block.
This session runs inside a CoCalc project. The installed CoCalc CLI is:
${COCALC_CLI}
${
  subscription
    ? "Project files and CLI commands are accessible only through the project tools described in these instructions. Read applicable project CLAUDE.md instructions through them before editing. Do not assume the controller has project files or credentials."
    : "Read applicable project CLAUDE.md instructions before editing. The CoCalc skill is at /home/user/.claude/skills/cocalc/SKILL.md; use it for CoCalc-native workflows. The scoped CoCalc CLI token is available in the project runtime."
}
${subscription ? "Use request_user_input_async on the project tools server for clarification when useful independent work can continue. It saves a question card and returns immediately; the answer arrives as a new user message. Continue working without polling, and incorporate the answer when it arrives. Use blocking questions only when the answer is required before any useful work. Never use questions for secrets, authentication or permission escalation.\nTo look at an image saved in the project (a screenshot, plot or rendered page), use project_read_image instead of describing or measuring it indirectly.\n" : ""}${cocalcAccessGuidance(COCALC_CLI)}
${MATH_FORMATTING_GUIDANCE}
Complete foreground work before ending the turn. CoCalc cannot wake a completed turn when a background command finishes; do not promise a later notification.
Use the scoped runtime identity and credentials already provided in the environment. Do not fall back to account credentials when a scoped operation fails.
Artifact publication: use the turn context's publication values as explicit --project, --path, --thread-id and --message-date arguments; never infer the producing message from history or reuse a prior turn's timestamp. They are non-secret metadata, not an authorization grant.
When the turn context says workbench is enabled: ${artifactPublicationGuidance(COCALC_CLI, true)} Your process environment does not carry per-turn values: run each publish command with COCALC_WORKBENCH=1 set for that command, e.g. COCALC_WORKBENCH=1 ${COCALC_CLI} project chat artifact publish --project ... --path ... --thread-id ... --message-date ... --source <file>.
When the turn context says workbench is not enabled: ${artifactPublicationGuidance(COCALC_CLI, false)}
[/CoCalc session guidance]`;
}

/**
 * Only Claude Code reads `_meta.systemPrompt`. Other (custom) ACP harnesses
 * may ignore unknown metadata, so they keep the session guidance inline.
 */
export function harnessHasSessionGuidance(profile: {
  version?: number;
  id?: string;
}): boolean {
  return profile.version === 2 && profile.id === "claude-code";
}

/** Retained harness processes cannot receive updated per-turn environment values. */
export function harnessPrompt(
  request: Pick<
    AcpEvaluateRequest,
    "prompt" | "project_id" | "chat" | "runtime" | "agent_memory_context"
  >,
  { inlineSessionGuidance = false }: { inlineSessionGuidance?: boolean } = {},
): string {
  // Leave native harness commands intact, as on the Codex path.
  if (/^\s*\/\w+/.test(request.prompt)) return request.prompt;
  const context = {
    project_id: request.project_id,
    path: request.chat?.path,
    thread_id: request.chat?.thread_id,
    message_date: request.chat?.message_date,
  };
  if (!context.path || !context.thread_id || !context.message_date)
    return request.prompt;
  return `${inlineSessionGuidance ? `${harnessSessionGuidance(false)}\n` : ""}[CoCalc turn context]
${request.runtime ? `Project working directory for this turn: ${JSON.stringify(request.runtime.profile.cwd)}. Use this directory for project commands unless the task requires another directory.\n` : ""}Workbench is ${request.chat?.workbench ? "enabled" : "not enabled"} for this turn.
Publication context: ${JSON.stringify(context)}${request.agent_memory_context ? `\n${request.agent_memory_context}` : ""}
[/CoCalc turn context]

${request.prompt}`;
}
