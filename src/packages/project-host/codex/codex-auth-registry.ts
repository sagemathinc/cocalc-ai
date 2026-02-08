import { promises as fs } from "node:fs";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { getMasterConatClient } from "../master-status";
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
  source?: "registry";
  missing?: boolean;
};

const existenceCache = new Map<
  string,
  { has: boolean; expires: number }
>();
const EXISTENCE_CACHE_TTL_MS = 30_000;

function getHubCaller():
  | { client: NonNullable<ReturnType<typeof getMasterConatClient>>; host_id: string }
  | undefined {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) {
    return;
  }
  return { client, host_id };
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

export async function pushSubscriptionAuthToRegistry({
  projectId,
  accountId,
  codexHome,
  content,
}: {
  projectId: string;
  accountId: string;
  codexHome: string;
  content?: string;
}): Promise<{ ok: boolean; id?: string }> {
  const caller = getHubCaller();
  if (!caller) {
    return { ok: false };
  }
  const payload = content ?? (await readLocalAuth(codexHome));
  if (!payload) {
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
          },
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

export async function hasSubscriptionAuthInRegistry({
  projectId,
  accountId,
}: {
  projectId: string;
  accountId: string;
}): Promise<boolean | undefined> {
  const key = `${projectId}:${accountId}`;
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
        },
      ],
      timeout: 10000,
    });
    const hasValue = !!has;
    existenceCache.set(key, { has: hasValue, expires: now + EXISTENCE_CACHE_TTL_MS });
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
}: {
  projectId: string;
  accountId: string;
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
        },
      ],
      timeout: 10_000,
    });
    const has = !!touched;
    if (has) {
      const key = `${projectId}:${accountId}`;
      existenceCache.set(key, { has: true, expires: Date.now() + EXISTENCE_CACHE_TTL_MS });
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
  codexHome,
}: {
  projectId: string;
  accountId: string;
  codexHome: string;
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
        },
      ],
      timeout: 15000,
    });
    const payload = result?.payload;
    if (typeof payload !== "string" || !payload.trim()) {
      const key = `${projectId}:${accountId}`;
      existenceCache.set(key, { has: false, expires: Date.now() + EXISTENCE_CACHE_TTL_MS });
      return { pulled: false, missing: true };
    }
    const key = `${projectId}:${accountId}`;
    existenceCache.set(key, { has: true, expires: Date.now() + EXISTENCE_CACHE_TTL_MS });
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
    const authPath = join(codexHome, "auth.json");
    await fs.writeFile(authPath, payload, { mode: 0o600 });
    await ensureCodexCredentialsStoreFile(codexHome);
    return { pulled: true, source: "registry" };
  } catch (err) {
    logger.debug("pullSubscriptionAuthFromRegistry failed", {
      projectId,
      accountId,
      err: `${err}`,
    });
    return { pulled: false };
  }
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
