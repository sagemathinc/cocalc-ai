import { createServiceClient } from "@cocalc/conat/service/typed";
import getLogger from "@cocalc/backend/logger";
import { randomUUID } from "crypto";
import { getRow, upsertRow } from "@cocalc/lite/hub/sqlite/database";
import { createHostControlService } from "@cocalc/conat/project-host/api";
import { hubApi } from "@cocalc/lite/hub/api";
import { account_id } from "@cocalc/backend/data";
import { setMasterStatusClient } from "./master-status";
import { setSshpiperdPublicKey } from "./ssh/host-keys";
import { ensureSshpiperdKey } from "./ssh/sshpiperd-key";
import { updateAuthorizedKeys, updateProjectUsers } from "./hub/projects";
import { deleteVolume } from "./file-server";
import { getSoftwareVersions } from "./software";
import { upgradeSoftware } from "./upgrade";
import { executeCode } from "@cocalc/backend/execute-code";
import { deleteProjectLocal } from "./sqlite/projects";
import { setProjectHostAuthPublicKey } from "./auth-public-key";
import { connect as connectToConat } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  fetchMasterConatTokenViaBootstrap,
  getProjectHostBootstrapConatSource,
  getProjectHostMasterConatToken,
  getProjectHostMasterConatTokenPath,
  writeProjectHostMasterConatToken,
} from "./master-conat-token";

const logger = getLogger("project-host:master");

const SUBJECT = "project-hosts";
const MASTER_CONAT_CHECK_MS = Math.max(
  60_000,
  Number(process.env.COCALC_MASTER_CONAT_TOKEN_CHECK_MS ?? 6 * 60 * 60 * 1000),
);
const MASTER_CONAT_ROTATE_WINDOW_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_MASTER_CONAT_TOKEN_ROTATE_WINDOW_MS ??
      30 * 24 * 60 * 60 * 1000,
  ),
);
const MASTER_CONAT_RETRY_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const MASTER_CONAT_MISSING_PROBE_MS = Math.max(
  5_000,
  Number(process.env.COCALC_MASTER_CONAT_TOKEN_MISSING_PROBE_MS ?? 30_000),
);

interface HostRegistration {
  id: string;
  name?: string;
  region?: string;
  public_url?: string;
  internal_url?: string;
  ssh_server?: string;
  sshpiperd_public_key?: string;
  project_host_auth_public_key?: string;
  status?: string;
  version?: string;
  capacity?: any;
  metadata?: any;
}

