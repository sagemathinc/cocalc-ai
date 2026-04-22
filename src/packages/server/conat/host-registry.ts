import getLogger from "@cocalc/backend/logger";
import { createServiceHandler } from "@cocalc/conat/service/typed";
import {
  upsertProjectHost,
  type ProjectHostRecord,
} from "@cocalc/database/postgres/project-hosts";
import { conat } from "@cocalc/backend/conat";
import { getProjectHostAuthTokenPublicKey } from "@cocalc/backend/data";
import getPool from "@cocalc/database/pool";
import {
  createProjectHostMasterConatToken,
  verifyProjectHostToken,
} from "@cocalc/server/project-host/bootstrap-token";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { enqueueCloudVmWorkOnce } from "@cocalc/server/cloud/db";
import { shouldAutoRestoreInterruptedSpotHost } from "@cocalc/server/cloud/spot-restore";
import {
  ensureAutomaticHostArtifactDeploymentsReconcile,
  ensureAutomaticHostRuntimeDeploymentsReconcile,
} from "@cocalc/server/conat/api/hosts";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { notifyProjectHostUpdate } from "./route-project";

const logger = getLogger("server:conat:host-registry");
const pool = () => getPool();

export interface HostRegistration extends ProjectHostRecord {
  sshpiperd_public_key?: string;
  project_host_auth_public_key?: string;
}

function getHostSessionId(metadata: any): string | undefined {
  const value = `${metadata?.host_session_id ?? ""}`.trim();
  return value || undefined;
}

function getHostBootId(metadata: any): string | undefined {
  const value = `${metadata?.host_boot_id ?? ""}`.trim();
  return value || undefined;
}

function registryBayIdForHeartbeat(previousBayId: unknown): string {
  const localBayId = getConfiguredBayId();
  const current = `${previousBayId ?? ""}`.trim();
  // Heartbeats prove this bay currently has a host connection; they do not
  // grant metadata ownership. During host rehome, the old bay can keep seeing
  // heartbeats until bootstrap reconcile restarts the host agent.
  return current || localBayId;
}

async function markStaleRunningProjectsOpenedAfterBootChange({
  host_id,
  previous_session_id,
  next_session_id,
  previous_boot_id,
  next_boot_id,
  source,
}: {
  host_id: string;
  previous_session_id?: string;
  next_session_id?: string;
  previous_boot_id?: string;
  next_boot_id?: string;
  source: "register" | "heartbeat";
}): Promise<void> {
  if (!previous_boot_id || !next_boot_id || previous_boot_id === next_boot_id) {
    return;
  }
  const defaultBayId = getConfiguredBayId();
  const state = {
    state: "opened",
    time: new Date().toISOString(),
    reason: "host_boot_replaced",
    previous_host_boot_id: previous_boot_id,
    host_boot_id: next_boot_id,
    previous_host_session_id: previous_session_id,
    host_session_id: next_session_id,
  };
  let projectIds: string[] = [];
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ project_id: string }>(
      `UPDATE projects
          SET state=$2::jsonb
        WHERE host_id=$1
          AND COALESCE(state->>'state', '') IN ('running', 'starting', 'restarting')
        RETURNING project_id`,
      [host_id, state],
    );
    projectIds = rows.map((row) => row.project_id).filter(Boolean);
    for (const project_id of projectIds) {
      await appendProjectOutboxEventForProject({
        db: client,
        event_type: "project.state_changed",
        project_id,
        default_bay_id: defaultBayId,
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.warn("failed to mark stale host-boot projects opened", {
      host_id,
      previous_boot_id,
      next_boot_id,
      previous_session_id,
      next_session_id,
      source,
      err: `${err}`,
    });
    return;
  } finally {
    client.release();
  }
  if (projectIds.length === 0) {
    return;
  }
  logger.info("marked stale host-boot projects opened", {
    host_id,
    previous_boot_id,
    next_boot_id,
    previous_session_id,
    next_session_id,
    source,
    count: projectIds.length,
  });
  const settled = await Promise.allSettled(
    projectIds.map((project_id) =>
      publishProjectAccountFeedEventsBestEffort({
        project_id,
        default_bay_id: defaultBayId,
      }),
    ),
  );
  const failed = settled.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    logger.warn("failed to publish some stale host-boot project updates", {
      host_id,
      source,
      failed: failed.length,
    });
  }
}

