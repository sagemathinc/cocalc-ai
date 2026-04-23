import { URL } from "node:url";
import getLogger from "@cocalc/backend/logger";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import { isValidUUID } from "@cocalc/util/misc";
import { hubApi } from "../api";

const logger = getLogger("lite:hub:acp:runtime-env");

const RUNTIME_AUTH_ENV_KEYS = new Set([
  "COCALC_ACCOUNT_ID",
  "COCALC_AGENT_TOKEN",
  "COCALC_API_URL",
  "COCALC_BEARER_TOKEN",
  "COCALC_BROWSER_ID",
  "COCALC_CLI_AGENT_MODE",
  "COCALC_PROJECT_ID",
]);

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function normalizeApiUrl(
  raw: string,
  { rewriteLoopbackHost }: { rewriteLoopbackHost: boolean },
): string | undefined {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) return;
  try {
    const parsed = new URL(trimmed);
    if (rewriteLoopbackHost && isLoopbackHostname(parsed.hostname)) {
      parsed.hostname = "host.containers.internal";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

export function resolveCodexApiUrl({
  useContainer,
  request,
}: {
  useContainer: boolean;
  request?: AcpRequest;
}): string {
  const explicit =
    `${process.env.COCALC_API_URL ?? process.env.BASE_URL ?? ""}`.trim();
  const masterConat =
    `${process.env.MASTER_CONAT_SERVER ?? process.env.COCALC_MASTER_CONAT_SERVER ?? ""}`.trim();
  const browserOrigin = `${request?.chat?.api_url ?? ""}`.trim();

  if (useContainer) {
    const containerPreferred = normalizeApiUrl(masterConat, {
      rewriteLoopbackHost: true,
    });
    if (containerPreferred) return containerPreferred;

    const explicitContainer = normalizeApiUrl(explicit, {
      rewriteLoopbackHost: true,
    });
    if (explicitContainer) return explicitContainer;

    const browserFallback = normalizeApiUrl(browserOrigin, {
      rewriteLoopbackHost: false,
    });
    if (browserFallback) return browserFallback;

    const port = `${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`.trim();
    return `http://host.containers.internal:${port || "9100"}`;
  }

  const browserLocal = normalizeApiUrl(browserOrigin, {
    rewriteLoopbackHost: false,
  });
  if (browserLocal) return browserLocal;

  const explicitLocal = normalizeApiUrl(explicit, {
    rewriteLoopbackHost: false,
  });
  if (explicitLocal) return explicitLocal;

  const port = `${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`.trim();
  return `http://localhost:${port || "9100"}`;
}

async function resolveCodexRuntimeBearer({
  request,
  projectId,
}: {
  request: AcpRequest;
  projectId: string;
}): Promise<string | undefined> {
  const directBearer =
    `${process.env.COCALC_BEARER_TOKEN ?? ""}`.trim() ||
    `${process.env.COCALC_AGENT_TOKEN ?? ""}`.trim();
  if (directBearer) {
    return directBearer;
  }

  const accountId =
    `${request.account_id ?? ""}`.trim() ||
    `${request.runtime_env?.COCALC_ACCOUNT_ID ?? ""}`.trim();
  if (!isValidUUID(accountId) || !isValidUUID(projectId)) {
    return;
  }
  const issueAgentToken = hubApi.hosts?.issueProjectHostAgentAuthToken;
  if (typeof issueAgentToken !== "function") {
    return;
  }
  try {
    const issued = await issueAgentToken({
      account_id: accountId,
      project_id: projectId,
    });
    const token = `${issued?.token ?? ""}`.trim();
    return token || undefined;
  } catch (err) {
    logger.debug("failed to issue project-host agent auth token", {
      account_id: accountId,
      project_id: projectId,
      err: `${err}`,
    });
    return;
  }
}

export async function buildCodexRuntimeEnv({
  request,
  projectId,
  includeCliBin,
  useContainer,
}: {
  request: AcpRequest;
  projectId: string;
  includeCliBin: boolean;
  useContainer: boolean;
}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (request.runtime_env) {
    for (const [key, value] of Object.entries(request.runtime_env)) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (normalized && !RUNTIME_AUTH_ENV_KEYS.has(key)) {
        out[key] = normalized;
      }
    }
  }
  const accountId =
    `${request.account_id ?? ""}`.trim() ||
    `${request.runtime_env?.COCALC_ACCOUNT_ID ?? ""}`.trim();
  if (accountId) out.COCALC_ACCOUNT_ID = accountId;
  if (projectId) out.COCALC_PROJECT_ID = projectId;
  const browserId = `${request.chat?.browser_id ?? ""}`.trim();
  if (browserId) out.COCALC_BROWSER_ID = browserId;
  out.COCALC_API_URL = resolveCodexApiUrl({
    useContainer,
    request,
  });
  out.COCALC_CLI_AGENT_MODE = "1";
  const bearer = await resolveCodexRuntimeBearer({
    request,
    projectId,
  });
  if (bearer) {
    out.COCALC_BEARER_TOKEN = bearer;
    out.COCALC_AGENT_TOKEN = bearer;
  }
  if (includeCliBin) {
    const cliCommand = `${process.env.COCALC_CLI_CMD ?? ""}`.trim();
    if (cliCommand) out.COCALC_CLI_CMD = cliCommand;
    const cliBin = `${process.env.COCALC_CLI_BIN ?? ""}`.trim();
    if (cliBin) out.COCALC_CLI_BIN = cliBin;
    if (!out.COCALC_CLI_CMD && cliBin) {
      out.COCALC_CLI_CMD = `"${cliBin}"`;
    }
  }
  return out;
}
