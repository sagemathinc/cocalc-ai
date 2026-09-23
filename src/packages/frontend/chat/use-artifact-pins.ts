import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { usePersonalLibrary } from "@cocalc/frontend/agents/personal-library";

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

export function useArtifactPins() {
  const accountId = useTypedRedux("account", "account_id");
  const library = usePersonalLibrary();

  return {
    pins: library.pins,
    error: library.error,
    canPin: !!accountId,
    setPinned(id: string, pinned: boolean) {
      void library.setPinned(id, pinned).catch(() => {});
    },
    move(visible: string[], id: string, index: number) {
      void library.movePinned(visible, id, index).catch(() => {});
    },
  };
}
