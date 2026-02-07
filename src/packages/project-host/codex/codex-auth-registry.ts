import { promises as fs } from "node:fs";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { getMasterConatClient } from "../master-status";
import { getLocalHostId } from "../sqlite/hosts";
import { ensureCodexCredentialsStoreFile } from "./codex-auth";

const logger = getLogger("project-host:codex-auth-registry");
const CREDENTIAL_SELECTOR = {
  provider: "openai",
  kind: "codex-subscription-auth-json",
  scope: "account" as const,
};

type PullResult = {
  pulled: boolean;
  source?: "registry";
};

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
            ...CREDENTIAL_SELECTOR,
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
            ...CREDENTIAL_SELECTOR,
            owner_account_id: accountId,
          },
        },
      ],
      timeout: 15000,
    });
    const payload = result?.payload;
    if (typeof payload !== "string" || !payload.trim()) {
      return { pulled: false };
    }
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
