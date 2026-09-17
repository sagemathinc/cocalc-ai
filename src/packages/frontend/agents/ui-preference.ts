export const AGENT_MESSAGING_UI_SETTING = "experimental_agent_messaging";

/** Discoverability only; never use this preference to authorize a send. */
export function agentMessagingUIEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const value = settings as Record<string, any>;
  return (
    (typeof value.get === "function"
      ? value.get(AGENT_MESSAGING_UI_SETTING)
      : value[AGENT_MESSAGING_UI_SETTING]) === true
  );
}
