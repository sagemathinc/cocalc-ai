import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type { ArtifactCatalogApi } from "@cocalc/conat/hub/api/artifact-catalog";
import { extractArtifactMentions } from "@cocalc/util/artifact-mentions";
import {
  computerMentionsNote,
  extractComputerMentions,
} from "@cocalc/util/computer-mentions";
import {
  agentMentionReferenceMap,
  extractAgentMentions,
  isExternalMentionTarget,
} from "@cocalc/util/agent-mentions";

type MentionApi = Pick<AgentApi, "getMentionIdentity"> &
  Partial<Pick<AgentApi, "getMentionMember">>;

export async function resolveHumanTurnMentions(
  request: AcpRequest,
  api: MentionApi,
) {
  // Never bind history, model-authored content, or an old turn's map.
  if (request.chat?.agent_message) return [];
  return await resolveHumanAgentMentions(
    request.chat?.user_message_content ?? "",
    {
      account_id: request.account_id,
      project_id: request.chat?.project_id ?? request.project_id!,
    },
    api,
  );
}

/** The agent references a person wrote (a message, or an answer to an
 * agent's question), each checked under that person. */
export async function resolveHumanAgentMentions(
  text: string,
  { account_id, project_id }: { account_id?: string; project_id: string },
  api: MentionApi,
) {
  const references = Object.values(
    agentMentionReferenceMap(extractAgentMentions(text)),
  );
  if (references.length > 32)
    throw new Error("Too many bound agent references");
  for (const reference of references) {
    const target = reference.target;
    if (isExternalMentionTarget(target)) {
      // An agent on another site: it must be a member of one of the
      // submitting human's own Agent Networks.
      const member = await api.getMentionMember?.({
        account_id,
        project_id,
        target: { ...target },
      });
      // A revoked or expired installation can stay a member: unavailable.
      if (!member?.available)
        throw new Error(`Agent reference @${reference.name} is unavailable`);
      continue;
    }
    // Validate copied references under the submitting human, not the naming
    // account embedded in the markup. Exact owner routing starts no target.
    const identity = await api.getMentionIdentity({
      account_id,
      project_id,
      target,
    });
    if (
      identity.disabled_at ||
      identity.agent_id !== target.agent_id ||
      identity.project_id !== target.project_id
    ) {
      throw new Error(`Agent reference @${reference.name} is unavailable`);
    }
  }
  return references;
}

/**
 * What the agent is told when this runtime has no artifact catalog (a
 * project-host's agent worker): the person's @artifact chips are named, and
 * not bound. They grant nothing either way.
 */
export function unresolvedArtifactMentionsNote(request: AcpRequest): string {
  if (request.chat?.agent_message) return "";
  const names = [
    ...new Set(
      extractArtifactMentions(request.chat?.user_message_content ?? "").map(
        (reference) => `@${reference.name}`,
      ),
    ),
  ];
  if (names.length === 0) return "";
  return `The person's message references artifacts (${names.join(", ")}) that this runtime cannot resolve. Treat them as names only: find the artifact with the project chat artifact tools, or ask the person which one they mean.`;
}

/**
 * A human turn's @artifact chips: bound through the catalog where this
 * runtime has one; otherwise (a project-host's agent worker) named to the
 * agent in a note, never a failed turn.
 */
export async function humanTurnArtifacts(
  request: AcpRequest,
  api: Partial<Pick<ArtifactCatalogApi, "getEntry">> | undefined,
): Promise<{
  references: Awaited<ReturnType<typeof resolveHumanTurnArtifactMentions>>;
  note: string;
}> {
  const getEntry = api?.getEntry;
  if (typeof getEntry !== "function")
    return { references: [], note: unresolvedArtifactMentionsNote(request) };
  return {
    references: await resolveHumanTurnArtifactMentions(request, { getEntry }),
    note: "",
  };
}

export async function resolveHumanTurnArtifactMentions(
  request: AcpRequest,
  api: Pick<ArtifactCatalogApi, "getEntry">,
) {
  if (request.chat?.agent_message) return [];
  const projectId = request.chat?.project_id ?? request.project_id;
  if (!projectId) return [];
  const references = extractArtifactMentions(
    request.chat?.user_message_content ?? "",
  );
  if (references.length > 20) throw Error("Too many bound artifact references");
  const result: Array<{
    name: string;
    project_id: string;
    entry_id: string;
    chat_path: string;
    thread_id: string;
    artifact_id: string;
  }> = [];
  for (const reference of references) {
    if (reference.project_id !== projectId)
      throw Error(`Artifact @${reference.name} requires a project connector`);
    const entry = await api.getEntry({
      account_id: request.account_id,
      project_id: projectId,
      entry_id: reference.entry_id,
    });
    if (
      !entry ||
      entry.project_id !== projectId ||
      entry.entry_id !== reference.entry_id
    )
      throw Error(`Artifact @${reference.name} is unavailable`);
    result.push({
      name: reference.name,
      project_id: projectId,
      entry_id: entry.entry_id,
      chat_path: entry.chat_path,
      thread_id: entry.item.thread_id,
      artifact_id: entry.item.artifact_id,
    });
  }
  return result;
}

/**
 * What a human turn's @computer mentions tell the agent. Identity only: the
 * agent's use of a computer is checked when it asks for a ticket.
 */
export function humanTurnComputerNote(request: AcpRequest): string {
  if (request.chat?.agent_message) return "";
  return computerMentionsNote(
    extractComputerMentions(request.chat?.user_message_content ?? ""),
  );
}
