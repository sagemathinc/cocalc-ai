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
export const PERSONAL_LIBRARY_MAX_PINS = 100;
export const PERSONAL_LIBRARY_MAX_PIN_BYTES = 64 * 1024;

export interface PersonalLibraryPinLocator {
  project_id: string;
  chat_path: string;
  thread_id: string;
  artifact_id: string;
}

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

export function parsePersonalLibraryPinKey(
  value: string,
): PersonalLibraryPinLocator {
  if (typeof value !== "string" || value.length > 4600)
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
    typeof parsed[1] !== "string" ||
    parsed[1].length > 4096 ||
    !parsed[1].startsWith("/") ||
    !parsed[1].endsWith(".chat") ||
    parsed[1]
      .split("/")
      .some(
        (part, index) => index > 0 && (!part || part === "." || part === ".."),
      ) ||
    typeof parsed[2] !== "string" ||
    !parsed[2].length ||
    parsed[2].length > 200 ||
    typeof parsed[3] !== "string" ||
    !parsed[3].length ||
    parsed[3].length > 200
  )
    throw Error("Invalid artifact pin");
  return {
    project_id: parsed[0],
    chat_path: parsed[1],
    thread_id: parsed[2],
    artifact_id: parsed[3],
  };
}

export function validatePersonalLibraryPinKey(value: string): string {
  const { project_id, chat_path, thread_id, artifact_id } =
    parsePersonalLibraryPinKey(value);
  return JSON.stringify([project_id, chat_path, thread_id, artifact_id]);
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
