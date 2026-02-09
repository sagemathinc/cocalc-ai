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
  createBootstrapToken,
  verifyBootstrapToken,
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
          ? await verifyBootstrapToken(currentToken, { purpose: "master-conat" })
          : null;
        const bootstrapInfo = bootstrapToken
          ? await verifyBootstrapToken(bootstrapToken, { purpose: "bootstrap" })
          : null;
        const info = currentInfo ?? bootstrapInfo;
        if (!info || info.host_id !== host_id) {
          throw Error("rotateMasterConatToken: token is invalid for host");
        }
        const issued = await createBootstrapToken(host_id, {
          purpose: "master-conat",
          ttlMs: 1000 * 60 * 60 * 24 * 365, // 1 year
        });
        return { master_conat_token: issued.token };
      },
    },
  });
}
