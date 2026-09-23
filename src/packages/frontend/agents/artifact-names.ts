import { useEffect, useRef, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";

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

let saveQueue: Promise<void> = Promise.resolve();

export function useArtifactNames() {
  const accountId = useTypedRedux("account", "account_id");
  const settings = useTypedRedux("account", "other_settings");
  const persisted = readArtifactNames(settings?.get?.(ARTIFACT_NAMES_SETTING));
  const [optimistic, setOptimistic] = useState<{
    accountId: string;
    names: NamedArtifact[];
  }>();
  const [error, setError] = useState("");
  const pending = useRef(0);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setOptimistic(undefined);
    setError("");
  }, [accountId]);
  const names =
    optimistic && optimistic.accountId === accountId
      ? optimistic.names
      : persisted;
  const latest = useRef(names);
  latest.current = names;

  async function setName(
    target: Pick<NamedArtifact, "project_id" | "entry_id">,
    input: string,
  ) {
    if (!accountId) throw Error("Sign in to name an artifact.");
    const next = nameArtifact(latest.current, target, input);
    const started = generation.current;
    latest.current = next;
    setOptimistic({ accountId, names: next });
    setError("");
    pending.current++;
    const save = saveQueue
      .catch(() => {})
      .then(async () => {
        const store = redux.getStore("account");
        if (
          generation.current !== started ||
          store?.get("account_id") !== accountId
        )
          throw Error("Account changed");
        const current = readArtifactNames(
          store.get("other_settings")?.get(ARTIFACT_NAMES_SETTING),
        );
        await redux
          .getActions("account")
          .set_other_settings_and_wait(
            ARTIFACT_NAMES_SETTING,
            JSON.stringify(nameArtifact(current, target, input)),
          );
      });
    saveQueue = save.then(
      () => {},
      () => {},
    );
    try {
      await save;
    } catch (err) {
      if (generation.current === started) setError(String(err));
      throw err;
    } finally {
      pending.current--;
      if (!pending.current) setOptimistic(undefined);
    }
  }
  return { names, error, setName };
}
