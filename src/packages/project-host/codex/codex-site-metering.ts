import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { setCodexSiteKeyGovernor } from "@cocalc/ai/acp";
import { getMasterConatClient } from "../master-status";
import { getLocalHostId } from "../sqlite/hosts";

const logger = getLogger("project-host:codex-site-metering");

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

const SITE_KEY_POLL_MS = Math.max(
  30_000,
  Number(process.env.COCALC_CODEX_SITE_USAGE_POLL_MS ?? 2 * 60_000),
);

function getConfiguredMaxTurnMs(): number | undefined {
  const raw = process.env.COCALC_CODEX_SITE_MAX_TURN_MS;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(60_000, n);
}

const SITE_KEY_MAX_TURN_MS = getConfiguredMaxTurnMs();

export function initCodexSiteKeyGovernor(): void {
  setCodexSiteKeyGovernor({
    pollIntervalMs: SITE_KEY_POLL_MS,
    ...(SITE_KEY_MAX_TURN_MS == null ? {} : { maxTurnMs: SITE_KEY_MAX_TURN_MS }),
    async checkAllowed({ accountId, projectId, model }) {
      const caller = getHubCaller();
      if (!caller) {
        return { allowed: true };
      }
      try {
        const result = await callHub({
          ...caller,
          name: "hosts.checkCodexSiteUsageAllowance",
          args: [
            {
              account_id: accountId,
              project_id: projectId,
              model,
            },
          ],
          timeout: 15_000,
        });
        return {
          allowed: !!result?.allowed,
          reason: result?.reason,
          window: result?.window,
          reset_in: result?.reset_in,
        };
      } catch (err) {
        logger.warn("checkCodexSiteUsageAllowance failed", {
          accountId,
          projectId,
          model,
          err: `${err}`,
        });
        // If central usage checks are unavailable, fail open so Codex stays usable.
        return { allowed: true };
      }
    },
    async reportUsage({ accountId, projectId, model, usage, totalTimeS, path }) {
      const caller = getHubCaller();
      if (!caller) {
        return;
      }
      await callHub({
        ...caller,
        name: "hosts.recordCodexSiteUsage",
        args: [
          {
            account_id: accountId,
            project_id: projectId,
            model,
            path,
            prompt_tokens: Math.max(
              0,
              usage.input_tokens + (usage.cached_input_tokens ?? 0),
            ),
            completion_tokens: Math.max(0, usage.output_tokens),
            total_time_s: Math.max(0, totalTimeS),
          },
        ],
        timeout: 15_000,
      });
    },
  });
}
