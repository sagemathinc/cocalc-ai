/** Private URL names are labels, never identities or access grants. */
export function normalizePrivateAlias(value: string): string {
  if (typeof value !== "string") throw Error("Invalid private alias");
  const alias = value.trim().toLowerCase();
  if (!/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(alias))
    throw Error(
      "Use 1-32 letters, numbers, or internal hyphens, starting with a letter.",
    );
  return alias;
}

export type PrivateAliasKind = "chats" | "people";

export function privateAliasPath(
  kind: PrivateAliasKind,
  alias: string,
): string {
  return `/${kind}/${encodeURIComponent(normalizePrivateAlias(alias))}`;
}

export const PERSON_ALIASES_SETTING = "private_person_aliases_v1";
export const MAX_PERSON_ALIASES = 500;

/** Validate settings on reads as well: older/general settings clients may write them. */
export function personAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > MAX_PERSON_ALIASES)
    throw Error("Too many person aliases");
  const result: Record<string, string> = {};
  for (const [person, alias] of entries) {
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(person) ||
      typeof alias !== "string" ||
      normalizePrivateAlias(alias) !== alias
    )
      throw Error("Invalid stored person alias");
    if (Object.values(result).includes(alias))
      throw Error("Ambiguous stored person alias");
    result[person] = alias;
  }
  return result;
}
