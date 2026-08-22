/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Project control class.

The hub uses this to get information about a project and do some basic tasks.
There are different implementations for different ways in which cocalc
gets deployed.

This module does 3 things:

1. CONTROL: Start/stop/restart a project.
2. CONNECT: Get ports, ip address, and the project secret token
3. COPY:    Copying a directory of files from one project to another.

For simplicity, it doesn't do anything else. It's good to keep this as small as
possible, so it is manageable, especially as we adapt CoCalc to new
environments.
*/

import { callback2, until } from "@cocalc/util/async-utils";
import { db } from "@cocalc/database";
import { EventEmitter } from "events";
import { isEqual } from "lodash";
import { ProjectState, ProjectStatus } from "@cocalc/util/db-schema/projects";
import { Quota, quota } from "@cocalc/util/upgrades/quota";
import getLogger from "@cocalc/backend/logger";
import { getQuotaSiteSettings } from "@cocalc/database/postgres/quota-site-settings";
import getPool from "@cocalc/database/pool";
import { query } from "@cocalc/database/postgres/query";
import { getProjectSecretToken } from "./secret-token";
import { client as projectRunnerClient } from "@cocalc/conat/project/runner/run";
import { conat } from "@cocalc/backend/conat";
import {
  startProjectOnHost,
  stopProjectOnHost,
  updateProjectRunQuotaOnHost,
} from "@cocalc/server/project-host/control";
import { applyHostRuntimePolicyToRunQuota } from "@cocalc/server/project-host/run-quota";
import {
  ensureProjectFileServerClientReady,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import type { LroRef } from "@cocalc/conat/files/file-server";
import {
  getCurrentProjectRootfsBinding,
  setProjectRootfsImageWithRollback,
} from "@cocalc/server/projects/rootfs-state";
import {
  issueRootfsReleaseArtifactUpload,
  upsertPublishedRootfsRelease,
} from "@cocalc/server/rootfs/releases";
import {
  getMembershipBrowserIdleTimeoutForAccount,
  getMembershipProjectDefaultsForAccount,
  getMembershipRuntimeSchedulingForAccount,
} from "@cocalc/server/membership/project-defaults";
import { applyProjectEntitlementOverrideToRunQuota } from "@cocalc/server/membership/project-entitlement-overrides";
import { assertLocalProjectOwnership } from "@cocalc/server/conat/project-local-access";
import type { ManagedProjectEgressOverride } from "@cocalc/conat/files/file-server";
import {
  getProjectOwnerAccountId,
  resolveRuntimeSponsorAccountId,
  type ProjectUsers,
} from "@cocalc/server/projects/runtime-sponsor";
import { isWorkspaceProjectRuntime } from "@cocalc/server/launchpad/project-runtime";
export type { ProjectState, ProjectStatus };

const logger = getLogger("project-control");

export type Action = "open" | "start" | "stop" | "restart";

// We use a cache to ensure that there is at most one copy of a given Project
// for each project_id, since internally we assume this in some cases, e.g.,
// when starting a project we rely on the internal stateChanging attribute
// rather than the database to know that we're starting the project.  We use
// WeakRef so that when nothing is referencing the project, it can be garbage
// collected.  These objects don't use much memory, but blocking garbage collection
// would be bad.
const projectCache: { [project_id: string]: WeakRef<BaseProject> } = {};
const ROOTFS_SEAL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const FILE_SERVER_READY_TIMEOUT_MS = 60_000;
const DISABLE_ROOTFS_PORTABILITY_SEAL_ENV =
  "COCALC_DISABLE_ROOTFS_PORTABILITY_SEAL";

function isActiveProjectState(state?: string | null): boolean {
  return state === "running" || state === "starting" || state === "pending";
}

function isRunningProjectHostStatus(status?: string | null): boolean {
  const normalized = `${status ?? ""}`.trim().toLowerCase();
  return normalized === "running" || normalized === "active";
}

async function loadProjectStopState(project_id: string): Promise<{
  host_id: string;
  host_deleted: Date | string | null;
  host_found: boolean;
  host_status: string | null;
  state: string | null;
}> {
  const { rows } = await getPool().query<{
    host_id: string | null;
    host_deleted: Date | string | null;
    host_found: boolean | null;
    host_status: string | null;
    state: string | null;
  }>(
    `
    SELECT
      projects.host_id,
      projects.state->>'state' AS state,
      project_hosts.id IS NOT NULL AS host_found,
      project_hosts.status AS host_status,
      project_hosts.deleted AS host_deleted
    FROM projects
    LEFT JOIN project_hosts
      ON project_hosts.id = projects.host_id
    WHERE projects.project_id=$1
    `,
    [project_id],
  );
  return {
    host_id: `${rows[0]?.host_id ?? ""}`.trim(),
    host_deleted: rows[0]?.host_deleted ?? null,
    host_found: rows[0]?.host_found === true,
    host_status: rows[0]?.host_status ?? null,
    state: rows[0]?.state ?? null,
  };
}

function runQuotaForRestartComparison(
  run_quota?: Quota | null,
): Record<string, unknown> {
  if (run_quota == null || typeof run_quota !== "object") {
    return {};
  }
  // Idle policy is enforced by project-host maintenance, not the runtime
  // cgroup. Changing either field must not restart a running project.
  const {
    idle_timeout: _idle_timeout,
    browser_idle_timeout: _browser_idle_timeout,
    ...rest
  } = run_quota as Record<string, unknown>;
  return rest;
}

function withCocalcAiRuntimeSemantics(run_quota: Quota): Quota {
  const sharedComputePriority = Number(run_quota.shared_compute_priority);
  return {
    ...run_quota,
    // Free accounts have priority 0. All paid, admin, and site-license tiers
    // have a positive priority. Derive network access from the resolved runtime
    // account after sponsorship/course attribution instead of the legacy site
    // default, which historically enabled internet for every project.
    network:
      Number.isFinite(sharedComputePriority) && sharedComputePriority > 0,
    member_host: true,
  };
}

function getProjectControlConatClient() {
  // This one-bay control path is intentionally choosing the current backend
  // hub client. Shared runner helpers must not silently make that routing
  // decision via a global fallback.
  return conat();
}
export function getProject(project_id: string): BaseProject {
  let project = projectCache[project_id]?.deref();
  if (project == null) {
    project = new BaseProject(project_id);
    projectCache[project_id] = new WeakRef(project);
  }
  return project!;
}

export class BaseProject extends EventEmitter {
  public readonly project_id: string;
  public is_ready: boolean = false;
  public is_freed: boolean = false;
  protected stateChanging: ProjectState | undefined = undefined;
  private localOwnershipChecked?: Promise<void>;
  private runQuotaRevision?: number;

  constructor(project_id: string) {
    super();
    projectCache[project_id] = new WeakRef(this);
    this.project_id = project_id;
    const dbg = this.dbg("constructor");
    dbg("initializing");
  }

  async touch(
    account_id?: string,
    { noStart }: { noStart?: boolean } = {},
  ): Promise<void> {
    const d = db();
    if (account_id) {
      await callback2(d.touch.bind(d), {
        project_id: this.project_id,
        account_id,
      });
    } else {
      const pool = getPool();
      await pool.query(
        "UPDATE projects SET last_edited=NOW() WHERE project_id=$1",
        [this.project_id],
      );
    }
    if (!noStart) {
      await this.start({ account_id });
    }
  }

  async saveStateToDatabase(state: ProjectState): Promise<void> {
    await callback2(db().set_project_state, {
      ...state,
      project_id: this.project_id,
    });
  }

  protected async saveStatusToDatabase(status: ProjectStatus): Promise<void> {
    await callback2(db().set_project_status, {
      project_id: this.project_id,
      status,
    });
  }

  dbg(f: string): (string?) => void {
    return (msg?: string) => {
      logger.debug(`(project_id=${this.project_id}).${f}: ${msg}`);
    };
  }

  private ensureLocalOwnership = async (): Promise<void> => {
    this.localOwnershipChecked ??= assertLocalProjectOwnership({
      project_id: this.project_id,
    });
    return await this.localOwnershipChecked;
  };

  private projectRunner = () => {
    return projectRunnerClient({
      project_id: this.project_id,
      client: getProjectControlConatClient(),
    });
  };

  private startOnHost = async (opts?: {
    lro_op_id?: string;
    account_id?: string;
    managed_egress_override?: ManagedProjectEgressOverride;
    restore_backup_id?: string;
  }): Promise<void> => {
    await this.computeQuota(opts?.account_id);
    await startProjectOnHost(this.project_id, opts);
    await query({
      db: db(),
      query: "UPDATE projects",
      where: { project_id: this.project_id },
      set: { last_started: new Date() },
    });
  };

  private loadHostId = async (): Promise<string> => {
    const { rows } = await getPool().query<{ host_id: string | null }>(
      "SELECT host_id FROM projects WHERE project_id=$1",
      [this.project_id],
    );
    const host_id = `${rows[0]?.host_id ?? ""}`.trim();
    if (!host_id) {
      throw new Error(`project ${this.project_id} is not assigned to a host`);
    }
    return host_id;
  };

  private sealCurrentRootfs = async (opts?: {
    lro_op_id?: string;
  }): Promise<{ image: string }> => {
    const host_id = await this.loadHostId();
    const client = await getProjectFileServerClient({
      project_id: this.project_id,
      timeout: ROOTFS_SEAL_TIMEOUT_MS,
    });
    await ensureProjectFileServerClientReady({
      project_id: this.project_id,
      client,
      maxWait: FILE_SERVER_READY_TIMEOUT_MS,
    });
    const upload = await issueRootfsReleaseArtifactUpload({
      host_id,
      artifact_kind: "full",
    });
    const lro: LroRef | undefined = opts?.lro_op_id
      ? {
          op_id: opts.lro_op_id,
          scope_type: "project",
          scope_id: this.project_id,
        }
      : undefined;
    const artifact = await client.publishRootfsImage({
      project_id: this.project_id,
      upload,
      lro,
    });
    const uploadResult =
      artifact.upload_result ??
      (await client.uploadRootfsReleaseArtifact({
        project_id: this.project_id,
        image: artifact.image,
        upload,
        lro,
      }));
    await upsertPublishedRootfsRelease({
      artifact,
      upload: {
        ...uploadResult,
        repo_id: uploadResult?.repo_id ?? upload.repo_id,
        repo_root: uploadResult?.repo_root ?? upload.repo_root,
        region: uploadResult?.region ?? upload.region,
        bucket_id: uploadResult?.bucket_id ?? upload.bucket_id,
        bucket_name: uploadResult?.bucket_name ?? upload.bucket_name,
        bucket_purpose: uploadResult?.bucket_purpose ?? upload.bucket_purpose,
        repo_selector: uploadResult?.repo_selector ?? upload.repo_selector,
        artifact_backend:
          uploadResult?.artifact_backend ?? upload.artifact_backend,
      },
    });
    return {
      image: artifact.image,
    };
  };

  // Get the state of the project -- state is just whether or not
  // it is runnig, stopping, starting.  It's not much info.
  state = async (): Promise<ProjectState> => {
    // rename everywhere to status?  state is a field, and status
    // is the whole object
    await this.ensureLocalOwnership();
    const runner = this.projectRunner();
    return await runner.status({ project_id: this.project_id });
  };

  status = async (): Promise<ProjectStatus> => {
    // deprecated?
    return {} as ProjectStatus;
  };

  start = async (opts?: {
    lro_op_id?: string;
    account_id?: string;
    managed_egress_override?: ManagedProjectEgressOverride;
    restore_backup_id?: string;
  }): Promise<void> => {
    await this.ensureLocalOwnership();
    if (isWorkspaceProjectRuntime()) {
      await this.projectRunner().start({ project_id: this.project_id });
      return;
    }
    await this.startOnHost(opts);
    if (process.env[DISABLE_ROOTFS_PORTABILITY_SEAL_ENV] === "1") {
      logger.warn("skipping project RootFS portability seal", {
        project_id: this.project_id,
        env: DISABLE_ROOTFS_PORTABILITY_SEAL_ENV,
      });
      return;
    }
    const current = await getCurrentProjectRootfsBinding({
      project_id: this.project_id,
    });
    if (!current?.image || current.release_id) {
      return;
    }
    try {
      const sealed = await this.sealCurrentRootfs({
        lro_op_id: opts?.lro_op_id,
      });
      await this.stop();
      await setProjectRootfsImageWithRollback({
        project_id: this.project_id,
        image: sealed.image,
        set_by_account_id: opts?.account_id,
      });
      await this.startOnHost(opts);
    } catch (err) {
      try {
        await this.stop();
      } catch (stopErr) {
        logger.warn("failed to stop project after RootFS seal error", {
          project_id: this.project_id,
          err: `${stopErr}`,
        });
      }
      throw new Error(`failed to seal project RootFS for portability: ${err}`);
    }
  };

  save = async (): Promise<void> => {
    // no-op
  };

  stop = async ({ force }: { force?: boolean } = {}): Promise<void> => {
    await this.ensureLocalOwnership();
    if (isWorkspaceProjectRuntime()) {
      await this.projectRunner().stop({
        project_id: this.project_id,
        force,
      });
      return;
    }
    if (force) {
      logger.debug("stop -- TODO -- force not implemented");
    }
    const { host_deleted, host_found, host_id, host_status, state } =
      await loadProjectStopState(this.project_id);
    if (!host_id) {
      logger.debug(
        `(project_id=${this.project_id}).stop: no assigned host; treating as already stopped`,
      );
      return;
    }
    if (!isActiveProjectState(state)) {
      logger.debug(
        `(project_id=${this.project_id}).stop: state=${state ?? "unknown"}; treating as already stopped`,
      );
      return;
    }
    if (
      !host_found ||
      host_deleted != null ||
      !isRunningProjectHostStatus(host_status)
    ) {
      logger.debug(
        `(project_id=${this.project_id}).stop: host=${host_id} status=${host_status ?? "missing"}; treating as already stopped`,
      );
      return;
    }
    await stopProjectOnHost(this.project_id);
  };

  restart = async (opts?: {
    lro_op_id?: string;
    account_id?: string;
  }): Promise<void> => {
    this.dbg("restart")();
    await this.stop();
    await this.start(opts);
  };

  wait = async (opts: {
    until: () => Promise<boolean>;
    maxTime: number;
  }): Promise<void> => {
    await until(
      async () => {
        if (await opts.until()) {
          logger.debug(`wait ${this.project_id} -- satisfied`);
          return true;
        }
        return false;
      },
      {
        start: 250,
        decay: 1.25,
        max: opts.maxTime,
        log: (...args) => logger.debug("wait", this.project_id, ...args),
      },
    );
  };

  // Everything the hub needs to know to connect to the project
  // via the TCP connection.  Raises error if anything can't be
  // determined.
  address = async (opts?: {
    account_id?: string;
  }): Promise<{
    host: string;
    port: number;
    secret_token: string;
  }> => {
    await this.ensureLocalOwnership();
    const dbg = this.dbg("address");
    dbg("first ensure is running");
    await this.start({ account_id: opts?.account_id });
    dbg("it is running");
    const status = await this.status();
    if (!status["hub-server.port"]) {
      throw Error("unable to determine project port");
    }
    const state = await this.state();
    const host = state.ip;
    if (!host) {
      throw Error("unable to determine host");
    }
    return {
      host,
      port: status["hub-server.port"],
      secret_token: await getProjectSecretToken(this.project_id),
    };
  };

  /* Reconfigure active projects in place when enforceable quotas change. */
  setAllQuotas = async (): Promise<void> => {
    await this.ensureLocalOwnership();
    const dbg = this.dbg("set_all_quotas");
    dbg();
    const current = await query({
      db: db(),
      select: ["state", "run_quota"],
      table: "projects",
      where: { project_id: this.project_id },
      one: true,
    });

    const nextRunQuota = await this.setRunQuota(null);
    const state = current?.state?.state;
    if (!isActiveProjectState(state)) {
      dbg("project not active; updated stored run_quota without restart");
      return;
    }

    if (isEqual(current.run_quota, nextRunQuota)) {
      dbg("running, but no quotas changed");
      return;
    } else {
      const runtimeConfigurationChanged = !isEqual(
        runQuotaForRestartComparison(current.run_quota),
        runQuotaForRestartComparison(nextRunQuota),
      );
      dbg(
        runtimeConfigurationChanged
          ? "running and a runtime quota changed; reconfigure live cgroup"
          : "running and only idle policy changed; update host metadata",
      );
      // CRITICAL: do not await on this host operation. The set_all_quotas call must
      // complete quickly (in an HTTP request), whereas restart can easily take 20s,
      // and there is no reason to wait on it. During a rolling upgrade, fall
      // back to the previous restart behavior if the assigned host is too old
      // to support live reconfiguration.
      (async () => {
        try {
          await updateProjectRunQuotaOnHost({
            project_id: this.project_id,
            run_quota: nextRunQuota,
            run_quota_revision: this.runQuotaRevision,
          });
          dbg("live quota reconfiguration worked");
        } catch (err) {
          if (!runtimeConfigurationChanged) {
            dbg(`live idle-policy update failed; not restarting -- ${err}`);
            return;
          }
          dbg(`live quota reconfiguration failed; restarting -- ${err}`);
          try {
            await this.restart();
            dbg("fallback restart worked");
          } catch (restartErr) {
            dbg(`fallback restart failed -- ${restartErr}`);
          }
        }
      })();
    }
  };

  computeQuota = async (account_id?: string) => {
    await this.setRunQuota(null, account_id);
  };

  // run_quota controls project resource limits and is shown in project
  // settings.  It still includes idle_timeout for compatibility and possible
  // future use, but current CoCalc-AI project hosts do not enforce idle stops.
  setRunQuota = async (
    run_quota: Quota | null,
    account_id?: string,
  ): Promise<Quota> => {
    await this.ensureLocalOwnership();
    let nextRunQuota = run_quota;
    // If null we compute it based on membership entitlements. Runtime capacity
    // comes from the runtime sponsor, while disk quota stays with the storage
    // sponsor so self-sponsoring cannot shrink an existing project volume.
    if (nextRunQuota == null) {
      const {
        users,
        last_active,
        last_started_by,
        runtime_sponsor_account_id,
        usage_account_id,
        course,
        host_id,
      } = await query({
        db: db(),
        select: [
          "users",
          "last_active",
          "last_started_by",
          "runtime_sponsor_account_id",
          "usage_account_id",
          "course",
          "host_id",
        ],
        table: "projects",
        where: { project_id: this.project_id },
        one: true,
      });

      const runtime_account_id =
        resolveRuntimeSponsorAccountId({
          runtime_sponsor_account_id,
          usage_account_id,
          course,
          users,
        }) ??
        pickAccountForQuota({
          account_id,
          users,
          last_active,
          last_started_by,
        });
      const storage_account_id = pickStorageAccountForQuota({
        usage_account_id,
        users,
        last_active,
        last_started_by,
      });
      const [runtimeDefaults, runtimeScheduling, browserIdleTimeoutSeconds] =
        await Promise.all([
          getMembershipProjectDefaultsForAccount(runtime_account_id),
          getMembershipRuntimeSchedulingForAccount(runtime_account_id),
          getMembershipBrowserIdleTimeoutForAccount(runtime_account_id),
        ]);
      const site_settings = await getQuotaSiteSettings(); // quick, usually cached
      nextRunQuota = quota(runtimeDefaults, undefined, site_settings);
      nextRunQuota.io_class = runtimeScheduling.io_class;
      nextRunQuota.shared_compute_priority =
        runtimeScheduling.shared_compute_priority;
      // Launchpad/Lite uses a workspace-local runtime and has no direct
      // browser-to-project-host presence channel.
      nextRunQuota.browser_idle_timeout = isWorkspaceProjectRuntime()
        ? 0
        : browserIdleTimeoutSeconds;

      if (storage_account_id && storage_account_id !== runtime_account_id) {
        const storageDefaults =
          await getMembershipProjectDefaultsForAccount(storage_account_id);
        const storageQuota = quota(storageDefaults, undefined, site_settings);
        if (storageQuota.disk_quota != null) {
          nextRunQuota.disk_quota = storageQuota.disk_quota;
        }
      }
      nextRunQuota = await applyProjectEntitlementOverrideToRunQuota({
        project_id: this.project_id,
        run_quota: nextRunQuota,
      });
      nextRunQuota = await applyHostRuntimePolicyToRunQuota(
        nextRunQuota,
        host_id,
      );
      nextRunQuota = withCocalcAiRuntimeSemantics(nextRunQuota);
    }

    if (nextRunQuota == null) {
      throw new Error("unable to compute project run_quota");
    }

    const serialized = JSON.stringify(nextRunQuota);
    try {
      const { rows } = await getPool().query<{ run_quota_revision: string }>(
        `
          UPDATE projects
          SET run_quota_revision =
                CASE
                  WHEN run_quota IS DISTINCT FROM $2::jsonb
                    THEN COALESCE(run_quota_revision, 0) + 1
                  ELSE COALESCE(run_quota_revision, 0)
                END,
              run_quota = $2::jsonb,
              last_started_by = CASE WHEN $3::uuid IS NULL
                                     THEN last_started_by
                                     ELSE $3::uuid END
          WHERE project_id = $1
          RETURNING COALESCE(run_quota_revision, 0)::text AS run_quota_revision
        `,
        [this.project_id, serialized, account_id ?? null],
      );
      if (!rows[0]) {
        throw new Error(`project ${this.project_id} not found`);
      }
      this.runQuotaRevision = Number(rows[0].run_quota_revision);
    } catch (err) {
      if ((err as { code?: string })?.code !== "42703") {
        throw err;
      }
      // Mixed-version rollout compatibility until the additive column exists.
      await query({
        db: db(),
        query: "UPDATE projects",
        where: { project_id: this.project_id },
        set: {
          run_quota: nextRunQuota,
          ...(account_id ? { last_started_by: account_id } : {}),
        },
      });
      this.runQuotaRevision = 0;
    }

    logger.debug("updated run_quota", {
      project_id: this.project_id,
      run_quota_revision: this.runQuotaRevision,
      run_quota: nextRunQuota,
    });
    return nextRunQuota;
  };
}

function pickAccountForQuota({
  account_id,
  users,
  last_active,
  last_started_by,
}: {
  account_id?: string;
  users?: ProjectUsers;
  last_active?: Record<string, unknown> | null;
  last_started_by?: string | null;
}): string | undefined {
  if (account_id) {
    return account_id;
  }
  if (last_started_by) {
    return last_started_by;
  }
  const user_ids = users ? Object.keys(users) : [];
  if (user_ids.length === 1) {
    return user_ids[0];
  }
  const last_active_account = pickLastActiveAccount(last_active, users);
  if (last_active_account) {
    return last_active_account;
  }
  return user_ids.find((id) => users?.[id]?.group === "owner") ?? user_ids[0];
}

function pickStorageAccountForQuota({
  usage_account_id,
  users,
  last_active,
  last_started_by,
}: {
  usage_account_id?: string | null;
  users?: ProjectUsers;
  last_active?: Record<string, unknown> | null;
  last_started_by?: string | null;
}): string | undefined {
  const usageAccount = `${usage_account_id ?? ""}`.trim();
  if (usageAccount) return usageAccount;
  return (
    getProjectOwnerAccountId(users) ??
    pickAccountForQuota({
      users,
      last_active,
      last_started_by,
    })
  );
}

function pickLastActiveAccount(
  last_active?: Record<string, unknown> | null,
  users?: ProjectUsers,
): string | undefined {
  if (!last_active) return;
  let best_id: string | undefined;
  let best_time = -1;
  for (const [account_id, raw_value] of Object.entries(last_active)) {
    if (users && !users[account_id]) {
      continue;
    }
    const time = parseLastActiveTime(raw_value);
    if (time != null && time > best_time) {
      best_time = time;
      best_id = account_id;
    }
  }
  return best_id;
}

function parseLastActiveTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return undefined;
}
