import type { AcpEvaluateRequest } from "./types";
import { CLAUDE_PROJECT_JOB_GUIDANCE } from "@cocalc/util/ai/claude-project-tools";
import { artifactPublicationGuidance } from "./publication-guidance";
import { cocalcAccessGuidance } from "./cocalc-access-guidance";

const COCALC_CLI = '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"';

/** Retained harness processes cannot receive updated per-turn environment values. */
export function harnessPrompt(
  request: Pick<
    AcpEvaluateRequest,
    | "prompt"
    | "project_id"
    | "chat"
    | "harness_credential"
    | "runtime"
    | "agent_memory_context"
  >,
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
  // Harness processes are retained across turns, so the CLI never sees this
  // turn's COCALC_WORKBENCH; the command sets it for itself.
  const publication = request.chat?.workbench
    ? `${artifactPublicationGuidance(COCALC_CLI, true)} Your process environment does not carry per-turn values: run each publish command with COCALC_WORKBENCH=1 set for that command, e.g. COCALC_WORKBENCH=1 ${COCALC_CLI} project chat artifact publish --project ... --path ... --thread-id ... --message-date ... --source <file>.`
    : artifactPublicationGuidance(COCALC_CLI, false);
  const projectGuidance =
    request.harness_credential?.mode === "account-subscription"
      ? "The canonical CoCalc skill is preloaded in your session instructions. Project files and CLI commands are accessible only through the project_exec tool on the currently advertised cocalc_project_* server. Read applicable project CLAUDE.md instructions through that tool before editing. Do not assume the controller has project files or credentials."
      : "Read applicable project CLAUDE.md instructions before editing. The CoCalc skill is at /home/user/.claude/skills/cocalc/SKILL.md; use it for CoCalc-native workflows. The scoped CoCalc CLI token is available in the project runtime.";
  return `[CoCalc project context]
This turn runs inside a CoCalc project. The installed CoCalc CLI is:
${COCALC_CLI}
${projectGuidance}
${request.runtime ? `Project working directory for this turn: ${JSON.stringify(request.runtime.profile.cwd)}. Use this directory for project commands unless the task requires another directory.` : ""}
${request.harness_credential?.mode === "account-subscription" ? CLAUDE_PROJECT_JOB_GUIDANCE : ""}
${request.harness_credential?.mode === "account-subscription" ? "Use request_user_input_async on the project tools server for clarification when useful independent work can continue. It saves a question card and returns immediately; the answer arrives as a new user message. Continue working without polling, and incorporate the answer when it arrives. Use blocking questions only when the answer is required before any useful work. Never use questions for secrets, authentication or permission escalation." : ""}
${request.harness_credential?.mode === "account-subscription" ? "To look at an image saved in the project (a screenshot, plot or rendered page), use project_read_image instead of describing or measuring it indirectly." : ""}
${cocalcAccessGuidance(COCALC_CLI)}
Complete foreground work before ending the turn. CoCalc cannot wake a completed turn when a background command finishes; do not promise a later notification.
Use the scoped runtime identity and credentials already provided in the environment. Do not fall back to account credentials when a scoped operation fails.
Current turn publication context (non-secret metadata, not an authorization grant):
${JSON.stringify(context)}
Use these exact values as explicit --project, --path, --thread-id, and --message-date arguments when publishing an artifact; never infer the producing message from history or reuse a prior turn's timestamp.
${publication}${request.agent_memory_context ? `\n${request.agent_memory_context}` : ""}
[/CoCalc project context]

${request.prompt}`;
}

// Joins optional blocks of per-turn prompt context.
export function joinTurnContext(
  ...parts: unknown[]
): string | undefined {
  const text = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}