export async function startMasterRegistration({
  hostId,
  runnerId,
  host,
  port,
  masterConatToken,
}: {
  hostId?: string;
  runnerId: string;
  host: string;
  port: number;
  masterConatToken?: string;
}) {
  const masterAddress =
    process.env.MASTER_CONAT_SERVER ?? process.env.COCALC_MASTER_CONAT_SERVER;
  if (!masterAddress) {
    logger.debug("no master conat server configured; skipping registration");
    return;
  }
  logger.debug("startMasterRegistration", { masterAddress });

  const stored = getRow("project-host", "host-id")?.hostId as
    | string
    | undefined;
  const resolved =
    hostId ?? process.env.PROJECT_HOST_ID ?? stored ?? randomUUID();
  if (stored !== resolved) {
    upsertRow("project-host", "host-id", { hostId: resolved });
  }
  const id = resolved;
  const name = process.env.PROJECT_HOST_NAME ?? runnerId ?? id;
  const region = process.env.PROJECT_HOST_REGION;
  const selfHostMode = (process.env.COCALC_SELF_HOST_MODE ?? "").toLowerCase();
  const isSelfHostLocal = selfHostMode === "local";
  const public_url = isSelfHostLocal
    ? undefined
    : process.env.PROJECT_HOST_PUBLIC_URL ?? `http://${host}:${port}`;
  const internal_url = isSelfHostLocal
    ? undefined
    : process.env.PROJECT_HOST_INTERNAL_URL ?? `http://${host}:${port}`;
  const ssh_server =
    process.env.PROJECT_HOST_SSH_SERVER ??
    process.env.COCALC_SSH_SERVER ??
    `${host}:${2222}`;

  if (isSelfHostLocal) {
    logger.debug("self-host local registration omits public/internal urls");
  }

  logger.info("registering with master", { masterAddress, id, public_url });
  let currentMasterConatToken = `${masterConatToken ?? ""}`.trim();
  if (!currentMasterConatToken) {
    const bootstrapSource = getProjectHostBootstrapConatSource({
      fallbackConatUrl: masterAddress,
    });
    if (bootstrapSource) {
      try {
        const next = await fetchMasterConatTokenViaBootstrap(bootstrapSource);
        writeProjectHostMasterConatToken(next);
        currentMasterConatToken = next;
        logger.info("loaded master conat token via bootstrap endpoint", {
          reason: "startup-preflight",
          token_path: getProjectHostMasterConatTokenPath(),
        });
      } catch (err) {
        logger.warn(
          "failed loading master conat token via bootstrap endpoint during startup",
          {
            reason: "startup-preflight",
            token_path: getProjectHostMasterConatTokenPath(),
            err,
          },
        );
      }
    }
  }
  if (!currentMasterConatToken) {
    logger.warn(
      "master conat token is missing; registration/control connection may fail",
      { expectedPath: "/btrfs/data/secrets/master-conat-token" },
    );
    logger.warn(
      "master registration is disabled until a valid master conat token is available",
      { expectedPath: "/btrfs/data/secrets/master-conat-token" },
    );
    return;
  }

  const client = connectToConat({
    address: masterAddress,
    inboxPrefix: inboxPrefix({ host_id: id }),
    auth: (cb) => {
      if (currentMasterConatToken) {
        cb({ bearer: currentMasterConatToken });
      } else {
        cb({});
      }
    },
  });

  // Stable sshpiperd keypair for inbound SSH ingress.
  const sshpiperdKey = ensureSshpiperdKey(id);
  setSshpiperdPublicKey(id, sshpiperdKey.publicKey);

  const registry = createServiceClient<{
    register: (info: HostRegistration) => Promise<void>;
    heartbeat: (info: HostRegistration) => Promise<void>;
    getProjectHostAuthPublicKey: () => Promise<{
      project_host_auth_public_key: string;
    }>;
    getMasterConatTokenStatus: (opts: {
      host_id: string;
      current_token: string;
    }) => Promise<{
      expires_at: string;
    }>;
    rotateMasterConatToken: (opts: {
      host_id: string;
      current_token?: string;
      bootstrap_token?: string;
    }) => Promise<{
      master_conat_token: string;
    }>;
  }>({
    service: SUBJECT,
    subject: `${SUBJECT}.api`,
    client,
  });

  // Control plane for this host (master can ask us to create/start/stop projects).
  const controlService = createHostControlService({
    host_id: id,
    client,
    impl: {
      async createProject(opts) {
        if (!hubApi.projects?.createProject) {
          throw Error("createProject not available");
        }
        const project_id = await hubApi.projects.createProject({
          ...opts,
          account_id,
        } as any);
        return { project_id };
      },
      async startProject({
        project_id,
        authorized_keys,
        run_quota,
        image,
        restore,
        lro_op_id,
      }) {
        if (!hubApi.projects?.start) {
          throw Error("start not available");
        }
        const status = await hubApi.projects.start({
          account_id,
          project_id,
          authorized_keys,
          run_quota,
          image,
          restore,
          lro_op_id,
        });
        return { project_id, state: (status as any)?.state };
      },
      async stopProject({ project_id }) {
        if (!hubApi.projects?.stop) {
          throw Error("stop not available");
        }
        const status = await hubApi.projects.stop({ account_id, project_id });
        return { project_id, state: (status as any)?.state };
      },
      async updateAuthorizedKeys({ project_id, authorized_keys }) {
        await updateAuthorizedKeys({
          project_id,
          authorized_keys,
        });
      },
      async updateProjectUsers({ project_id, users }) {
        await updateProjectUsers({
          project_id,
          users,
        });
      },
      async deleteProjectData({ project_id }) {
        await deleteVolume(project_id);
        deleteProjectLocal(project_id);
      },
      upgradeSoftware,
      async growBtrfs({ disk_gb }) {
        const args = ["/usr/local/sbin/cocalc-grow-btrfs"];
        if (disk_gb != null) args.push(String(disk_gb));
        const { stdout, stderr, exit_code } = await executeCode({
          command: "sudo",
          args,
          timeout: 60,
        });
        if (exit_code) {
          throw new Error(
            `grow-btrfs failed (exit ${exit_code}): ${stderr || stdout || ""}`.trim(),
          );
        }
        return { ok: true };
      },
    },
  });

  const basePayload: HostRegistration = {
    id,
    name,
    region,
    public_url,
    internal_url,
    ssh_server,
    sshpiperd_public_key: sshpiperdKey.publicKey,
    metadata: {
      runnerId,
    },
  };

  setMasterStatusClient({
    client,
    host_id: id,
    host: {
      public_url,
      internal_url,
      ssh_server,
    },
  });

  const buildPayload = (): HostRegistration => {
    const versions = getSoftwareVersions();
    return {
      ...basePayload,
      version: versions.project_host ?? basePayload.version,
      metadata: {
        ...(basePayload.metadata ?? {}),
        software: versions,
      },
    };
  };

  const send = async (fn: "register" | "heartbeat") => {
    try {
      await registry[fn](buildPayload());
    } catch (err) {
      logger.warn(`failed to ${fn} host`, { err });
    }
  };

  const recoverMasterConatTokenViaBootstrap = async (
    reason: string,
  ): Promise<boolean> => {
    const source = getProjectHostBootstrapConatSource({
      fallbackConatUrl: masterAddress,
    });
    if (!source) {
      logger.warn("missing master conat token and no bootstrap source", {
        reason,
        token_path: getProjectHostMasterConatTokenPath(),
      });
      return false;
    }
    try {
      const next = await fetchMasterConatTokenViaBootstrap(source);
      writeProjectHostMasterConatToken(next);
      currentMasterConatToken = next;
      logger.info("recovered master conat token via bootstrap endpoint", {
        reason,
        token_path: getProjectHostMasterConatTokenPath(),
      });
      return true;
    } catch (err) {
      logger.warn("failed recovering master conat token via bootstrap endpoint", {
        reason,
        token_path: getProjectHostMasterConatTokenPath(),
        err,
      });
      return false;
    }
  };

  const ensureMasterConatToken = async (reason: string): Promise<boolean> => {
    // If token is injected via env, external orchestration owns rotation.
    if (`${process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN ?? ""}`.trim()) {
      return true;
    }
    const onDisk = getProjectHostMasterConatToken();
    const missingOnDisk = !onDisk;
    if (onDisk) {
      currentMasterConatToken = onDisk;
    }
    if (!currentMasterConatToken) {
      return await recoverMasterConatTokenViaBootstrap(reason);
    }

    let shouldRotate = missingOnDisk;
    try {
      const status = await registry.getMasterConatTokenStatus({
        host_id: id,
        current_token: currentMasterConatToken,
      });
      const expiresAt = new Date(status.expires_at).getTime();
      const msRemaining = expiresAt - Date.now();
      if (msRemaining <= MASTER_CONAT_ROTATE_WINDOW_MS) {
        shouldRotate = true;
      }
      logger.debug("master conat token status", {
        reason,
        expires_at: status.expires_at,
        ms_remaining: msRemaining,
        rotate_window_ms: MASTER_CONAT_ROTATE_WINDOW_MS,
        missing_on_disk: missingOnDisk,
      });
    } catch (err) {
      logger.warn("failed checking master conat token status", { reason, err });
      return await recoverMasterConatTokenViaBootstrap(
        `${reason}:status-check-failed`,
      );
    }

    if (!shouldRotate) {
      return true;
    }
    try {
      const rotated = await registry.rotateMasterConatToken({
        host_id: id,
        current_token: currentMasterConatToken,
      });
      const next = `${rotated?.master_conat_token ?? ""}`.trim();
      if (!next) {
        throw new Error("empty token returned by rotateMasterConatToken");
      }
      writeProjectHostMasterConatToken(next);
      currentMasterConatToken = next;
      logger.info("rotated master conat token", {
        reason,
        token_path: getProjectHostMasterConatTokenPath(),
        missing_on_disk: missingOnDisk,
      });
      return true;
    } catch (err) {
      logger.warn("failed rotating master conat token", {
        reason,
        token_path: getProjectHostMasterConatTokenPath(),
        err,
      });
      return false;
    }
  };

  const refreshProjectHostAuthPublicKey = async (reason: string) => {
    try {
      const resp = await registry.getProjectHostAuthPublicKey();
      if (resp?.project_host_auth_public_key) {
        setProjectHostAuthPublicKey(resp.project_host_auth_public_key);
        logger.debug("updated project-host auth public key", {
          reason,
        });
      }
    } catch (err) {
      logger.warn("failed to refresh project-host auth public key", {
        reason,
        err,
      });
    }
  };

  // Subscribe early to avoid missing a publish that could happen during register().
  (async () => {
    try {
      const sub = await client.subscribe(`${SUBJECT}.keys`);
      for await (const msg of sub) {
        const data = msg.data as HostRegistration | undefined;
        if (data?.id) {
          if (data.sshpiperd_public_key) {
            setSshpiperdPublicKey(data.id, data.sshpiperd_public_key);
          }
          if (data.project_host_auth_public_key) {
            setProjectHostAuthPublicKey(data.project_host_auth_public_key);
          }
        }
      }
    } catch (err) {
      logger.warn("host key subscription failed", { err });
    }
  })();

  let ensureInFlight: Promise<boolean> | undefined;
  const runEnsureMasterConatToken = async (reason: string): Promise<boolean> => {
    if (ensureInFlight) {
      return await ensureInFlight;
    }
    ensureInFlight = ensureMasterConatToken(reason);
    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = undefined;
    }
  };

  await refreshProjectHostAuthPublicKey("startup");
  await runEnsureMasterConatToken("startup");
  await send("register");
  const timer = setInterval(() => void send("heartbeat"), 30_000);
  let tokenRotationRetryStep = 0;
  let tokenRotationTimer: NodeJS.Timeout | undefined;
  const scheduleTokenRotation = (delayMs: number) => {
    if (tokenRotationTimer) {
      clearTimeout(tokenRotationTimer);
    }
    tokenRotationTimer = setTimeout(async () => {
      const ok = await runEnsureMasterConatToken("periodic");
      if (ok) {
        tokenRotationRetryStep = 0;
        scheduleTokenRotation(MASTER_CONAT_CHECK_MS);
      } else {
        const base =
          MASTER_CONAT_RETRY_STEPS_MS[
            Math.min(
              tokenRotationRetryStep,
              MASTER_CONAT_RETRY_STEPS_MS.length - 1,
            )
          ];
        tokenRotationRetryStep += 1;
        const jitter = Math.floor(base * 0.2 * Math.random());
        scheduleTokenRotation(base + jitter);
      }
    }, delayMs);
    tokenRotationTimer.unref?.();
  };
  scheduleTokenRotation(MASTER_CONAT_CHECK_MS);
  const missingTokenProbe = setInterval(() => {
    if (`${process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN ?? ""}`.trim()) {
      return;
    }
    if (getProjectHostMasterConatToken()) {
      return;
    }
    void runEnsureMasterConatToken("missing-file-probe");
  }, MASTER_CONAT_MISSING_PROBE_MS);
  missingTokenProbe.unref?.();

  const stop = () => {
    clearInterval(timer);
    clearInterval(missingTokenProbe);
    if (tokenRotationTimer) {
      clearTimeout(tokenRotationTimer);
      tokenRotationTimer = undefined;
    }
    client.close?.();
    controlService?.close?.();
  };
  ["SIGINT", "SIGTERM", "SIGQUIT", "exit"].forEach((sig) =>
    process.once(sig as any, stop),
  );

  return stop;
}
