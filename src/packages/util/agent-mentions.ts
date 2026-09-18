/** A bound reference is identity metadata, never a communication capability. */
export interface AgentMentionReference {
  version: 1;
  naming_account_id: string;
  target: { project_id: string; agent_id: string };
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function agentMentionReference(
  value: unknown,
): AgentMentionReference | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as AgentMentionReference;
  if (
    v.version !== 1 ||
    typeof v.naming_account_id !== "string" ||
    !UUID.test(v.naming_account_id) ||
    !v.target ||
    typeof v.target.project_id !== "string" ||
    !UUID.test(v.target.project_id) ||
    typeof v.target.agent_id !== "string" ||
    !UUID.test(v.target.agent_id) ||
    typeof v.name !== "string" ||
    !NAME.test(v.name)
  )
    return;
  return {
    version: 1,
    naming_account_id: v.naming_account_id,
    target: { project_id: v.target.project_id, agent_id: v.target.agent_id },
    name: v.name,
  };
}

export function encodeAgentMentionReference(
  value: AgentMentionReference,
): string {
  const reference = agentMentionReference(value);
  if (!reference) throw new Error("Invalid agent mention reference");
  return encodeURIComponent(JSON.stringify(reference));
}

export function decodeAgentMentionReference(
  value: string,
): AgentMentionReference | undefined {
  if (value.length > 2048) return;
  try {
    return agentMentionReference(JSON.parse(decodeURIComponent(value)));
  } catch {
    return;
  }
}

export function serializeAgentMention(
  reference: AgentMentionReference,
): string {
  return `<span class="agent-mention" data-agent-reference="${encodeAgentMentionReference(reference)}">@${reference.name}</span>`;
}

/** Accept only our distinct, versioned markup, not person mentions or plain names. */
export function parseAgentMention(
  markup: string,
): AgentMentionReference | undefined {
  const match = markup.match(
    /^<span class="agent-mention" data-agent-reference="([^"]+)">@([a-z0-9-]+)<\/span>$/,
  );
  if (!match) return;
  const reference = decodeAgentMentionReference(match[1]);
  return reference?.name === match[2] ? reference : undefined;
}

export function extractAgentMentions(
  markdown: string,
): AgentMentionReference[] {
  const references: AgentMentionReference[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(
    /<span class="agent-mention" data-agent-reference="[^"]{1,2048}">@[a-z0-9-]+<\/span>/g,
  )) {
    const reference = parseAgentMention(match[0]);
    if (!reference) continue;
    const key = encodeAgentMentionReference(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

/** The caller must validate these references for the authenticated human turn first. */
export function agentMentionReferenceMap(
  references: readonly AgentMentionReference[],
): Record<string, AgentMentionReference> {
  const result: Record<string, AgentMentionReference> = {};
  for (const input of references) {
    const reference = agentMentionReference(input);
    if (!reference) throw new Error("Invalid agent mention reference");
    const key = `@${reference.name}`;
    const previous = result[key];
    if (
      previous &&
      (previous.target.project_id !== reference.target.project_id ||
        previous.target.agent_id !== reference.target.agent_id)
    ) {
      throw new Error(
        `Ambiguous agent reference ${key}; select a single destination`,
      );
    }
    result[key] = reference;
  }
  return result;
}

export function augmentPromptWithAgentMentions(
  prompt: string,
  validatedReferences: readonly AgentMentionReference[],
): string {
  if (!validatedReferences.length) return prompt;
  return `${prompt}\n\nBound agent references for this human turn (identity only, not send permission):\n${JSON.stringify(agentMentionReferenceMap(validatedReferences))}\nUse these exact endpoints rather than guessing from names or history. Communication authorization is checked at send time. Selecting a reference does not send a message.`;
}
