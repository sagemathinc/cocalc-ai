import { readFile } from "node:fs/promises";
import {
  validateAgentEndpoint,
  type AgentEndpoint,
  type AgentRpcLink,
} from "@cocalc/conat/agents/rpc";
import { readIdentityCredential, sendIdentityMessage } from "./agent-message";

export interface AgentNameBinding {
  name: string;
  target: AgentEndpoint;
}

export function resolveAgentName(
  input: string,
  destinations: (AgentRpcLink & { target_name?: string })[],
  references: AgentNameBinding[] = [],
): AgentEndpoint {
  const name = input.trim().replace(/^@/, "");
  if (!/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name))
    throw new Error("Use an exact lowercase agent name, such as reviewer");
  // A selected mention remains pinned even if the account directory changes.
  const selected = references.filter((ref) => ref.name === name);
  if (!selected.length) {
    const renamed = destinations.find((link) =>
      link.target_retired_names?.includes(name),
    );
    if (renamed)
      throw new Error(
        `name_renamed: @${name} is now @${renamed.target_name}; no message was sent`,
      );
  }
  const matches = selected.length
    ? selected.map((ref) => ref.target)
    : destinations
        .filter((link) => link.target_name === name)
        .map((link) => link.target);
  if (!matches.length)
    throw new Error(
      `No approved destination or current-turn mention named @${name}. Discover destinations or select the agent in the human composer; no message was sent.`,
    );
  for (const target of matches) validateAgentEndpoint(target);
  const first = matches[0];
  if (
    matches.some(
      (target) =>
        target.agent_id !== first.agent_id ||
        target.project_id !== first.project_id,
    )
  )
    throw new Error(`Ambiguous agent reference @${name}; no message was sent`);
  return first;
}

export async function readTurnAgentReferences(): Promise<AgentNameBinding[]> {
  const path = process.env.COCALC_AGENT_MENTION_REFERENCES_FILE;
  if (!path) return [];
  const credential = await readIdentityCredential();
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    value?.agent_id !== credential.agent_id ||
    value?.run_id !== credential.run_id ||
    !Array.isArray(value.references) ||
    value.references.length > 100
  )
    throw new Error("Agent mention references do not match this runtime turn");
  for (const ref of value.references) {
    if (typeof ref?.name !== "string")
      throw new Error("Invalid runtime agent name reference");
    validateAgentEndpoint(ref.target);
  }
  return value.references;
}

export async function resolveRuntimeAgentName(
  name: string,
  apiUrl?: string,
): Promise<AgentEndpoint> {
  const references = await readTurnAgentReferences();
  // Pinned references can request renewal without an active discovery result.
  if (references.some((ref) => ref.name === name.trim().replace(/^@/, "")))
    return resolveAgentName(name, [], references);
  const destinations = (await sendIdentityMessage(
    { version: 2, action: "destinations" },
    apiUrl,
  )) as AgentRpcLink[];
  return resolveAgentName(name, destinations, references);
}
