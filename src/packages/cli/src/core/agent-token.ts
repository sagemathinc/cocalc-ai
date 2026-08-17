import { readFileSync } from "node:fs";

const AGENT_TOKEN_FILE_ENV_KEYS = [
  "COCALC_BEARER_TOKEN_FILE",
  "COCALC_AGENT_TOKEN_FILE",
] as const;

const AGENT_TOKEN_ENV_KEYS = [
  "COCALC_BEARER_TOKEN",
  "COCALC_AGENT_TOKEN",
] as const;

export function resolveAgentTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of AGENT_TOKEN_FILE_ENV_KEYS) {
    const path = `${env[key] ?? ""}`.trim();
    if (!path) continue;
    try {
      const token = readFileSync(path, "utf8").trim();
      if (token) return token;
    } catch {
      // A token rotation may briefly race process startup. Fall back to the
      // inline token when one is available and let authentication report a
      // useful error otherwise.
    }
  }
  for (const key of AGENT_TOKEN_ENV_KEYS) {
    const token = `${env[key] ?? ""}`.trim();
    if (token) return token;
  }
  return;
}
