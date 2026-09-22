import { useEffect, useRef, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";

export const ARTIFACT_PINS_SETTING = "artifact_pins_v1";

export function normalizeArtifactPins(value: unknown): string[] {
  try {
    const plain = (value as any)?.toJS?.() ?? value;
    const parsed = typeof plain === "string" ? JSON.parse(plain) : plain;
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter((id): id is string => typeof id === "string"),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

/** Reorder only visible slots; pins in other threads/filters keep their positions. */
export function moveVisibleArtifactPin(
  pins: string[],
  visible: string[],
  id: string,
  index: number,
): string[] {
  const ordered = pins.filter((pin) => visible.includes(pin));
  const from = ordered.indexOf(id);
  if (from < 0 || index < 0 || index >= ordered.length) return pins;
  ordered.splice(from, 1);
  ordered.splice(index, 0, id);
  let cursor = 0;
  return pins.map((pin) => (visible.includes(pin) ? ordered[cursor++] : pin));
}

// Serialize writes across simultaneously mounted chat surfaces. Read the latest
// account setting inside the queue so one room cannot overwrite another's pins.
let saveQueue: Promise<void> = Promise.resolve();

export function useArtifactPins() {
  const accountId = useTypedRedux("account", "account_id");
  const settings = useTypedRedux("account", "other_settings");
  const persisted = normalizeArtifactPins(
    settings?.get?.(ARTIFACT_PINS_SETTING),
  );
  const [optimistic, setOptimistic] = useState<{
    accountId: string;
    pins: string[];
  }>();
  const [error, setError] = useState("");
  const pending = useRef(0);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setOptimistic(undefined);
    setError("");
  }, [accountId]);
  const latest = useRef(persisted);
  const pins =
    optimistic && optimistic.accountId === accountId
      ? optimistic.pins
      : persisted;
  latest.current = pins;

  function change(update: (pins: string[]) => string[]) {
    if (!accountId) return;
    const started = generation.current;
    const next = update(latest.current);
    latest.current = next;
    setOptimistic({ accountId, pins: next });
    setError("");
    pending.current++;
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        const store = redux.getStore("account");
        if (
          generation.current !== started ||
          store?.get("account_id") !== accountId
        )
          throw Error("Account changed");
        const current = normalizeArtifactPins(
          store.get("other_settings")?.get(ARTIFACT_PINS_SETTING),
        );
        // JSON is a scalar: recursive account-setting merges must not retain unpinned entries.
        await redux
          .getActions("account")
          .set_other_settings_and_wait(
            ARTIFACT_PINS_SETTING,
            JSON.stringify(update(current)),
          );
      })
      .catch(() => {
        if (
          generation.current === started &&
          redux.getStore("account")?.get("account_id") === accountId
        )
          setError("Unable to save artifact pins. Please try again.");
      })
      .finally(() => {
        pending.current--;
        if (!pending.current) setOptimistic(undefined);
      });
  }

  return {
    pins,
    error,
    canPin: !!accountId,
    setPinned(id: string, pinned: boolean) {
      change((pins) =>
        pinned
          ? [...pins.filter((pin) => pin !== id), id]
          : pins.filter((pin) => pin !== id),
      );
    },
    move(visible: string[], id: string, index: number) {
      change((pins) => moveVisibleArtifactPin(pins, visible, id, index));
    },
  };
}
