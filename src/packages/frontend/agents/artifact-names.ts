import { usePersonalLibrary } from "./personal-library";

export const ARTIFACT_NAMES_SETTING = "artifact_names_v1";
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ENTRY = /^[a-f0-9]{64}$/;

export interface NamedArtifact {
  name: string;
  project_id: string;
  entry_id: string;
  active: boolean;
}

export function normalizeArtifactName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!NAME.test(name))
    throw Error(
      "Use 1-32 lowercase letters, numbers, or internal hyphens, starting with a letter.",
    );
  return name;
}

export function readArtifactNames(value: unknown): NamedArtifact[] {
  try {
    const plain = (value as any)?.toJS?.() ?? value;
    const parsed = typeof plain === "string" ? JSON.parse(plain) : plain;
    if (!Array.isArray(parsed)) return [];
    const names = new Set<string>();
    return parsed.filter((item): item is NamedArtifact => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.name !== "string" ||
        !NAME.test(item.name) ||
        !UUID.test(item.project_id) ||
        !ENTRY.test(item.entry_id) ||
        typeof item.active !== "boolean" ||
        names.has(item.name)
      )
        return false;
      names.add(item.name);
      return true;
    });
  } catch {
    return [];
  }
}

export function nameArtifact(
  names: NamedArtifact[],
  target: Pick<NamedArtifact, "project_id" | "entry_id">,
  input: string,
): NamedArtifact[] {
  const name = normalizeArtifactName(input);
  const existing = names.find((item) => item.name === name);
  if (
    existing &&
    (existing.project_id !== target.project_id ||
      existing.entry_id !== target.entry_id)
  )
    throw Error(`@${name} is already used by another artifact.`);
  if (!existing && names.length >= 1000)
    throw Error("Artifact name limit reached.");
  const next = names.map((item) =>
    item.project_id === target.project_id && item.entry_id === target.entry_id
      ? { ...item, active: item.name === name }
      : item,
  );
  if (!existing) next.push({ ...target, name, active: true });
  return next;
}

export function useArtifactNames() {
  const library = usePersonalLibrary();
  return {
    names: library.aliases,
    error: library.error,
    loading: library.loading,
    resolve: library.resolve,
    setName(
      target: Pick<NamedArtifact, "project_id" | "entry_id">,
      input: string,
    ) {
      return library.setName(
        target.project_id,
        target.entry_id,
        normalizeArtifactName(input),
      );
    },
  };
}
