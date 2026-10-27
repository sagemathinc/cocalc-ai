/** An agent on another site, a member of the person's Agent Networks. */
export interface ExternalAgentMentionTarget {
  kind: "external";
  account_id: string;
  agent_id: string;
  installation_id: string;
}

export type AgentMentionTarget =
  | { project_id: string; agent_id: string }
  | ExternalAgentMentionTarget;

/** A bound reference is identity metadata, never a communication capability. */
export interface AgentMentionReference {
  version: 1;
  naming_account_id: string;
  target: AgentMentionTarget;
  name: string;
}

export function isExternalMentionTarget(
  target: AgentMentionTarget,
): target is ExternalAgentMentionTarget {
  return (target as ExternalAgentMentionTarget).kind === "external";
}

/** The same target, however its UUIDs are spelled. */
export function agentMentionTargetKey(target: AgentMentionTarget): string {
  return isExternalMentionTarget(target)
    ? `external:${target.account_id}/${target.agent_id}/${target.installation_id}`.toLowerCase()
    : `${target.project_id}/${target.agent_id}`.toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function mentionTarget(value: unknown): AgentMentionTarget | undefined {
  if (!value || typeof value !== "object") return;
  const t = value as Record<string, unknown>;
  if (t.kind === "external")
    return uuid(t.account_id) && uuid(t.agent_id) && uuid(t.installation_id)
      ? {
          kind: "external",
          account_id: t.account_id,
          agent_id: t.agent_id,
          installation_id: t.installation_id,
        }
      : undefined;
  if (t.kind !== undefined) return;
  return uuid(t.project_id) && uuid(t.agent_id)
    ? { project_id: t.project_id, agent_id: t.agent_id }
    : undefined;
}

export function agentMentionReference(
  value: unknown,
): AgentMentionReference | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as AgentMentionReference;
  const target = mentionTarget(v.target);
  if (
    v.version !== 1 ||
    !uuid(v.naming_account_id) ||
    !target ||
    typeof v.name !== "string" ||
    !NAME.test(v.name)
  )
    return;
  return {
    version: 1,
    naming_account_id: v.naming_account_id,
    target,
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
      agentMentionTargetKey(previous.target) !==
        agentMentionTargetKey(reference.target)
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
  const external = validatedReferences.some((reference) =>
    isExternalMentionTarget(reference.target),
  );
  return `${prompt}\n\nBound agent references for this human turn (identity only, not send permission):\n${JSON.stringify(agentMentionReferenceMap(validatedReferences))}\nUse these exact endpoints rather than guessing from names or history. Communication authorization is checked at send time. Selecting a reference does not send a message.${external ? ' A target of kind "external" is an agent on another site, a member of a shared Agent Network: send to it by its @name with `cocalc agent send`. Its message waits in its inbox; no turn starts there.' : ""}`;
}
