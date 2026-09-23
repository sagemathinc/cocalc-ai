export interface PersonalLibraryTarget {
  project_id: string;
  entry_id: string;
}

export interface PersonalLibraryAlias extends PersonalLibraryTarget {
  name: string;
  active: boolean;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ENTRY = /^[a-f0-9]{64}$/;
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function normalizePersonalLibraryName(input: string): string {
  if (typeof input !== "string") throw Error("Invalid artifact name");
  const name = input.trim().toLowerCase();
  if (!NAME.test(name))
    throw Error(
      "Use 1-32 lowercase letters, numbers, or internal hyphens, starting with a letter.",
    );
  return name;
}

export function validatePersonalLibraryTarget(
  target: PersonalLibraryTarget,
): void {
  if (!target || !UUID.test(target.project_id) || !ENTRY.test(target.entry_id))
    throw Error("Invalid artifact identity");
}

export function validatePersonalLibraryPinKey(value: string): string {
  if (typeof value !== "string" || value.length > 4096)
    throw Error("Invalid artifact pin");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Error("Invalid artifact pin");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    typeof parsed[0] !== "string" ||
    !UUID.test(parsed[0]) ||
    parsed
      .slice(1)
      .some(
        (part) =>
          typeof part !== "string" || !part.length || part.length > 2048,
      )
  )
    throw Error("Invalid artifact pin");
  return JSON.stringify(parsed);
}

export function normalizeLegacyPersonalLibraryAliases(
  value: unknown,
): PersonalLibraryAlias[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  const activeTargets = new Set<string>();
  const result: PersonalLibraryAlias[] = [];
  for (const raw of value.slice(0, 1000)) {
    try {
      const alias = raw as PersonalLibraryAlias;
      const name = normalizePersonalLibraryName(alias.name);
      validatePersonalLibraryTarget(alias);
      if (names.has(name) || typeof alias.active !== "boolean") continue;
      const key = `${alias.project_id}/${alias.entry_id}`;
      if (alias.active && activeTargets.has(key)) continue;
      names.add(name);
      if (alias.active) activeTargets.add(key);
      result.push({
        name,
        project_id: alias.project_id,
        entry_id: alias.entry_id,
        active: alias.active,
      });
    } catch {
      /* Ignore malformed legacy preferences. */
    }
  }
  return result;
}

export function movePersonalLibraryPin(
  pins: string[],
  visible: string[],
  pinKey: string,
  index: number,
): string[] {
  const visibleSet = new Set(visible);
  const ordered = pins.filter((pin) => visibleSet.has(pin));
  const from = ordered.indexOf(pinKey);
  if (from < 0 || index < 0 || index >= ordered.length) return pins;
  ordered.splice(from, 1);
  ordered.splice(index, 0, pinKey);
  let cursor = 0;
  return pins.map((pin) => (visibleSet.has(pin) ? ordered[cursor++] : pin));
}

export function normalizeLegacyPersonalLibraryPins(value: unknown): string[] {
  try {
    const plain = (value as any)?.toJS?.() ?? value;
    const parsed = typeof plain === "string" ? JSON.parse(plain) : plain;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((item): item is string => {
          try {
            validatePersonalLibraryPinKey(item);
            return true;
          } catch {
            return false;
          }
        }),
      ),
    ].slice(0, 1000);
  } catch {
    return [];
  }
}
