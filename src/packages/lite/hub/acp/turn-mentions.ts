import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type { ArtifactCatalogApi } from "@cocalc/conat/hub/api/artifact-catalog";
import { extractArtifactMentions } from "@cocalc/util/artifact-mentions";
import {
  agentMentionReferenceMap,
  extractAgentMentions,
} from "@cocalc/util/agent-mentions";

export async function resolveHumanTurnMentions(
  request: AcpRequest,
  api: Pick<AgentApi, "getMentionIdentity">,
) {
  // Never bind history, scheduled/model-authored content, or an old turn's map.
  if (request.chat?.agent_message || request.chat?.automation_id) return [];
  const text = request.chat?.user_message_content ?? "";
  const references = Object.values(
    agentMentionReferenceMap(extractAgentMentions(text)),
  );
  if (references.length > 32)
    throw new Error("Too many bound agent references");
  for (const reference of references) {
    // Validate copied references under the submitting human, not the naming
    // account embedded in the markup. Exact owner routing starts no target.
    const identity = await api.getMentionIdentity({
      account_id: request.account_id,
      project_id: request.chat?.project_id ?? request.project_id!,
      target: reference.target,
    });
    if (
      identity.disabled_at ||
      identity.agent_id !== reference.target.agent_id ||
      identity.project_id !== reference.target.project_id
    ) {
      throw new Error(`Agent reference @${reference.name} is unavailable`);
    }
  }
  return references;
}

export async function resolveHumanTurnArtifactMentions(
  request: AcpRequest,
  api: Pick<ArtifactCatalogApi, "getEntry">,
) {
  if (request.chat?.agent_message || request.chat?.automation_id) return [];
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
