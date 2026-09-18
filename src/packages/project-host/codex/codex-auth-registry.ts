import { promises as fs } from "node:fs";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { codexAuthJsonToAppServerLogin } from "@cocalc/ai/acp";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";
import { ensureCodexCredentialsStoreFile } from "./codex-auth";

const logger = getLogger("project-host:codex-auth-registry");
const SUBSCRIPTION_CREDENTIAL_SELECTOR = {
  provider: "openai",
  kind: "codex-subscription-auth-json",
  scope: "account" as const,
};
const OPENAI_API_KEY_KIND = "openai-api-key";

type PullResult = {
  pulled: boolean;
  credentialId?: string;
  source?: "registry";
  missing?: boolean;
  skipped?: "local-newer";
  registryUpdatedAt?: string;
};

const existenceCache = new Map<string, { has: boolean; expires: number }>();
const syncedSubscriptionAuthSignatures = new Map<string, string>();
const EXISTENCE_CACHE_TTL_MS = 30_000;
const SITE_OPENAI_KEY_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.COCALC_CODEX_SITE_KEY_CACHE_TTL_MS ?? 60 * 60_000),
);
const SITE_OPENAI_KEY_MISSING_TTL_MS = Math.max(
  30_000,
  Number(process.env.COCALC_CODEX_SITE_KEY_MISSING_TTL_MS ?? 5 * 60_000),
);

let siteOpenAiKeyCache: {
  enabled: boolean;
  has_api_key: boolean;
  api_key?: string;
  expires: number;
  refreshPromise?: Promise<void>;
} = {
  enabled: false,
  has_api_key: false,
  expires: 0,
};

function getHubCaller():
  | {
      client: NonNullable<ReturnType<typeof getMasterConatClient>>;
      host_id: string;
    }
  | undefined {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) {
    return;
  }
  return { client, host_id };
}

function siteKeyTtlMs(): number {
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.max(10_000, Math.floor(SITE_OPENAI_KEY_CACHE_TTL_MS * jitter));
}

function siteKeyMissingTtlMs(): number {
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.max(10_000, Math.floor(SITE_OPENAI_KEY_MISSING_TTL_MS * jitter));
}

async function refreshSiteOpenAiApiKeyFromHub({
  force = false,
}: {
  force?: boolean;
} = {}): Promise<void> {
  const now = Date.now();
  if (!force && siteOpenAiKeyCache.expires > now) {
    return;
  }
  if (siteOpenAiKeyCache.refreshPromise) {
    return await siteOpenAiKeyCache.refreshPromise;
  }
  const caller = getHubCaller();
  if (!caller) return;

  const refreshPromise = (async () => {
    try {
      const result = await callHub({
        ...caller,
        name: "hosts.getSiteOpenAiApiKey",
        args: [{}],
        timeout: 10_000,
      });
      const enabled = !!result?.enabled;
      const has_api_key = !!result?.has_api_key;
      const api_key =
        typeof result?.api_key === "string" ? result.api_key.trim() : undefined;
      siteOpenAiKeyCache = {
        enabled,
        has_api_key,
        api_key: api_key || undefined,
        expires:
          Date.now() +
          (enabled && has_api_key ? siteKeyTtlMs() : siteKeyMissingTtlMs()),
      };
    } catch (err) {
      logger.debug("refreshSiteOpenAiApiKeyFromHub failed", {
        err: `${err}`,
      });
      // Keep current value but retry soon.
      siteOpenAiKeyCache = {
        ...siteOpenAiKeyCache,
        expires: Date.now() + 15_000,
      };
    }
  })().finally(() => {
    if (siteOpenAiKeyCache.refreshPromise === refreshPromise) {
      siteOpenAiKeyCache = {
        ...siteOpenAiKeyCache,
        refreshPromise: undefined,
      };
    }
  });
  siteOpenAiKeyCache = {
    ...siteOpenAiKeyCache,
    refreshPromise,
  };
  await refreshPromise;
}

async function readLocalAuth(codexHome: string): Promise<string | undefined> {
  const authPath = join(codexHome, "auth.json");
  try {
    const raw = await fs.readFile(authPath, "utf8");
    return raw?.trim() ? raw : undefined;
  } catch {
    return undefined;
  }
}

