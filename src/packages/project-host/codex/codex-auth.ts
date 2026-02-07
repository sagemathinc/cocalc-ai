import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:codex-auth");

export type CodexAuthSource =
  | "subscription"
  | "project-api-key"
  | "account-api-key"
  | "site-api-key"
  | "shared-home";

export type CodexAuthRuntime = {
  source: CodexAuthSource;
  contextId: string;
  codexHome?: string;
  env: Record<string, string>;
};

type SharedHomeMode = "fallback" | "prefer" | "always";

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseMap(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const key in parsed) {
      const val = parsed[key];
      if (typeof val === "string" && val.trim()) {
        out[key] = val.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveSharedHomeMode(): SharedHomeMode {
  const mode = `${process.env.COCALC_CODEX_AUTH_SHARED_HOME_MODE ?? "fallback"}`
    .trim()
    .toLowerCase();
  if (mode === "prefer" || mode === "always") return mode;
  return "fallback";
}

async function sharedHomeHasAuth(sharedHome?: string): Promise<boolean> {
  if (!sharedHome) return false;
  return await pathExists(join(sharedHome, "auth.json"));
}

function sharedHomeRuntime({
  projectId,
  accountId,
  sharedHome,
}: {
  projectId: string;
  accountId?: string;
  sharedHome?: string;
}): CodexAuthRuntime {
  return {
    source: "shared-home",
    contextId: hashText(
      `shared-home:${projectId}:${accountId ?? ""}:${sharedHome ?? ""}`,
    ).slice(0, 16),
    codexHome: sharedHome,
    env: {},
  };
}

export function resolveSubscriptionCodexHome(accountId: string): string | undefined {
  const subscriptionRoot = process.env.COCALC_CODEX_AUTH_SUBSCRIPTION_HOME_ROOT;
  if (!subscriptionRoot) return undefined;
  return join(subscriptionRoot, accountId);
}

export function subscriptionRuntime({
  projectId,
  accountId,
  codexHome,
}: {
  projectId: string;
  accountId: string;
  codexHome?: string;
}): CodexAuthRuntime {
  return {
    source: "subscription",
    contextId: hashText(`subscription:${projectId}:${accountId}`).slice(0, 16),
    codexHome,
    env: {},
  };
}

const CODEX_CREDENTIAL_STORE_SETTING = 'cli_auth_credentials_store = "file"';

function upsertCredentialStoreSetting(configToml: string): string {
  const settingPattern =
    /^(?!\s*#)\s*cli_auth_credentials_store\s*=\s*.*$/m;
  if (settingPattern.test(configToml)) {
    return configToml.replace(settingPattern, CODEX_CREDENTIAL_STORE_SETTING);
  }
  if (!configToml.trim()) {
    return `${CODEX_CREDENTIAL_STORE_SETTING}\n`;
  }
  const suffix = configToml.endsWith("\n") ? "" : "\n";
  return `${configToml}${suffix}${CODEX_CREDENTIAL_STORE_SETTING}\n`;
}

export async function ensureCodexCredentialsStoreFile(
  codexHome: string,
): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const configPath = join(codexHome, "config.toml");
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    raw = "";
  }
  const updated = upsertCredentialStoreSetting(raw);
  if (updated === raw) return;
  await fs.writeFile(configPath, updated, { mode: 0o600 });
}

export async function resolveCodexAuthRuntime({
  projectId,
  accountId,
}: {
  projectId: string;
  accountId?: string;
}): Promise<CodexAuthRuntime> {
  const sharedHome = resolveSharedCodexHome();
  const sharedHomeMode = resolveSharedHomeMode();
  const hasSharedHomeAuth = await sharedHomeHasAuth(sharedHome);
  if (
    sharedHomeMode === "always" ||
    (sharedHomeMode === "prefer" && hasSharedHomeAuth)
  ) {
    return sharedHomeRuntime({ projectId, accountId, sharedHome });
  }

  const projectKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEYS_JSON,
  );
  const accountKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEYS_JSON,
  );
  const projectKey =
    projectKeys[projectId] ?? process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEY;
  const accountKey =
    (accountId ? accountKeys[accountId] : undefined) ??
    process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEY;
  const siteKey = process.env.COCALC_CODEX_AUTH_SITE_OPENAI_KEY;

  if (accountId) {
    const codexHome = resolveSubscriptionCodexHome(accountId);
    if (codexHome) {
      const authFile = join(codexHome, "auth.json");
      if (await pathExists(authFile)) {
        try {
          await ensureCodexCredentialsStoreFile(codexHome);
        } catch (err) {
          logger.warn("failed to ensure codex file credential store setting", {
            projectId,
            accountId,
            codexHome,
            err: `${err}`,
          });
        }
        return subscriptionRuntime({ projectId, accountId, codexHome });
      }
    }
  }

  if (projectKey) {
    return {
      source: "project-api-key",
      contextId: hashText(`project-key:${projectId}:${hashText(projectKey)}`).slice(
        0,
        16,
      ),
      env: { OPENAI_API_KEY: projectKey },
    };
  }

  if (accountKey) {
    return {
      source: "account-api-key",
      contextId: hashText(
        `account-key:${projectId}:${accountId ?? ""}:${hashText(accountKey)}`,
      ).slice(0, 16),
      env: { OPENAI_API_KEY: accountKey },
    };
  }

  if (siteKey) {
    return {
      source: "site-api-key",
      contextId: hashText(`site-key:${projectId}:${hashText(siteKey)}`).slice(
        0,
        16,
      ),
      env: { OPENAI_API_KEY: siteKey },
    };
  }

  return sharedHomeRuntime({ projectId, accountId, sharedHome });
}

export function resolveSharedCodexHome(): string | undefined {
  const codexHome =
    process.env.COCALC_CODEX_HOME ??
    (process.env.HOME ? join(process.env.HOME, ".codex") : "/root/.codex");
  return codexHome;
}

export function redactCodexAuthRuntime(runtime: CodexAuthRuntime): Record<string, unknown> {
  return {
    source: runtime.source,
    contextId: runtime.contextId,
    codexHome: runtime.codexHome,
    envKeys: Object.keys(runtime.env ?? {}),
  };
}

export function logResolvedCodexAuthRuntime(
  projectId: string,
  accountId: string | undefined,
  runtime: CodexAuthRuntime,
): void {
  logger.debug("resolved codex auth runtime", {
    projectId,
    accountId,
    ...redactCodexAuthRuntime(runtime),
  });
}
