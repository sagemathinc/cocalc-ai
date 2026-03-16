export type LiteCodexBackend = "exec" | "app-server";

export function getConfiguredCodexBackend(
  env: NodeJS.ProcessEnv = process.env,
): LiteCodexBackend {
  const explicit = `${env.COCALC_ACP_CODEX_BACKEND ?? ""}`.trim().toLowerCase();
  if (explicit === "exec") {
    return "exec";
  }
  if (explicit === "app-server") {
    return "app-server";
  }
  // Default Lite and Launchpad to the same execution primitive. The older
  // exec backend remains as an explicit fallback for debugging and migration.
  return "app-server";
}