function authLastRefreshMs(payload: string): number | undefined {
  try {
    const value = Date.parse(JSON.parse(payload)?.last_refresh);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function localAuthSignature(
  codexHome: string,
): Promise<string | undefined> {
  const authPath = join(codexHome, "auth.json");
  try {
    const stat = await fs.stat(authPath);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

async function localAuthMtimeMs(
  codexHome: string,
): Promise<number | undefined> {
  const authPath = join(codexHome, "auth.json");
  try {
    const stat = await fs.stat(authPath);
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

async function writeLocalAuth({
  codexHome,
  payload,
}: {
  codexHome: string;
  payload: string;
}): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const authPath = join(codexHome, "auth.json");
  await fs.writeFile(authPath, payload, { mode: 0o600 });
  await ensureCodexCredentialsStoreFile(codexHome);
  const signature = await localAuthSignature(codexHome);
  if (signature) {
    syncedSubscriptionAuthSignatures.set(codexHome, signature);
  }
}

export async function pushSubscriptionAuthToRegistry({
  projectId,
  accountId,
  credentialId,
  create,
  codexHome,
  content,
  descriptorMetadata,
}: {
  projectId: string;
  accountId: string;
  credentialId?: string;
  create?: boolean;
  codexHome: string;
  content?: string;
  descriptorMetadata?: { email?: string; label?: string };
}): Promise<{ ok: boolean; id?: string }> {
  const caller = getHubCaller();
  if (!caller) {
    return { ok: false };
  }
  const payload = content ?? (await readLocalAuth(codexHome));
  const login = payload ? codexAuthJsonToAppServerLogin(payload) : undefined;
  if (
    !payload ||
    login?.type !== "chatgptAuthTokens" ||
    !login.chatgptAccountId
  ) {
    logger.warn("refusing to sync unusable subscription auth", {
      projectId,
      accountId,
    });
    return { ok: false };
  }
  try {
    const result = await callHub({
      ...caller,
      name: "hosts.upsertExternalCredential",
      args: [
        {
          project_id: projectId,
          selector: {
            ...SUBSCRIPTION_CREDENTIAL_SELECTOR,
            owner_account_id: accountId,
          },
          payload,
          metadata: {
            format: "auth.json",
            source: "project-host",
            provider_account_id: login.chatgptAccountId,
            plan_type: login.chatgptPlanType,
            ...(descriptorMetadata?.email
              ? { email: descriptorMetadata.email }
              : {}),
            ...(descriptorMetadata?.label
              ? { label: descriptorMetadata.label }
              : {}),
          },
          credential_id: credentialId,
          create,
          max_active: create ? 10 : undefined,
          deduplicate_metadata: create
            ? {
                key: "provider_account_id",
                value: login.chatgptAccountId,
              }
            : undefined,
        },
      ],
      timeout: 15000,
    });
    return { ok: true, id: result?.id };
  } catch (err) {
    logger.debug("pushSubscriptionAuthToRegistry failed", {
      projectId,
      accountId,
      err: `${err}`,
    });
    return { ok: false };
  }
}

export async function syncSubscriptionAuthToRegistryIfChanged({
  projectId,
  accountId,
  credentialId,
  codexHome,
  force = false,
}: {
  projectId: string;
  accountId: string;
  credentialId?: string;
  codexHome: string;
  force?: boolean;
}): Promise<{ ok: boolean; id?: string; skipped?: boolean }> {
  const signature = await localAuthSignature(codexHome);
  if (!signature) {
    return { ok: false, skipped: true };
  }
  if (!force && syncedSubscriptionAuthSignatures.get(codexHome) === signature) {
    return { ok: true, skipped: true };
  }
  const payload = await readLocalAuth(codexHome);
  if (!payload) {
    return { ok: false, skipped: true };
  }
  if (!force) {
    const caller = getHubCaller();
    if (!caller) return { ok: false, skipped: true };
    try {
      const current = await callHub({
        ...caller,
        name: "hosts.getExternalCredential",
        args: [
          {
            project_id: projectId,
            selector: {
              ...SUBSCRIPTION_CREDENTIAL_SELECTOR,
              owner_account_id: accountId,
            },
            credential_id: credentialId,
          },
        ],
        timeout: 15_000,
      });
      const registryPayload = current?.payload;
      if (typeof registryPayload === "string" && registryPayload.trim()) {
        if (registryPayload === payload) {
          syncedSubscriptionAuthSignatures.set(codexHome, signature);
          return { ok: true, id: current.id, skipped: true };
        }
        const localRefreshMs = authLastRefreshMs(payload);
        const registryRefreshMs = authLastRefreshMs(registryPayload);
        if (
          localRefreshMs == null ||
          (registryRefreshMs != null && registryRefreshMs >= localRefreshMs)
        ) {
          await writeLocalAuth({ codexHome, payload: registryPayload });
          return { ok: true, id: current.id, skipped: true };
        }
      }
    } catch (err) {
      logger.debug("failed comparing subscription auth with registry", {
        projectId,
        accountId,
        err: `${err}`,
      });
      return { ok: false, skipped: true };
    }
  }
  const result = await pushSubscriptionAuthToRegistry({
    projectId,
    accountId,
    credentialId,
    codexHome,
    content: payload,
  });
  if (result.ok) {
    syncedSubscriptionAuthSignatures.set(codexHome, signature);
  }
  return {
    ...result,
    skipped: false,
  };
}

export async function hasSubscriptionAuthInRegistry({
  projectId,
  accountId,
  credentialId,
}: {
  projectId: string;
  accountId: string;
  credentialId?: string;
}): Promise<boolean | undefined> {
  const key = `${projectId}:${accountId}:${credentialId ?? "default"}`;
  const now = Date.now();
  const cached = existenceCache.get(key);
  if (cached && cached.expires > now) {
    return cached.has;
  }
  const caller = getHubCaller();
  if (!caller) {
    return undefined;
  }
  try {
    const has = await callHub({
      ...caller,
      name: "hosts.hasExternalCredential",
      args: [
        {
          project_id: projectId,
          selector: {
            ...SUBSCRIPTION_CREDENTIAL_SELECTOR,
            owner_account_id: accountId,
          },
          credential_id: credentialId,
        },
      ],
      timeout: 10000,
    });
    const hasValue = !!has;
    existenceCache.set(key, {
      has: hasValue,
      expires: now + EXISTENCE_CACHE_TTL_MS,
    });
    return hasValue;
  } catch (err) {
    logger.debug("hasSubscriptionAuthInRegistry failed", {
      projectId,
      accountId,
      err: `${err}`,
    });
    return undefined;
  }
}

export async function touchSubscriptionAuthInRegistry({
  projectId,
  accountId,
  credentialId,
}: {
  projectId: string;
  accountId: string;
  credentialId?: string;
}): Promise<boolean> {
  const caller = getHubCaller();
  if (!caller) {
    return false;
  }
  try {
    const touched = await callHub({
      ...caller,
      name: "hosts.touchExternalCredential",
      args: [
        {
          project_id: projectId,
          selector: {
            ...SUBSCRIPTION_CREDENTIAL_SELECTOR,
            owner_account_id: accountId,
          },
          credential_id: credentialId,
        },
      ],
      timeout: 10_000,
    });
    const has = !!touched;
    if (has) {
      const key = `${projectId}:${accountId}:${credentialId ?? "default"}`;
      existenceCache.set(key, {
        has: true,
        expires: Date.now() + EXISTENCE_CACHE_TTL_MS,
      });
    }
    return has;
  } catch (err) {
    logger.debug("touchSubscriptionAuthInRegistry failed", {
      projectId,
      accountId,
      err: `${err}`,
    });
    return false;
  }
}

export async function pullSubscriptionAuthFromRegistry({
  projectId,
  accountId,
  credentialId,
  codexHome,
  onlyIfNewer = false,
}: {
  projectId: string;
  accountId: string;
  credentialId?: string;
  codexHome: string;
  onlyIfNewer?: boolean;
}): Promise<PullResult> {
  const caller = getHubCaller();
  if (!caller) {
    return { pulled: false };
  }
  try {
    const result = await callHub({
      ...caller,
      name: "hosts.getExternalCredential",
      args: [
        {
          project_id: projectId,
          selector: {
            ...SUBSCRIPTION_CREDENTIAL_SELECTOR,
            owner_account_id: accountId,
          },
          credential_id: credentialId,
        },
      ],
      timeout: 15000,
    });
    const payload = result?.payload;
    const registryUpdatedAt =
      typeof result?.updated === "string" || result?.updated instanceof Date
        ? new Date(result.updated).toISOString()
        : undefined;
    if (typeof payload !== "string" || !payload.trim()) {
      const key = `${projectId}:${accountId}:${credentialId ?? "default"}`;
      existenceCache.set(key, {
        has: false,
        expires: Date.now() + EXISTENCE_CACHE_TTL_MS,
      });
      return { pulled: false, missing: true };
    }
    const key = `${projectId}:${accountId}:${credentialId ?? "default"}`;
    existenceCache.set(key, {
      has: true,
      expires: Date.now() + EXISTENCE_CACHE_TTL_MS,
    });
    if (onlyIfNewer && registryUpdatedAt) {
      const registryUpdatedMs = new Date(registryUpdatedAt).getTime();
      const localMtimeMs = await localAuthMtimeMs(codexHome);
      if (
        localMtimeMs != null &&
        Number.isFinite(registryUpdatedMs) &&
        registryUpdatedMs <= localMtimeMs
      ) {
        return {
          pulled: false,
          skipped: "local-newer",
          registryUpdatedAt,
          credentialId: result.id,
        };
      }
    }
    await writeLocalAuth({ codexHome, payload });
    return {
      pulled: true,
      source: "registry",
      registryUpdatedAt,
      credentialId: result.id,
    };
  } catch (err) {
    logger.debug("pullSubscriptionAuthFromRegistry failed", {
      projectId,
      accountId,
      err: `${err}`,
    });
    return { pulled: false };
  }
}

export async function refreshSubscriptionAuthFromRegistry({
  projectId,
  accountId,
  credentialId,
  codexHome,
  previousAccessTokenHash,
}: {
  projectId: string;
  accountId: string;
  credentialId?: string;
  codexHome: string;
  previousAccessTokenHash: string;
}): Promise<{ refreshed: boolean; updated?: string }> {
  const caller = getHubCaller();
  if (!caller) {
    throw new Error(
      "ChatGPT sign-in cannot be refreshed because the project host is disconnected from the hub.",
    );
  }
  const result = await callHub({
    ...caller,
    name: "hosts.refreshCodexSubscriptionAuth",
    args: [
      {
        project_id: projectId,
        owner_account_id: accountId,
        credential_id: credentialId,
        previous_access_token_hash: previousAccessTokenHash,
      },
    ],
    timeout: 9_000,
  });
  const payload = result?.payload;
  if (typeof payload !== "string" || !payload.trim()) {
    throw new Error(
      "ChatGPT sign-in refresh returned no credential. Sign in again with ChatGPT in CoCalc.",
    );
  }
  await writeLocalAuth({ codexHome, payload });
  return {
    refreshed: !!result?.refreshed,
    updated:
      typeof result?.updated === "string" || result?.updated instanceof Date
        ? new Date(result.updated).toISOString()
        : undefined,
  };
}

async function getCredentialPayloadFromRegistry({
  projectId,
  selector,
}: {
  projectId: string;
  selector: {
    provider: string;
    kind: string;
    scope: "account" | "project";
    owner_account_id?: string;
    project_id?: string;
  };
}): Promise<string | undefined> {
  const caller = getHubCaller();
  if (!caller) return undefined;
  try {
    const result = await callHub({
      ...caller,
      name: "hosts.getExternalCredential",
      args: [{ project_id: projectId, selector }],
      timeout: 10_000,
    });
    const payload = result?.payload;
    if (typeof payload !== "string") return undefined;
    const trimmed = payload.trim();
    return trimmed || undefined;
  } catch (err) {
    logger.debug("getCredentialPayloadFromRegistry failed", {
      projectId,
      selector,
      err: `${err}`,
    });
    return undefined;
  }
}

export async function getProjectOpenAiApiKeyFromRegistry({
  projectId,
}: {
  projectId: string;
}): Promise<string | undefined> {
  return await getCredentialPayloadFromRegistry({
    projectId,
    selector: {
      provider: "openai",
      kind: OPENAI_API_KEY_KIND,
      scope: "project",
      project_id: projectId,
    },
  });
}

export async function getAccountOpenAiApiKeyFromRegistry({
  projectId,
  accountId,
}: {
  projectId: string;
  accountId: string;
}): Promise<string | undefined> {
  return await getCredentialPayloadFromRegistry({
    projectId,
    selector: {
      provider: "openai",
      kind: OPENAI_API_KEY_KIND,
      scope: "account",
      owner_account_id: accountId,
    },
  });
}

export async function getSiteOpenAiApiKeyFromHub({
  forceRefresh = false,
}: {
  forceRefresh?: boolean;
} = {}): Promise<string | undefined> {
  await refreshSiteOpenAiApiKeyFromHub({ force: forceRefresh });
  if (!siteOpenAiKeyCache.enabled || !siteOpenAiKeyCache.has_api_key) {
    return undefined;
  }
  const key = siteOpenAiKeyCache.api_key?.trim();
  return key ? key : undefined;
}
