/**
 * Merge approvals from an agent: ask an approver to approve the merge of one
 * exact pull-request head, and publish the card where they decide.  The hub
 * reads the PR from GitHub and records the request; the card holds only its
 * id.
 */
import { readFile } from "node:fs/promises";
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";
import { chatTarget, publishCardOnce } from "./chat-card";

// The hub's limit; checked here too so a long note fails before the call.
const MAX_NOTE_BYTES = 8 * 1024;

async function readNote(file?: string): Promise<string | undefined> {
  if (!file) return undefined;
  let note: string;
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    note = Buffer.concat(chunks).toString("utf8");
  } else {
    note = await readFile(file, "utf8");
  }
  if (Buffer.byteLength(note) > MAX_NOTE_BYTES) {
    throw Error(`the note is longer than ${MAX_NOTE_BYTES} bytes`);
  }
  return note;
}

export function registerChatMergeApprovalCommands(
  chat: Command,
  deps: Pick<ProjectCommandDeps, "withContext" | "projectChatArtifactData">,
): void {
  const mergeApproval = chat
    .command("merge-approval")
    .description(
      "ask an approver to approve the merge of an exact pull-request head (agent sessions)",
    );

  mergeApproval
    .command("request")
    .description(
      "request approval of a PR's current head and publish the approval card in the current chat turn",
    )
    .requiredOption("--repo <owner/name>", "GitHub repository")
    .requiredOption("--pr <number>", "pull request number")
    .requiredOption(
      "--head <sha>",
      "the full 40-character head commit SHA; refused unless it is the PR's current head",
    )
    .option(
      "--note-file <path>",
      "a note for the approver (at most 8 KiB; shown as yours); - for stdin",
    )
    .option("--agent-label <name>", "what the card calls you, e.g. @ops3")
    .option("-w, --project <project>", "project of the chat")
    .option("--path <path>", "chat path (defaults to COCALC_CODEX_CHAT_PATH)")
    .option(
      "--thread-id <id>",
      "originating thread (defaults to COCALC_CODEX_THREAD_ID)",
    )
    .option(
      "--message-date <date>",
      "exact producing timestamp (defaults to COCALC_CODEX_MESSAGE_DATE)",
    )
    .action(async (opts, command: Command) => {
      await deps.withContext(
        command,
        "project chat merge-approval request",
        async (ctx) => {
          const target = chatTarget(opts);
          if (!target) {
            throw Error(
              "pass --path, --thread-id and --message-date for the current chat turn: the approver decides on the card there",
            );
          }
          const note = await readNote(opts.noteFile);
          const request = await ctx.hub.mergeApprovals.request({
            repo: opts.repo,
            pr_number: Number(opts.pr),
            head_sha: opts.head,
            ...(note == null ? {} : { note }),
            ...(opts.agentLabel ? { agent_label: opts.agentLabel } : {}),
            chat: {
              path: target.path,
              thread_id: target.threadId,
              message_date: target.messageDate,
            },
          });
          const card = await publishCardOnce({
            deps,
            ctx,
            projectId: opts.project ?? process.env.COCALC_PROJECT_ID,
            chat: target,
            matches: (artifact) =>
              artifact?.merge_approval?.request_ids?.includes(request.id),
            // Every reader of the chat sees the publication, approvers or
            // not: only the opaque request id goes in it. The card shows
            // the details to approvers, from the hub.
            payload: {
              title: "Merge approval request",
              markdown: "",
              merge_approval: { request_ids: [request.id] },
            },
          });
          return {
            request_id: request.id,
            status: request.status,
            repo: request.repo,
            pr_number: request.pr_number,
            head_sha: request.head_sha,
            expires_at: request.expires_at,
            artifact_id: card.artifact_id,
            card_reused: card.reused,
          };
        },
      );
    });

  mergeApproval
    .command("status <request-id...>")
    .description(
      "status of this project's merge approval requests: pending, approved, rejected, superseded, withdrawn or expired",
    )
    .action(async (ids: string[], _opts, command: Command) => {
      await deps.withContext(
        command,
        "project chat merge-approval status",
        async (ctx) =>
          await ctx.hub.mergeApprovals.status({ request_ids: ids }),
      );
    });
}