function getPendingAutomaticConvergenceRetry(metadata: any): {
  runtime: boolean;
  artifacts: boolean;
} {
  const pending =
    metadata?.runtime_deployments?.pending_automatic_convergence_retry ?? {};
  return {
    runtime: pending?.runtime === true,
    artifacts: pending?.artifacts === true,
  };
}

export interface HostRegistryApi {
  register: (info: HostRegistration) => Promise<void>;
  heartbeat: (info: HostRegistration) => Promise<void>;
  shutdownNotice: (opts: {
    host_id: string;
    host_session_id?: string;
    signal?: string;
    reason?: string;
  }) => Promise<void>;
  getProjectHostAuthPublicKey: () => Promise<{
    project_host_auth_public_key: string;
  }>;
  listProjectUserDeltas: (opts: {
    host_id: string;
    since_ms?: number;
    limit?: number;
  }) => Promise<{
    rows: Array<{ project_id: string; users: any; updated_ms: number }>;
    next_since_ms: number;
    has_more: boolean;
  }>;
  listProjectUserReconcile: (opts: {
    host_id: string;
    limit?: number;
    recent_days?: number;
  }) => Promise<{
    rows: Array<{ project_id: string; users: any; updated_ms: number }>;
    as_of_ms: number;
    has_more: boolean;
  }>;
  getMasterConatTokenStatus: (opts: {
    host_id: string;
    current_token: string;
  }) => Promise<{ expires_at: string }>;
  rotateMasterConatToken: (opts: {
    host_id: string;
    current_token?: string;
    bootstrap_token?: string;
  }) => Promise<{ master_conat_token: string }>;
}

const SUBJECT = "project-hosts";

