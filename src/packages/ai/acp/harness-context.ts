import type { AcpEvaluateRequest } from "./types";

/** Retained harness processes cannot receive updated per-turn environment values. */
export function harnessPrompt(
  request: Pick<AcpEvaluateRequest, "prompt" | "project_id" | "chat">,
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
  return `[CoCalc project context]
This turn runs inside a CoCalc project. The installed CoCalc CLI is:
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"
Use the scoped runtime identity and credentials already provided in the environment. Do not fall back to account credentials when a scoped operation fails.
Current turn publication context (non-secret metadata, not an authorization grant):
${JSON.stringify(context)}
Use these exact values as explicit --project, --path, --thread-id, and --message-date arguments when publishing an artifact; never infer the producing message from history or reuse a prior turn's timestamp.
Use ordinary text and file links by default. If the user explicitly asks for an artifact, inspect project chat artifact publish --help and use its explicit --experimental opt-in. Verify the returned publication before claiming success. File creation or a normal file link alone is not artifact publication. If the command is unavailable or fails, report the failure and offer a normal file link; do not write .chat files directly. Publishing a proposed action does not approve or execute it.
[/CoCalc project context]

${request.prompt}`;
}
