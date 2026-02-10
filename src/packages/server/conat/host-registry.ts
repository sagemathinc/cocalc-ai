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

const logger = getLogger("server:conat:host-registry");
const pool = () => getPool();

export interface HostRegistration extends ProjectHostRecord {
  sshpiperd_public_key?: string;
  project_host_auth_public_key?: string;
}

export interface HostRegistryApi {
  register: (info: HostRegistration) => Promise<void>;
  heartbeat: (info: HostRegistration) => Promise<void>;
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
  return await createServiceHandler<HostRegistryApi>({
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
        await upsertProjectHost({
          ...sanitized,
          status: "running",
          last_seen: new Date(),
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
        await upsertProjectHost({
          ...sanitized,
          status: "running",
          last_seen: new Date(),
        });
        await publishKey(info);
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
              FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, NOW())) * 1000)::bigint AS updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, NOW())) * 1000)::bigint > $2
            ORDER BY COALESCE(updated_at, NOW()) ASC
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
              FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, NOW())) * 1000)::bigint AS updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND (
                COALESCE(state ->> 'state', '') IN ('running', 'starting')
                OR COALESCE(last_edited, to_timestamp(0)) > NOW() - ($2 || ' days')::interval
              )
            ORDER BY COALESCE(updated_at, NOW()) DESC
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