export async function initHostRegistryService() {
  logger.info("starting host registry service");
  const client = conat();
  const loadCurrentStatus = async (id: string): Promise<string | undefined> => {
    const { rows } = await pool().query(
      "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [id],
    );
    return rows[0]?.status;
  };
  const resolveLocalSelfHost = async (
    info: HostRegistration,
  ): Promise<boolean> => {
    const machineFromInfo = info?.metadata?.machine ?? {};
    if (machineFromInfo?.cloud) {
      const selfHostMode = machineFromInfo?.metadata?.self_host_mode;
      const effectiveSelfHostMode =
        machineFromInfo?.cloud === "self-host" && !selfHostMode
          ? "local"
          : selfHostMode;
      return (
        machineFromInfo?.cloud === "self-host" &&
        effectiveSelfHostMode === "local"
      );
    }
    const { rows } = await pool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [info.id],
    );
    const machine = rows[0]?.metadata?.machine ?? {};
    const selfHostMode = machine?.metadata?.self_host_mode;
    const effectiveSelfHostMode =
      machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
    return machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  };
  const publishKey = async (info: HostRegistration) => {
    if (!info?.id) return;
    try {
      await client.publish(`${SUBJECT}.keys`, {
        id: info.id,
        sshpiperd_public_key: info.sshpiperd_public_key,
        project_host_auth_public_key: getProjectHostAuthTokenPublicKey(),
      });
    } catch (err) {
      logger.warn("failed to publish host ssh key", { err, id: info.id });
    }
  };
  const updatePendingAutomaticConvergenceRetry = async ({
    host_id,
    runtime,
    artifacts,
  }: {
    host_id: string;
    runtime: boolean;
    artifacts: boolean;
  }) => {
    const { rows } = await pool().query<{ metadata?: any }>(
      "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [host_id],
    );
    const metadata = rows[0]?.metadata ?? {};
    const runtimeDeployments = { ...(metadata?.runtime_deployments ?? {}) };
    if (runtime || artifacts) {
      runtimeDeployments.pending_automatic_convergence_retry = {
        ...(runtime ? { runtime: true } : {}),
        ...(artifacts ? { artifacts: true } : {}),
        updated_at: new Date().toISOString(),
      };
    } else {
      delete runtimeDeployments.pending_automatic_convergence_retry;
    }
    const nextMetadata = {
      ...metadata,
      runtime_deployments: runtimeDeployments,
    };
    await pool().query(
      "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
      [host_id, nextMetadata],
    );
  };
  const attemptAutomaticConvergence = async ({
    host_id,
    reason,
    retryOnlyPending,
  }: {
    host_id: string;
    reason: string;
    retryOnlyPending?: boolean;
  }) => {
    let pending = {
      runtime: true,
      artifacts: true,
    };
    if (retryOnlyPending) {
      const { rows } = await pool().query<{ metadata?: any }>(
        "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        [host_id],
      );
      pending = getPendingAutomaticConvergenceRetry(rows[0]?.metadata);
      if (!pending.runtime && !pending.artifacts) {
        return;
      }
    }
    let nextRuntimePending = false;
    let nextArtifactsPending = false;
    if (pending.runtime) {
      try {
        const result = await ensureAutomaticHostRuntimeDeploymentsReconcile({
          host_id,
          reason,
        });
        nextRuntimePending =
          !result.queued && result.reason === "observation_failed";
      } catch (err) {
        nextRuntimePending = true;
        logger.warn("automatic runtime deployment reconcile failed", {
          host_id,
          source: reason,
          err: `${err}`,
        });
      }
    }
    if (pending.artifacts) {
      try {
        const result = await ensureAutomaticHostArtifactDeploymentsReconcile({
          host_id,
        });
        nextArtifactsPending =
          !result.queued && result.reason === "observation_failed";
      } catch (err) {
        nextArtifactsPending = true;
        logger.warn("automatic artifact deployment reconcile failed", {
          host_id,
          source: reason,
          err: `${err}`,
        });
      }
    }
    await updatePendingAutomaticConvergenceRetry({
      host_id,
      runtime: nextRuntimePending,
      artifacts: nextArtifactsPending,
    });
  };
  return await createServiceHandler<HostRegistryApi>({
    client,
    service: SUBJECT,
    subject: `${SUBJECT}.api`,
    description: "Registry/heartbeat for project-host nodes",
    impl: {
      async register(info: HostRegistration) {
        if (!info?.id) {
          throw Error("register: id is required");
        }
        logger.debug("register", {
          id: info.id,
          region: info.region,
          url: info.public_url,
        });
        const currentStatus = await loadCurrentStatus(info.id);
        if (
          currentStatus &&
          !["running", "active"].includes(String(currentStatus))
        ) {
          logger.debug("register ignored (status)", {
            id: info.id,
            status: currentStatus,
          });
          return;
        }
        const isLocalSelfHost = await resolveLocalSelfHost(info);
        const sanitized = isLocalSelfHost
          ? { ...info, public_url: undefined, internal_url: undefined }
          : info;
        logger.debug("register host urls", {
          id: info.id,
          isLocalSelfHost,
          public_url: sanitized.public_url,
          internal_url: sanitized.internal_url,
        });
        const { rows: previousRows } = await pool().query<{
          metadata: any;
          bay_id?: string | null;
        }>(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
          [info.id],
        );
        const registryBayId = registryBayIdForHeartbeat(
          previousRows[0]?.bay_id,
        );
        const previousSessionId = getHostSessionId(previousRows[0]?.metadata);
        const previousBootId = getHostBootId(previousRows[0]?.metadata);
        const nextSessionId = getHostSessionId(sanitized.metadata);
        const nextBootId = getHostBootId(sanitized.metadata);
        await upsertProjectHost({
          ...sanitized,
          bay_id: registryBayId,
          status: "running",
          last_seen: new Date(),
          host_session_id: nextSessionId,
        });
        await markStaleRunningProjectsOpenedAfterBootChange({
          host_id: info.id,
          previous_session_id: previousSessionId,
          next_session_id: nextSessionId,
          previous_boot_id: previousBootId,
          next_boot_id: nextBootId,
          source: "register",
        });
        if (previousRows[0] && previousSessionId !== nextSessionId) {
          await notifyProjectHostUpdate({ host_id: info.id });
        }
        await attemptAutomaticConvergence({
          host_id: info.id,
          reason: "host_register",
        });
        await publishKey(info);
      },
      async heartbeat(info: HostRegistration) {
        if (!info?.id) {
          throw Error("heartbeat: id is required");
        }
        logger.silly?.("heartbeat", { id: info.id, status: info.status });
        const currentStatus = await loadCurrentStatus(info.id);
        if (
          currentStatus &&
          !["running", "active"].includes(String(currentStatus))
        ) {
          logger.debug("heartbeat ignored (status)", {
            id: info.id,
            status: currentStatus,
          });
          return;
        }
        const isLocalSelfHost = await resolveLocalSelfHost(info);
        const sanitized = isLocalSelfHost
          ? { ...info, public_url: undefined, internal_url: undefined }
          : info;
        const { rows: previousRows } = await pool().query<{
          metadata: any;
          bay_id?: string | null;
        }>(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
          [info.id],
        );
        const registryBayId = registryBayIdForHeartbeat(
          previousRows[0]?.bay_id,
        );
        const previousSessionId = getHostSessionId(previousRows[0]?.metadata);
        const previousBootId = getHostBootId(previousRows[0]?.metadata);
        const nextSessionId = getHostSessionId(sanitized.metadata);
        const nextBootId = getHostBootId(sanitized.metadata);
        await upsertProjectHost({
          ...sanitized,
          bay_id: registryBayId,
          status: "running",
          last_seen: new Date(),
          host_session_id: nextSessionId,
        });
        await markStaleRunningProjectsOpenedAfterBootChange({
          host_id: info.id,
          previous_session_id: previousSessionId,
          next_session_id: nextSessionId,
          previous_boot_id: previousBootId,
          next_boot_id: nextBootId,
          source: "heartbeat",
        });
        await attemptAutomaticConvergence({
          host_id: info.id,
          reason: "host_heartbeat_retry",
          retryOnlyPending: true,
        });
        await publishKey(info);
      },
      async shutdownNotice(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("shutdownNotice: host_id is required");
        }
        const announcedSessionId = `${opts?.host_session_id ?? ""}`.trim();
        const { rows } = await pool().query<{
          status?: string;
          metadata?: any;
        }>(
          "SELECT status, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
          [host_id],
        );
        const row = rows[0];
        if (!row) {
          logger.debug("shutdown notice ignored (missing host)", { host_id });
          return;
        }
        const currentSessionId = getHostSessionId(row.metadata);
        if (
          announcedSessionId &&
          currentSessionId &&
          announcedSessionId !== currentSessionId
        ) {
          logger.debug("shutdown notice ignored (stale session)", {
            host_id,
            announcedSessionId,
            currentSessionId,
          });
          return;
        }
        const notice = {
          at: new Date().toISOString(),
          signal:
            typeof opts?.signal === "string" && opts.signal.trim()
              ? opts.signal.trim()
              : undefined,
          reason:
            typeof opts?.reason === "string" && opts.reason.trim()
              ? opts.reason.trim()
              : undefined,
          host_session_id: currentSessionId ?? announcedSessionId ?? undefined,
        };
        const nextMetadata = {
          ...(row.metadata ?? {}),
          shutdown_notice: notice,
        };
        await pool().query(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
          [host_id, nextMetadata],
        );
        if (
          !shouldAutoRestoreInterruptedSpotHost({
            status: row.status,
            metadata: nextMetadata,
          })
        ) {
          logger.debug("shutdown notice recorded without auto-restore", {
            host_id,
            status: row.status,
            signal: notice.signal,
            reason: notice.reason,
          });
          return;
        }
        const enqueued = await enqueueCloudVmWorkOnce({
          vm_id: host_id,
          action: "start",
          payload: {
            source: "shutdown_notice",
            signal: notice.signal,
            reason: notice.reason,
          },
        });
        logger.info("processed shutdown notice for spot host", {
          host_id,
          signal: notice.signal,
          reason: notice.reason,
          enqueued,
        });
      },
      async getProjectHostAuthPublicKey() {
        return {
          project_host_auth_public_key: getProjectHostAuthTokenPublicKey(),
        };
      },
      async listProjectUserDeltas(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("listProjectUserDeltas: host_id is required");
        }
        const since_ms = Math.max(0, Number(opts?.since_ms ?? 0));
        const limit = Math.max(
          1,
          Math.min(2000, Number(opts?.limit ?? 500) || 500),
        );
        const { rows } = await pool().query<{
          project_id: string;
          users: any;
          updated_ms: number;
        }>(
          `
            SELECT
              project_id,
              COALESCE(users, '{}'::jsonb) AS users,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint > $2
            ORDER BY COALESCE(last_edited, created, to_timestamp(0)) ASC
            LIMIT $3
          `,
          [host_id, since_ms, limit],
        );
        let next_since_ms = since_ms;
        for (const row of rows) {
          next_since_ms = Math.max(next_since_ms, Number(row.updated_ms || 0));
        }
        return {
          rows,
          next_since_ms,
          has_more: rows.length >= limit,
        };
      },
      async listProjectUserReconcile(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("listProjectUserReconcile: host_id is required");
        }
        const limit = Math.max(
          1,
          Math.min(5000, Number(opts?.limit ?? 2000) || 2000),
        );
        const recent_days = Math.max(
          1,
          Math.min(90, Number(opts?.recent_days ?? 7) || 7),
        );
        const { rows } = await pool().query<{
          project_id: string;
          users: any;
          updated_ms: number;
        }>(
          `
            SELECT
              project_id,
              COALESCE(users, '{}'::jsonb) AS users,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND (
                COALESCE(state ->> 'state', '') IN ('running', 'starting')
                OR COALESCE(last_edited, to_timestamp(0)) > NOW() - ($2 || ' days')::interval
              )
            ORDER BY COALESCE(last_edited, created, to_timestamp(0)) DESC
            LIMIT $3
          `,
          [host_id, `${recent_days}`, limit],
        );
        return {
          rows,
          as_of_ms: Date.now(),
          has_more: rows.length >= limit,
        };
      },
      async getMasterConatTokenStatus(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        const currentToken = `${opts?.current_token ?? ""}`.trim();
        if (!host_id || !currentToken) {
          throw Error(
            "getMasterConatTokenStatus: host_id and current_token are required",
          );
        }
        const info = await verifyProjectHostToken(currentToken, {
          purpose: "master-conat",
        });
        if (!info || info.host_id !== host_id) {
          throw Error(
            "getMasterConatTokenStatus: token is invalid for this host",
          );
        }
        return {
          expires_at: info.expires.toISOString(),
        };
      },
      async rotateMasterConatToken(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("rotateMasterConatToken: host_id is required");
        }
        const currentToken = `${opts?.current_token ?? ""}`.trim();
        const bootstrapToken = `${opts?.bootstrap_token ?? ""}`.trim();
        if (!currentToken && !bootstrapToken) {
          throw Error(
            "rotateMasterConatToken: current_token or bootstrap_token is required",
          );
        }
        const currentInfo = currentToken
          ? await verifyProjectHostToken(currentToken, {
              purpose: "master-conat",
            })
          : null;
        const bootstrapInfo = bootstrapToken
          ? await verifyProjectHostToken(bootstrapToken, {
              purpose: "bootstrap",
            })
          : null;
        const info = currentInfo ?? bootstrapInfo;
        if (!info || info.host_id !== host_id) {
          throw Error("rotateMasterConatToken: token is invalid for host");
        }
        const issued = await createProjectHostMasterConatToken(host_id, {
          ttlMs: 1000 * 60 * 60 * 24 * 365, // 1 year
        });
        return { master_conat_token: issued.token };
      },
    },
  });
}
