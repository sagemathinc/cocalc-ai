export const MY_AGENTS_UI_SETTING = "experimental_my_agents_page";

/** Discoverability only; project access and execution remain authoritative. */
export function myAgentsUIEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const value = settings as Record<string, any>;
  return (
    (typeof value.get === "function"
      ? value.get(MY_AGENTS_UI_SETTING)
      : value[MY_AGENTS_UI_SETTING]) === true
  );
}
