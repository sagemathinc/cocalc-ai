/** A canonical human room cannot be converted into an agent invocation surface. */
export function isHumanOnlyChat(rows: Iterable<unknown> | undefined): boolean {
  if (!rows) return false;
  for (const value of rows) {
    if (
      value &&
      typeof value === "object" &&
      (value as { event?: unknown }).event === "collaborators-room"
    )
      return true;
  }
  return false;
}

export function isHumanOnlyChatDocument(
  doc:
    | {
        get?: () => Iterable<unknown>;
        get_one?: (query: { event: string }) => unknown;
      }
    | undefined,
): boolean {
  if (doc?.get) {
    try {
      return isHumanOnlyChat(doc.get());
    } catch (error) {
      if (!doc.get_one) throw error;
    }
  }
  if (doc?.get_one) {
    const marker = doc.get_one({ event: "collaborators-room" });
    return isHumanOnlyChat(marker ? [marker] : undefined);
  }
  return false;
}

export function isHumanOnlyThreadConfig(
  config:
    | { agent_kind?: unknown; acp_config?: unknown; agent_model?: unknown }
    | undefined,
): boolean {
  return (
    config?.agent_kind === "none" && !config.acp_config && !config.agent_model
  );
}

export function assertHumanRoomConfigPatch(
  patch: Record<string, unknown>,
): void {
  if (
    (patch.agent_kind != null && patch.agent_kind !== "none") ||
    patch.acp_config ||
    patch.agent_model ||
    patch.acp_goal_request ||
    patch.automation_config
  ) {
    throw Error(
      "Project conversations are human-only; open an agent to run AI work.",
    );
  }
}
