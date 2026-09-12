import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("codex:agent-identity-lease");

// This file is distinct from the general own-project CLI credential. A failed
// identity refresh never substitutes an account/project credential.
export async function createAgentIdentityLease({
  api,
  projectId,
  accountId,
  env,
  hostDir,
}: {
  api: Pick<AgentApi, "issueIdentity" | "endIdentityRun">;
  projectId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
  hostDir: string;
}) {
  if (process.env.COCALC_AGENT_MESSAGING_ENABLED !== "1") return;
  const path = env?.COCALC_CODEX_CHAT_PATH;
  const thread_id = env?.COCALC_CODEX_THREAD_ID;
  if (!path || !thread_id) return;
  const run_id = randomUUID();
  const issue = () =>
    api.issueIdentity({
      project_id: projectId,
      account_id: accountId,
      path,
      thread_id,
      run_id,
    });
  const initial = await issue();
  if (!initial) return;
  const hostPath = join(hostDir, "identity.json");
  let closed = false;
  let refreshing: Promise<void> | undefined;
  const write = async (credential: typeof initial) => {
    const temp = join(hostDir, `.identity-${randomUUID()}`);
    try {
      await fs.writeFile(temp, JSON.stringify(credential), { mode: 0o600 });
      await fs.rename(temp, hostPath);
    } finally {
      await fs.rm(temp, { force: true });
    }
  };
  try {
    await write(initial);
  } catch (error) {
    await api
      .endIdentityRun({
        account_id: accountId,
        agent_id: initial.agent_id,
        run_id,
      })
      .catch(() => undefined);
    throw error;
  }
  const timer = setInterval(() => {
    if (closed || refreshing) return;
    refreshing = (async () => {
      const next = await issue();
      if (!next) throw new Error("registered identity unavailable");
      if (!closed) await write(next);
    })()
      .catch(() =>
        logger.warn(
          "identity renewal failed; existing credential will expire",
          { agent_id: initial.agent_id, run_id },
        ),
      )
      .finally(() => {
        refreshing = undefined;
      });
  }, 3 * 60_000);
  timer.unref();
  return {
    hostPath,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await refreshing;
      try {
        await api.endIdentityRun({
          account_id: accountId,
          agent_id: initial.agent_id,
          run_id,
        });
      } catch {
        logger.warn(
          "identity run revocation unconfirmed; credential will expire",
          { agent_id: initial.agent_id, run_id },
        );
      }
      await fs.rm(hostPath, { force: true });
    },
  };
}
