/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map, Set, fromJS } from "immutable";
import { Modal } from "antd";
import { isEqual } from "lodash";
import { alert_message } from "@cocalc/frontend/alerts";
import { Actions, redux } from "@cocalc/frontend/app-framework";
import { set_window_title } from "@cocalc/frontend/browser";
import api from "@cocalc/frontend/client/api";
import { getSharedAccountDStream } from "@cocalc/frontend/conat/account-dstream";
import { COCALC_MINIMAL } from "@cocalc/frontend/fullscreen";
import { markdown_to_html } from "@cocalc/frontend/markdown";
import { notifyCollabInvitesChanged } from "@cocalc/frontend/collaborators/invite-events";
import type { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { once, withTimeout } from "@cocalc/util/async-utils";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";
import {
  accountFeedStreamName,
  type AccountFeedEvent,
  type AccountFeedProjectRow,
} from "@cocalc/conat/hub/api/account-feed";
import type {
  ProjectTheme,
  StudentProjectFunctionality,
} from "@cocalc/util/db-schema/projects";
import { defaults, is_valid_uuid_string } from "@cocalc/util/misc";
import { ProjectsState, store } from "./store";
import { refresh_projects_table, switch_to_project } from "./table";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { defaultOpenProjectTarget } from "./open-project-default";
import { evaluateHostOperational, hostLabel } from "./host-operational";
import { getProjectUrlPath } from "@cocalc/frontend/project-routing";
import {
  invalidateProjectFields,
  publishProjectDetailInvalidation,
} from "@cocalc/frontend/project/use-project-field";
import { ensureProjectCourseInfo } from "@cocalc/frontend/project/use-project-course";
import { getBackups as getProjectBackups } from "@cocalc/frontend/project/archive-info";
import {
  buildOfflineMoveConfirmationDialog,
  parseOfflineMoveConfirmationError,
} from "./offline-move-confirmation";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { isTerminal } from "@cocalc/frontend/lro/utils";
import { extractRuntimeSponsorDenial } from "@cocalc/util/runtime-sponsor-denial";

import type {
  CourseInfo,
  Datastore,
  EnvVars,
  EnvVarsRecord,
} from "@cocalc/util/db-schema/projects";
export type { Datastore, EnvVars, EnvVarsRecord };

const PROJECTION_ONLY_FIELD = "__projection_only";
const PROJECTED_PROJECT_BOOTSTRAP_LIMIT = 2000;

function dateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function lastActiveMap(last_active?: Record<string, any>): Map<string, Date> {
  let next = Map<string, Date>().asMutable();
  for (const [account_id, value] of Object.entries(last_active ?? {})) {
    const date = dateOrNull(value);
    if (date != null) {
      next = next.set(account_id, date);
    }
  }
  return next.asImmutable();
}

function preserveNewerLastActive(
  currentLastActive: Map<string, Date> | undefined,
  nextLastActive: Map<string, Date> | undefined,
): Map<string, Date> | undefined {
  if (currentLastActive == null || nextLastActive == null) {
    return nextLastActive;
  }
  let merged = nextLastActive;
  for (const [account_id, currentValue] of currentLastActive) {
    const currentMs = dateValueMs(currentValue);
    if (currentMs == null) {
      continue;
    }
    const nextMs = dateValueMs(nextLastActive.get(account_id));
    if (nextMs == null || nextMs < currentMs) {
      merged = merged.set(account_id, currentValue);
    }
  }
  return merged;
}

export function buildProjectRecordFromFeedRow(
  row: AccountFeedProjectRow,
): Map<string, any> {
  let record = fromJS({
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    name: row.name ?? undefined,
    theme: row.theme ?? null,
    host_id: row.host_id,
    owning_bay_id: row.owning_bay_id,
    users: row.users ?? {},
    state: row.state ?? {},
  }) as Map<string, any>;
  record = record
    .set("last_edited", dateOrNull(row.last_edited))
    .set("last_active", lastActiveMap(row.last_active));
  if ("last_backup" in row) {
    record = record.set("last_backup", dateOrNull(row.last_backup));
  }
  return record;
}

type ProjectIndexBootstrapRow = {
  account_id?: string | null;
  project_id: string;
  owning_bay_id?: string | null;
  host_id?: string | null;
  title?: string | null;
  description?: string | null;
  theme?: Record<string, any> | null;
  users_summary?: Record<string, any> | null;
  state_summary?: Record<string, any> | null;
  last_edited?: string | Date | null;
  last_backup?: string | Date | null;
  last_activity_at?: string | Date | null;
  sort_key?: string | Date | null;
  updated_at?: string | Date | null;
  is_hidden?: boolean | null;
};

function readMaybeImmutable(value: any, key: string): any {
  return value?.get?.(key) ?? value?.[key];
}

function readMaybeImmutableIn(value: any, path: string[]): any {
  if (value?.getIn) {
    return value.getIn(path);
  }
  let current = value;
  for (const key of path) {
    current = readMaybeImmutable(current, key);
    if (current == null) return current;
  }
  return current;
}

function stateTimeMs(state: any): number | undefined {
  const time = readMaybeImmutable(state, "time");
  const ms =
    typeof time === "number" ? time : new Date(`${time ?? ""}`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function eventTimeMs(
  value: number | string | Date | null | undefined,
): number | undefined {
  const ms =
    typeof value === "number" ? value : new Date(`${value ?? ""}`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function dateValueMs(value: unknown): number | undefined {
  const date = dateOrNull(value);
  return date != null ? date.getTime() : undefined;
}

function isFreshAuthRequiredError(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.trim().toLowerCase();
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return code === "fresh_auth_required" || message.includes("fresh auth");
}

function isProjectHardDeleting(project: any): boolean {
  return project?.getIn?.(["state", "state"]) === "deleting";
}

function isProjectHardDeleteBlocked(project: any): boolean {
  const state = project?.getIn?.(["state", "state"]);
  return state === "deleting" || state === "delete_failed";
}

function projectHardDeletingMessage(): string {
  return "This project is being permanently deleted. It cannot be opened or started.";
}

type DirectProjectBootstrapRow = {
  project_id: string;
  title?: string | null;
  description?: string | null;
  name?: string | null;
  theme?: Record<string, any> | null;
  host_id?: string | null;
  owning_bay_id?: string | null;
  users?: Record<string, any> | null;
  state?: Record<string, any> | null;
  last_active?: Record<string, any> | null;
  last_edited?: string | Date | null;
  last_backup?: string | Date | null;
};

// Define projects actions
export class ProjectsActions extends Actions<ProjectsState> {
  private static HOST_INFO_TTL_MS = 60_000;
  private static HOST_INFO_RPC_TIMEOUT_MS = 5_000;
  private static ARCHIVE_RPC_TIMEOUT_MS = 30_000;
  private static REALTIME_FEED_BATCH_MS = 50;
  private static CREATE_PROJECT_FEED_WAIT_TIMEOUT_S = 5;
  private static MOVE_TRANSITION_GRACE_MS = 5 * 60_000;
  private static ACTIVE_MOVE_RETENTION_MS = 8 * 60 * 60_000;
  private signedInListener?: () => void;
  private signedOutListener?: () => void;
  private conatConnectedListener?: () => void;
  private accountStoreReadyListener?: () => void;
  private accountStoreSubscription?: () => void;
  private observedAccountStore?: {
    get?: (key: string) => unknown;
    on?: (event: string, cb: () => void) => void;
    removeListener?: (event: string, cb: () => void) => void;
  };
  private realtimeFeed?: DStream<AccountFeedEvent>;
  private realtimeFeedAccountId?: string;
  private realtimeFeedFlushTimer?: ReturnType<typeof setTimeout>;
  private pendingProjectFeedUpserts: Record<
    string,
    {
      row: AccountFeedProjectRow;
      source_host_id?: string;
      updated_at?: number;
    }
  > = Object.create(null);
  private pendingProjectFeedRemovals: Record<string, number | undefined> =
    Object.create(null);
  private recentProjectHostTransitionUntil: Record<string, number> =
    Object.create(null);
  private recentProjectMoveTransitionUntil: Record<string, number> =
    Object.create(null);
  private recentProjectMoveSummaries: Record<string, LroSummary> =
    Object.create(null);
  private recentHostInfoLookupFailureAt: Record<string, number> =
    Object.create(null);

  _init() {
    this.signedInListener = () => {
      void this.ensureRealtimeFeedForCurrentAccount();
    };
    this.signedOutListener = () => {
      this.closeRealtimeFeed();
      this.recentProjectMoveSummaries = Object.create(null);
      this.recentProjectMoveTransitionUntil = Object.create(null);
    };
    this.conatConnectedListener = () => {
      void this.ensureRealtimeFeedForCurrentAccount();
    };
    this.accountStoreReadyListener = () => {
      void this.ensureRealtimeFeedForCurrentAccount();
    };
    webapp_client.on("signed_in", this.signedInListener);
    webapp_client.on("signed_out", this.signedOutListener);
    webapp_client.conat_client.on("connected", this.conatConnectedListener);
    this.observeAccountStoreReady();
    void this.ensureRealtimeFeedForCurrentAccount();
  }

  public override destroy = (): void => {
    if (this.signedInListener != null) {
      webapp_client.removeListener?.("signed_in", this.signedInListener);
      this.signedInListener = undefined;
    }
    if (this.signedOutListener != null) {
      webapp_client.removeListener?.("signed_out", this.signedOutListener);
      this.signedOutListener = undefined;
    }
    if (this.conatConnectedListener != null) {
      webapp_client.conat_client.removeListener?.(
        "connected",
        this.conatConnectedListener,
      );
      this.conatConnectedListener = undefined;
    }
    if (this.accountStoreSubscription != null) {
      this.accountStoreSubscription();
      this.accountStoreSubscription = undefined;
    }
    if (
      this.accountStoreReadyListener != null &&
      this.observedAccountStore != null
    ) {
      this.observedAccountStore.removeListener?.(
        "is_ready",
        this.accountStoreReadyListener,
      );
      this.observedAccountStore = undefined;
      this.accountStoreReadyListener = undefined;
    }
    this.closeRealtimeFeed();
    Actions.prototype.destroy.call(this);
  };

  ensure_host_info = reuseInFlight(async (host_id?: string, force = false) => {
    if (!host_id) return;
    const hostInfo = store.get("host_info");
    const existing = hostInfo?.get(host_id);
    const now = Date.now();
    if (existing && !force) {
      const updatedAt = existing.get("updated_at");
      if (typeof updatedAt === "number") {
        if (now - updatedAt < ProjectsActions.HOST_INFO_TTL_MS) {
          return existing;
        }
      }
    }
    try {
      const info: HostConnectionInfo = await withTimeout(
        webapp_client.conat_client.hub.hosts.resolveHostConnection({
          host_id,
        }),
        ProjectsActions.HOST_INFO_RPC_TIMEOUT_MS,
      );
      const next = (hostInfo ?? Map<string, any>()).set(
        host_id,
        fromJS({ ...info, updated_at: now }),
      );
      if (next) {
        this.setState({ host_info: next } as ProjectsState);
      }
      delete this.recentHostInfoLookupFailureAt[host_id];
      return next?.get(host_id);
    } catch (err) {
      const errString = `${err}`;
      const isHostMissing = errString.includes("host not found");
      const previousFailureAt = this.recentHostInfoLookupFailureAt[host_id];
      if (
        !isHostMissing ||
        previousFailureAt == null ||
        now - previousFailureAt >= ProjectsActions.HOST_INFO_TTL_MS
      ) {
        console.warn("ensure_host_info failed", {
          host_id,
          err: errString,
        });
      }
      if (isHostMissing) {
        this.recentHostInfoLookupFailureAt[host_id] = now;
      }
      return;
    }
  });
  private getProjectTable = async () => {
    const the_table = this.redux.getTable("projects");
    if (the_table == null) {
      return null;
    }
    const state = the_table._table.get_state();
    if (state == "closed") {
      return null;
    }
    if (state == "disconnected") {
      await once(the_table._table, "connected");
    }
    return the_table;
  };

  private getAccountId(): string | undefined {
    return this.redux.getStore("account")?.get("account_id");
  }

  private closeRealtimeFeed(): void {
    this.flushPendingProjectFeedChanges();
    if (this.realtimeFeed != null) {
      this.realtimeFeed.removeListener("change", this.handleRealtimeFeedChange);
      this.realtimeFeed.removeListener(
        "history-gap",
        this.handleRealtimeFeedHistoryGap,
      );
      this.realtimeFeed = undefined;
    }
    this.realtimeFeedAccountId = undefined;
  }

  private handleRealtimeFeedChange = (event?: AccountFeedEvent): void => {
    if (event == null) {
      return;
    }
    switch (event.type) {
      case "project.upsert":
        this.queueProjectFeedUpsert(event.project, event.ts);
        break;
      case "project.remove":
        this.queueProjectFeedRemove(event.project_id, event.ts);
        break;
      case "project.detail.invalidate":
        if (event.fields.includes("course")) {
          store.clearOpenAICache();
        }
        invalidateProjectFields({
          project_id: event.project_id,
          fields: event.fields,
        });
        break;
      case "lro.summary":
        this.noteProjectMoveSummary(event.summary, event.ts);
        break;
      default:
        break;
    }
  };

  private handleRealtimeFeedHistoryGap = (): void => {
    this.flushPendingProjectFeedChanges();
    void refresh_projects_table();
    void this.loadProjectedProjectsForCurrentAccount(this.getAccountId());
  };

  private observeAccountStoreReady(): void {
    const onReady = this.accountStoreReadyListener;
    if (onReady == null) {
      return;
    }

    const attachStore = (
      store = this.redux.getStore(
        "account",
      ) as typeof this.observedAccountStore,
    ): void => {
      if (store === this.observedAccountStore) {
        return;
      }
      this.observedAccountStore?.removeListener?.("is_ready", onReady);
      this.observedAccountStore = store;
      store?.on?.("is_ready", onReady);
      if (store?.get?.("is_ready")) {
        onReady();
      }
    };

    attachStore();
    const subscribe = this.redux.reduxStore?.subscribe?.bind(
      this.redux.reduxStore,
    );
    this.accountStoreSubscription = subscribe?.(() => {
      attachStore();
    });
  }

  public async ensureRealtimeFeedForCurrentAccount(): Promise<void> {
    if (!webapp_client.is_signed_in()) {
      this.closeRealtimeFeed();
      return;
    }
    const account_id = this.getAccountId();
    if (account_id == null) {
      return;
    }
    if (
      this.realtimeFeed != null &&
      this.realtimeFeedAccountId === account_id &&
      !this.realtimeFeed.isClosed()
    ) {
      return;
    }
    this.closeRealtimeFeed();
    try {
      const feed = await getSharedAccountDStream<AccountFeedEvent>({
        account_id,
        name: accountFeedStreamName(),
        ephemeral: true,
        maxListeners: 100,
      });
      feed.on("change", this.handleRealtimeFeedChange);
      feed.on("history-gap", this.handleRealtimeFeedHistoryGap);
      this.realtimeFeed = feed;
      this.realtimeFeedAccountId = account_id;
    } catch (err) {
      console.warn("project realtime feed error", err);
    }
    await this.loadProjectedProjectsForCurrentAccount(account_id);
  }

  private loadProjectedProjectsForCurrentAccount = reuseInFlight(
    async (account_id?: string): Promise<void> => {
      if (!account_id || !webapp_client.is_signed_in()) {
        return;
      }
      let resp: any;
      try {
        resp = await webapp_client.async_query({
          query: {
            account_project_index: [
              {
                account_id,
                project_id: null,
                owning_bay_id: null,
                host_id: null,
                title: null,
                description: null,
                theme: null,
                users_summary: null,
                state_summary: null,
                last_edited: null,
                last_backup: null,
                last_activity_at: null,
                sort_key: null,
                updated_at: null,
                is_hidden: null,
              },
            ],
          },
          options: [{ limit: PROJECTED_PROJECT_BOOTSTRAP_LIMIT }],
        });
      } catch (err) {
        console.warn("project projected bootstrap failed", err);
        return;
      }
      const rows = resp?.query?.account_project_index;
      if (!Array.isArray(rows)) {
        return;
      }
      let project_map = store.get("project_map") ?? Map<string, any>();
      let changed = false;
      const seenProjectedIds = new globalThis.Set<string>();
      const hiddenProjectedIds = new globalThis.Set<string>();
      const projectsToClose: string[] = [];
      for (const row of rows as ProjectIndexBootstrapRow[]) {
        if (!row?.project_id) {
          continue;
        }
        if (row.is_hidden === true) {
          hiddenProjectedIds.add(row.project_id);
          continue;
        }
        seenProjectedIds.add(row.project_id);
        const hadProject = project_map.has(row.project_id);
        const currentProject =
          project_map.get(row.project_id) ?? Map<string, any>();
        const currentHostId = currentProject.get("host_id");
        const projectedRecord = buildProjectRecordFromFeedRow({
          project_id: row.project_id,
          title: row.title ?? "",
          description: row.description ?? "",
          name: null,
          theme: row.theme ?? null,
          host_id: row.host_id ?? null,
          owning_bay_id: `${row.owning_bay_id ?? ""}`.trim() || DEFAULT_BAY_ID,
          users: row.users_summary ?? {},
          state: row.state_summary ?? {},
          last_edited: dateOrNull(row.last_edited)?.toISOString() ?? null,
          last_backup: dateOrNull(row.last_backup)?.toISOString() ?? null,
          last_active:
            row.last_activity_at == null
              ? {}
              : { [account_id]: row.last_activity_at },
        });
        let nextProject = currentProject.mergeDeep(projectedRecord);
        if (
          typeof currentHostId === "string" &&
          currentHostId &&
          this.shouldPreserveLocalHostIdAfterMove({
            project_id: row.project_id,
            current_host_id: currentHostId,
            incoming_host_id:
              typeof row.host_id === "string" && row.host_id
                ? row.host_id
                : undefined,
            incoming_updated_at: row.updated_at ?? row.sort_key,
          })
        ) {
          nextProject = nextProject.set("host_id", currentHostId);
        }
        if (
          this.shouldPreserveNewerLocalState({
            currentProject,
            incomingState: row.state_summary ?? undefined,
          })
        ) {
          nextProject = nextProject.set("state", currentProject.get("state"));
        }
        if (
          this.shouldPreserveNewerLocalLastEdited({
            currentProject,
            incomingLastEdited: row.last_edited ?? undefined,
          })
        ) {
          nextProject = nextProject.set(
            "last_edited",
            currentProject.get("last_edited"),
          );
        }
        if (
          this.shouldPreserveNewerLocalLastBackup({
            currentProject,
            incomingLastBackup: row.last_backup ?? undefined,
          })
        ) {
          nextProject = nextProject.set(
            "last_backup",
            currentProject.get("last_backup"),
          );
        }
        nextProject = this.mergeNewerLocalLastActive(
          currentProject,
          nextProject,
        );
        if (currentProject.get(PROJECTION_ONLY_FIELD) === true || !hadProject) {
          nextProject = nextProject.set(PROJECTION_ONLY_FIELD, true);
        } else {
          nextProject = nextProject.delete(PROJECTION_ONLY_FIELD);
        }
        this.releaseRoutingIfCurrentAccountRegainedMembership({
          project_id: row.project_id,
          currentProject,
          nextProject,
        });
        project_map = project_map.set(row.project_id, nextProject);
        changed = true;
      }
      for (const project_id of hiddenProjectedIds) {
        const project = project_map.get(project_id);
        if (project?.get(PROJECTION_ONLY_FIELD) !== true) {
          continue;
        }
        if (this.shouldRetainOpenProjectDuringMoveTransition(project_id)) {
          continue;
        }
        project_map = project_map.delete(project_id);
        changed = true;
        if (this.isProjectOpen(project_id)) {
          projectsToClose.push(project_id);
        }
      }
      if (rows.length < PROJECTED_PROJECT_BOOTSTRAP_LIMIT) {
        for (const [project_id, project] of project_map) {
          if (
            project.get(PROJECTION_ONLY_FIELD) === true &&
            !seenProjectedIds.has(project_id)
          ) {
            if (this.shouldRetainOpenProjectDuringMoveTransition(project_id)) {
              continue;
            }
            project_map = project_map.delete(project_id);
            changed = true;
            if (this.isProjectOpen(project_id)) {
              projectsToClose.push(project_id);
            }
          }
        }
      }
      if (rows.length === 0) {
        if (changed) {
          this.setState({ project_map } as ProjectsState);
        }
        for (const project_id of projectsToClose) {
          this.set_project_closed(project_id);
        }
        return;
      }
      if (changed) {
        this.setState({ project_map } as ProjectsState);
      }
      for (const project_id of projectsToClose) {
        this.set_project_closed(project_id);
      }
    },
  );

  private shouldPreserveLocalHostIdAfterMove({
    project_id,
    current_host_id,
    incoming_host_id,
    incoming_updated_at,
  }: {
    project_id: string;
    current_host_id?: string;
    incoming_host_id?: string;
    incoming_updated_at?: number | string | Date | null;
  }): boolean {
    if (
      !current_host_id ||
      !incoming_host_id ||
      current_host_id === incoming_host_id
    ) {
      return false;
    }
    const projectStore = this.redux.getProjectStore?.(project_id);
    const moveLro = projectStore?.get?.("move_lro");
    if (!moveLro) {
      return false;
    }
    const moveTimestamp =
      readMaybeImmutableIn(moveLro, ["summary", "updated_at"]) ??
      readMaybeImmutableIn(moveLro, ["summary", "started_at"]) ??
      readMaybeImmutableIn(moveLro, ["summary", "created_at"]) ??
      readMaybeImmutable(moveLro, "updated_at") ??
      readMaybeImmutableIn(moveLro, ["last_event", "ts"]);
    const moveMs =
      typeof moveTimestamp === "number"
        ? moveTimestamp
        : new Date(`${moveTimestamp ?? ""}`).getTime();
    if (!Number.isFinite(moveMs)) {
      return false;
    }
    const incomingMs =
      typeof incoming_updated_at === "number"
        ? incoming_updated_at
        : new Date(`${incoming_updated_at ?? ""}`).getTime();
    if (!Number.isFinite(incomingMs)) {
      return true;
    }
    return incomingMs < moveMs;
  }

  private shouldPreserveNewerLocalState({
    currentProject,
    incomingState,
  }: {
    currentProject: Map<string, any>;
    incomingState?: Record<string, any> | null;
  }): boolean {
    if (incomingState == null) {
      return false;
    }
    const currentState = currentProject.get("state");
    if (currentState == null) {
      return false;
    }
    const currentMs = stateTimeMs(currentState);
    if (currentMs == null) {
      return false;
    }
    const incomingMs = stateTimeMs(incomingState);
    return incomingMs == null || incomingMs < currentMs;
  }

  private shouldPreserveNewerLocalLastEdited({
    currentProject,
    incomingLastEdited,
  }: {
    currentProject: Map<string, any>;
    incomingLastEdited?: string | Date | null;
  }): boolean {
    const currentMs = dateValueMs(currentProject.get("last_edited"));
    if (currentMs == null) {
      return false;
    }
    const incomingMs = dateValueMs(incomingLastEdited);
    return incomingMs == null || incomingMs < currentMs;
  }

  private shouldPreserveNewerLocalLastBackup({
    currentProject,
    incomingLastBackup,
  }: {
    currentProject: Map<string, any>;
    incomingLastBackup?: string | Date | null;
  }): boolean {
    const currentMs = dateValueMs(currentProject.get("last_backup"));
    if (currentMs == null) {
      return false;
    }
    const incomingMs = dateValueMs(incomingLastBackup);
    return incomingMs == null || incomingMs < currentMs;
  }

  private mergeNewerLocalLastActive(
    currentProject: Map<string, any>,
    nextProject: Map<string, any>,
  ): Map<string, any> {
    const merged = preserveNewerLastActive(
      currentProject.get("last_active"),
      nextProject.get("last_active"),
    );
    return merged != null
      ? nextProject.set("last_active", merged)
      : nextProject;
  }

  private mergeLocalProjectUsers(
    currentProject: Map<string, any>,
    nextProject: Map<string, any>,
  ): Map<string, any> {
    const currentUsers = currentProject.get("users");
    const nextUsers = nextProject.get("users");
    if (currentUsers == null || nextUsers == null) {
      return nextProject;
    }
    let mergedUsers = nextUsers;
    for (const [account_id, nextUser] of nextUsers) {
      const currentUser = currentUsers.get(account_id);
      if (currentUser == null) {
        continue;
      }
      mergedUsers = mergedUsers.set(
        account_id,
        currentUser.mergeDeep(nextUser),
      );
    }
    return nextProject.set("users", mergedUsers);
  }

  private mergeProjectFeedRow(
    currentProject: Map<string, any>,
    row: AccountFeedProjectRow,
  ): Map<string, any> {
    const incomingProject = buildProjectRecordFromFeedRow(row);
    // Realtime feed rows contain the authoritative membership map.  Do not
    // deep-merge users, since removed collaborators/previous owners must
    // disappear immediately without requiring a browser refresh.
    return currentProject
      .mergeDeep(incomingProject)
      .set("users", incomingProject.get("users"));
  }

  private releaseRoutingIfCurrentAccountRegainedMembership({
    project_id,
    currentProject,
    nextProject,
  }: {
    project_id: string;
    currentProject: Map<string, any>;
    nextProject: Map<string, any>;
  }): void {
    const account_id = this.getAccountId();
    if (!account_id) {
      return;
    }
    const currentUsers = currentProject.get("users");
    if (
      currentUsers != null &&
      currentProject.getIn(["users", account_id]) == null &&
      nextProject.getIn(["users", account_id]) != null
    ) {
      webapp_client.conat_client.releaseProjectHostRouting({ project_id });
    }
  }

  private queueProjectFeedUpsert(
    row: AccountFeedProjectRow,
    updated_at?: number,
  ): void {
    const existing = this.pendingProjectFeedUpserts[row.project_id];
    const existingMs = eventTimeMs(existing?.updated_at);
    const incomingMs = eventTimeMs(updated_at);
    const pendingRemovalMs = eventTimeMs(
      this.pendingProjectFeedRemovals[row.project_id],
    );
    if (
      existing != null &&
      existingMs != null &&
      incomingMs != null &&
      existingMs > incomingMs
    ) {
      return;
    }
    if (
      pendingRemovalMs != null &&
      incomingMs != null &&
      pendingRemovalMs > incomingMs
    ) {
      return;
    }
    this.pendingProjectFeedUpserts[row.project_id] = {
      row,
      source_host_id:
        existing?.source_host_id ??
        (store.get("project_map")?.get(row.project_id)?.get("host_id") as
          | string
          | undefined) ??
        undefined,
      updated_at,
    };
    delete this.pendingProjectFeedRemovals[row.project_id];
    this.scheduleProjectFeedFlush();
  }

  private queueProjectFeedRemove(
    project_id: string,
    updated_at?: number,
  ): void {
    const pendingUpsert = this.pendingProjectFeedUpserts[project_id];
    const pendingUpsertMs = eventTimeMs(pendingUpsert?.updated_at);
    const incomingMs = eventTimeMs(updated_at);
    if (
      pendingUpsert != null &&
      pendingUpsertMs != null &&
      incomingMs != null &&
      pendingUpsertMs > incomingMs
    ) {
      return;
    }
    const existingRemovalMs = eventTimeMs(
      this.pendingProjectFeedRemovals[project_id],
    );
    if (
      existingRemovalMs != null &&
      incomingMs != null &&
      existingRemovalMs > incomingMs
    ) {
      return;
    }
    delete this.pendingProjectFeedUpserts[project_id];
    this.pendingProjectFeedRemovals[project_id] = updated_at;
    this.scheduleProjectFeedFlush();
  }

  private scheduleProjectFeedFlush(): void {
    if (this.realtimeFeedFlushTimer != null) {
      return;
    }
    this.realtimeFeedFlushTimer = setTimeout(() => {
      this.realtimeFeedFlushTimer = undefined;
      this.flushPendingProjectFeedChanges();
    }, ProjectsActions.REALTIME_FEED_BATCH_MS);
  }

  private flushPendingProjectFeedChanges(): void {
    if (this.realtimeFeedFlushTimer != null) {
      clearTimeout(this.realtimeFeedFlushTimer);
      this.realtimeFeedFlushTimer = undefined;
    }
    const pendingUpserts = Object.values(this.pendingProjectFeedUpserts);
    const pendingRemovals = Object.keys(this.pendingProjectFeedRemovals);
    this.pendingProjectFeedUpserts = Object.create(null);
    this.pendingProjectFeedRemovals = Object.create(null);
    if (pendingUpserts.length === 0 && pendingRemovals.length === 0) {
      return;
    }

    let project_map = store.get("project_map") ?? Map<string, any>();
    let changed = false;
    const hostChanges: Array<{
      project_id: string;
      source_host_id?: string;
      dest_host_id?: string;
    }> = [];
    const projectsToClose: string[] = [];

    for (const { row, source_host_id, updated_at } of pendingUpserts) {
      const incoming_host_id =
        typeof row.host_id === "string" && row.host_id
          ? row.host_id
          : undefined;
      const currentProject =
        project_map.get(row.project_id) ?? Map<string, any>();
      let nextProject = this.mergeProjectFeedRow(currentProject, row);
      if (
        typeof source_host_id === "string" &&
        source_host_id &&
        this.shouldPreserveLocalHostIdAfterMove({
          project_id: row.project_id,
          current_host_id: source_host_id,
          incoming_host_id,
          incoming_updated_at: updated_at,
        })
      ) {
        nextProject = nextProject.set("host_id", source_host_id);
      }
      if (
        this.shouldPreserveNewerLocalState({
          currentProject,
          incomingState: row.state ?? undefined,
        })
      ) {
        nextProject = nextProject.set("state", currentProject.get("state"));
      }
      if (
        this.shouldPreserveNewerLocalLastEdited({
          currentProject,
          incomingLastEdited: row.last_edited ?? undefined,
        })
      ) {
        nextProject = nextProject.set(
          "last_edited",
          currentProject.get("last_edited"),
        );
      }
      if (
        this.shouldPreserveNewerLocalLastBackup({
          currentProject,
          incomingLastBackup: row.last_backup ?? undefined,
        })
      ) {
        nextProject = nextProject.set(
          "last_backup",
          currentProject.get("last_backup"),
        );
      }
      nextProject = this.mergeNewerLocalLastActive(currentProject, nextProject);
      this.releaseRoutingIfCurrentAccountRegainedMembership({
        project_id: row.project_id,
        currentProject,
        nextProject,
      });
      project_map = project_map.set(row.project_id, nextProject);
      changed = true;
      hostChanges.push({
        project_id: row.project_id,
        source_host_id,
        dest_host_id:
          (nextProject.get("host_id") as string | undefined) ?? undefined,
      });
    }

    for (const project_id of pendingRemovals) {
      if (!project_map.has(project_id)) {
        continue;
      }
      if (this.shouldRetainOpenProjectDuringMoveTransition(project_id)) {
        continue;
      }
      project_map = project_map.delete(project_id);
      changed = true;
      if (this.isProjectOpen(project_id)) {
        projectsToClose.push(project_id);
      }
    }

    if (changed) {
      this.setState({ project_map } as ProjectsState);
    }
    for (const change of hostChanges) {
      this.handleOpenProjectHostChange(change);
    }
    for (const project_id of projectsToClose) {
      this.set_project_closed(project_id);
    }
  }

  private upsertProjectMapFromRow(row: AccountFeedProjectRow): void {
    const currentProject =
      store.get("project_map")?.get(row.project_id) ?? Map<string, any>();
    let nextProject = this.mergeProjectFeedRow(currentProject, row);
    if (
      this.shouldPreserveNewerLocalState({
        currentProject,
        incomingState: row.state ?? undefined,
      })
    ) {
      nextProject = nextProject.set("state", currentProject.get("state"));
    }
    if (
      this.shouldPreserveNewerLocalLastEdited({
        currentProject,
        incomingLastEdited: row.last_edited ?? undefined,
      })
    ) {
      nextProject = nextProject.set(
        "last_edited",
        currentProject.get("last_edited"),
      );
    }
    if (
      this.shouldPreserveNewerLocalLastBackup({
        currentProject,
        incomingLastBackup: row.last_backup ?? undefined,
      })
    ) {
      nextProject = nextProject.set(
        "last_backup",
        currentProject.get("last_backup"),
      );
    }
    nextProject = this.mergeNewerLocalLastActive(currentProject, nextProject);
    this.releaseRoutingIfCurrentAccountRegainedMembership({
      project_id: row.project_id,
      currentProject,
      nextProject,
    });
    const project_map = (store.get("project_map") ?? Map<string, any>()).set(
      row.project_id,
      nextProject,
    );
    this.setState({ project_map } as ProjectsState);
  }

  public applyProjectsTableSnapshot(
    snapshot: Map<string, any> | undefined,
    opts?: {
      mergeIntoExisting?: boolean;
      removeMissingProjectIds?: string[];
    },
  ): void {
    const incomingProjectMap = snapshot ?? Map<string, any>();
    const currentProjectMap = store.get("project_map") ?? Map<string, any>();
    const projectsToClose = new globalThis.Set<string>();
    let project_map = opts?.mergeIntoExisting
      ? currentProjectMap
      : incomingProjectMap.map((project) =>
          (project as Map<string, any>).delete(PROJECTION_ONLY_FIELD),
        );
    if (!opts?.mergeIntoExisting) {
      for (const [project_id, currentProject] of currentProjectMap) {
        if (
          currentProject.get(PROJECTION_ONLY_FIELD) === true &&
          !incomingProjectMap.has(project_id)
        ) {
          project_map = project_map.set(project_id, currentProject);
        } else if (
          !incomingProjectMap.has(project_id) &&
          this.shouldRetainOpenProjectDuringMoveTransition(project_id)
        ) {
          project_map = project_map.set(project_id, currentProject);
        } else if (
          !incomingProjectMap.has(project_id) &&
          this.isProjectOpen(project_id)
        ) {
          projectsToClose.add(project_id);
        }
      }
    }
    if (opts?.mergeIntoExisting && opts.removeMissingProjectIds != null) {
      for (const project_id of opts.removeMissingProjectIds) {
        if (
          !incomingProjectMap.has(project_id) &&
          currentProjectMap.get(project_id)?.get(PROJECTION_ONLY_FIELD) !== true
        ) {
          if (this.shouldRetainOpenProjectDuringMoveTransition(project_id)) {
            continue;
          }
          project_map = project_map.remove(project_id);
          if (this.isProjectOpen(project_id)) {
            projectsToClose.add(project_id);
          }
        }
      }
    }
    for (const [project_id, incomingProject] of incomingProjectMap) {
      const currentProject =
        currentProjectMap.get(project_id) ?? Map<string, any>();
      let nextProject = incomingProject as Map<string, any>;
      if (
        this.shouldPreserveNewerLocalState({
          currentProject,
          incomingState: nextProject.get("state"),
        })
      ) {
        nextProject = nextProject.set("state", currentProject.get("state"));
      }
      if (
        this.shouldPreserveNewerLocalLastEdited({
          currentProject,
          incomingLastEdited: nextProject.get("last_edited"),
        })
      ) {
        nextProject = nextProject.set(
          "last_edited",
          currentProject.get("last_edited"),
        );
      }
      if (
        this.shouldPreserveNewerLocalLastBackup({
          currentProject,
          incomingLastBackup: nextProject.get("last_backup"),
        })
      ) {
        nextProject = nextProject.set(
          "last_backup",
          currentProject.get("last_backup"),
        );
      }
      nextProject = this.mergeLocalProjectUsers(currentProject, nextProject);
      nextProject = this.mergeNewerLocalLastActive(currentProject, nextProject);
      nextProject = nextProject.delete(PROJECTION_ONLY_FIELD);
      this.releaseRoutingIfCurrentAccountRegainedMembership({
        project_id,
        currentProject,
        nextProject,
      });
      project_map = project_map.set(project_id, nextProject);
    }
    this.setState({ project_map } as ProjectsState);
    for (const project_id of projectsToClose) {
      this.set_project_closed(project_id);
    }
  }

  private async bootstrapCreatedProjectDirectly(
    project_id: string,
  ): Promise<boolean> {
    let resp: any;
    try {
      resp = await webapp_client.async_query({
        query: {
          projects: [
            {
              project_id,
              title: null,
              description: null,
              name: null,
              theme: null,
              host_id: null,
              owning_bay_id: null,
              users: null,
              state: null,
              last_active: null,
              last_edited: null,
              last_backup: null,
            },
          ],
        },
      });
    } catch (err) {
      console.warn("bootstrapCreatedProjectDirectly failed", {
        project_id,
        err: `${err}`,
      });
      return false;
    }
    const row = resp?.query?.projects?.[0] as
      | DirectProjectBootstrapRow
      | undefined;
    if (!row?.project_id) {
      return false;
    }
    this.upsertProjectMapFromRow({
      project_id: row.project_id,
      title: row.title ?? "",
      description: row.description ?? "",
      name: row.name ?? null,
      theme: row.theme ?? null,
      host_id: row.host_id ?? null,
      owning_bay_id: `${row.owning_bay_id ?? ""}`.trim() || DEFAULT_BAY_ID,
      users: row.users ?? {},
      state: row.state ?? {},
      last_active: row.last_active ?? {},
      last_edited: dateOrNull(row.last_edited)?.toISOString() ?? null,
      last_backup: dateOrNull(row.last_backup)?.toISOString() ?? null,
    });
    return true;
  }

  private handleOpenProjectHostChange({
    project_id,
    source_host_id,
    dest_host_id,
  }: {
    project_id: string;
    source_host_id?: string;
    dest_host_id?: string;
  }): void {
    if (
      !this.isProjectOpen(project_id) ||
      !source_host_id ||
      !dest_host_id ||
      source_host_id === dest_host_id ||
      (!source_host_id && !dest_host_id)
    ) {
      return;
    }
    this.noteProjectHostTransition(project_id);
    redux
      .getProjectActions(project_id)
      ?.setState?.({ move_reopen_required: true });
    webapp_client.conat_client.releaseProjectHostRouting({ project_id });
    webapp_client.conat_client.refreshProjectHostRouting({
      source_host_id,
      dest_host_id,
    });
    redux.getProjectActions(project_id)?.resetProjectHostRuntime?.();
    // Do not force a global reconnect here. A move can succeed before the
    // projected account feed catches up, and reconnecting eagerly risks
    // rehydrating stale host placement into project_map.
  }

  private projects_table_set = async (
    obj: object,
    merge: "deep" | "shallow" | "none" | undefined = "deep",
  ): Promise<void> => {
    const table = await this.getProjectTable();
    await table?.set(obj, merge);
  };

  // Set something in the projects table of the database directly
  // using a query, instead of using sync'd table mechanism, which
  // is what projects_table_set does.
  private async projects_query_set(obj: object): Promise<void> {
    await webapp_client.async_query({
      query: {
        projects: obj,
      },
    });
  }

  private isProjectOpen = (project_id: string): boolean => {
    return (store.get("open_projects")?.indexOf?.(project_id) ?? -1) != -1;
  };

  private noteProjectHostTransition(project_id: string): void {
    const nextDeadline = Date.now() + ProjectsActions.MOVE_TRANSITION_GRACE_MS;
    const previousDeadline = this.recentProjectHostTransitionUntil[project_id];
    if (previousDeadline == null || previousDeadline < nextDeadline) {
      this.recentProjectHostTransitionUntil[project_id] = nextDeadline;
    }
  }

  private noteProjectMoveSummary(
    summary: LroSummary | undefined,
    eventTs?: number,
  ): void {
    if (
      summary?.kind !== "project-move" ||
      summary.scope_type !== "project" ||
      !summary.scope_id
    ) {
      return;
    }
    const project_id = summary.scope_id;
    if (summary.dismissed_at != null) {
      delete this.recentProjectMoveSummaries[project_id];
      delete this.recentProjectMoveTransitionUntil[project_id];
      return;
    }
    this.recentProjectMoveSummaries[project_id] = summary;
    const baseMs =
      eventTimeMs(summary.updated_at) ??
      eventTimeMs(summary.finished_at) ??
      eventTimeMs(eventTs) ??
      Date.now();
    const duration = isTerminal(summary.status)
      ? ProjectsActions.MOVE_TRANSITION_GRACE_MS
      : ProjectsActions.ACTIVE_MOVE_RETENTION_MS;
    const nextDeadline = baseMs + duration;
    const previousDeadline = this.recentProjectMoveTransitionUntil[project_id];
    if (previousDeadline == null || previousDeadline < nextDeadline) {
      this.recentProjectMoveTransitionUntil[project_id] = nextDeadline;
    }
  }

  private isProjectInRecentHostTransition(project_id: string): boolean {
    const deadline = this.recentProjectHostTransitionUntil[project_id];
    if (deadline == null) {
      return false;
    }
    if (deadline <= Date.now()) {
      delete this.recentProjectHostTransitionUntil[project_id];
      return false;
    }
    return true;
  }

  private isProjectInRecentMoveTransition(project_id: string): boolean {
    const deadline = this.recentProjectMoveTransitionUntil[project_id];
    if (deadline == null) {
      return false;
    }
    if (deadline <= Date.now()) {
      delete this.recentProjectMoveTransitionUntil[project_id];
      delete this.recentProjectMoveSummaries[project_id];
      return false;
    }
    return true;
  }

  private shouldRetainOpenProjectDuringMoveTransition(
    project_id: string,
  ): boolean {
    if (!this.isProjectOpen(project_id)) {
      return false;
    }
    return (
      this.isProjectMoveInProgress(project_id) ||
      this.isProjectInRecentHostTransition(project_id) ||
      this.isProjectInRecentMoveTransition(project_id)
    );
  }

  private hydrateProjectMoveState(project_actions: any, project_id: string) {
    const summary = this.recentProjectMoveSummaries[project_id];
    if (summary == null || !this.isProjectInRecentMoveTransition(project_id)) {
      return;
    }
    project_actions?.setState?.({
      move_lro: fromJS({
        op_id: summary.op_id,
        summary,
      }),
    });
    if (!isTerminal(summary.status)) {
      project_actions?.trackMoveOp?.({
        op_id: summary.op_id,
        scope_type: summary.scope_type,
        scope_id: summary.scope_id,
      });
    }
  }

  private isProjectMoveInProgress(project_id: string): boolean {
    const projectStore = this.redux.getProjectStore?.(project_id);
    const moveLro = projectStore?.get?.("move_lro");
    if (!moveLro) {
      return false;
    }
    const summary = moveLro.get?.("summary");
    const status =
      moveLro.getIn?.(["summary", "status"]) ??
      summary?.status ??
      summary?.get?.("status");
    if (status == null) {
      return true;
    }
    if (!isTerminal(status)) {
      return true;
    }
    const updatedAt =
      moveLro.getIn?.(["summary", "updated_at"]) ??
      summary?.updated_at ??
      summary?.get?.("updated_at") ??
      moveLro.getIn?.(["summary", "finished_at"]) ??
      summary?.finished_at ??
      summary?.get?.("finished_at") ??
      moveLro.get("updated_at");
    const updatedMs = eventTimeMs(updatedAt);
    return (
      updatedMs != null &&
      updatedMs + ProjectsActions.MOVE_TRANSITION_GRACE_MS > Date.now()
    );
  }

  private setProjectOpen = (project_id: string): void => {
    const x = store.get("open_projects");
    const index = x.indexOf(project_id);
    if (index === -1) {
      this.setState({ open_projects: x.push(project_id) });
    }
  };

  // Do not call this directly to close a project.  Instead call
  //   redux.getActions('page').close_project_tab(project_id),
  // which calls this.
  public set_project_closed(project_id: string): void {
    const x = store.get("open_projects");
    const index = x.indexOf(project_id);
    if (index !== -1) {
      webapp_client.conat_client.releaseProjectHostRouting({ project_id });
      redux.removeProjectReferences(project_id);
      this.setState({ open_projects: x.delete(index) });
    }
  }

  // Save all open files in all projects to disk
  public save_all_files(): void {
    store.get("open_projects").filter((project_id) => {
      // ? is fine here since if project just got closed or collaborator
      // removed from it, etc., that would be fine.  Save all is
      // just a convenience for autosave. See
      // https://github.com/sagemathinc/cocalc/issues/4789
      this.redux.getProjectActions(project_id)?.save_all_files();
    });
  }

  /*
  Returns true only if we are a collaborator/user of this project
  and have loaded it.  Should check this before changing anything
  in the projects table!  Otherwise, bad things will happen.
  */
  private async have_project(project_id: string): Promise<boolean> {
    return !!store.get("project_map")?.has(project_id);
  }

  private setProjectLocalScalarField = (
    project_id: string,
    field: "title" | "description" | "name",
    value: string | undefined,
  ): void => {
    const project_map = store.get("project_map");
    if (project_map == null || !project_map.has(project_id)) {
      return;
    }
    this.setState({
      project_map: project_map.setIn([project_id, field], value),
    } as ProjectsState);
  };

  private setProjectLocalTheme = (
    project_id: string,
    theme: ProjectTheme | null | undefined,
  ): void => {
    const project_map = store.get("project_map");
    if (project_map == null || !project_map.has(project_id)) {
      return;
    }
    this.setState({
      project_map: project_map.setIn(
        [project_id, "theme"],
        theme == null ? theme : fromJS(theme),
      ),
    } as ProjectsState);
  };

  private setProjectLocalSshKey = (
    project_id: string,
    account_id: string | undefined,
    fingerprint: string,
    value: {
      title: string;
      value: string;
      creation_date: number;
    } | null,
  ): void => {
    if (!account_id) return;
    const project_map = store.get("project_map");
    if (project_map == null || !project_map.has(project_id)) {
      return;
    }
    const keyPath = [project_id, "users", account_id, "ssh_keys", fingerprint];
    const nextProjectMap =
      value == null
        ? project_map.deleteIn(keyPath)
        : project_map.setIn(keyPath, fromJS(value));
    this.setState({
      project_map: nextProjectMap,
    } as ProjectsState);
  };

  private setProjectLocalUserHide = (
    project_id: string,
    account_id: string | undefined,
    hide: boolean | undefined,
  ): void => {
    if (!account_id) return;
    const project_map = store.get("project_map");
    if (project_map == null || !project_map.has(project_id)) {
      return;
    }
    const keyPath = [project_id, "users", account_id, "hide"];
    const nextProjectMap =
      hide == null
        ? project_map.deleteIn(keyPath)
        : project_map.setIn(keyPath, hide);
    this.setState({
      project_map: nextProjectMap,
    } as ProjectsState);
  };

  private updateProjectScalarField = async (
    project_id: string,
    field: "title" | "description" | "name",
    value: string,
    before: string | undefined,
  ): Promise<void> => {
    this.setProjectLocalScalarField(project_id, field, value);
    try {
      await this.projects_query_set({ project_id, [field]: value });
    } catch (err) {
      this.setProjectLocalScalarField(project_id, field, before);
      throw err;
    }
    this.logProjectMetadataUpdate(project_id, {
      event: "set",
      [field]: value,
    });
  };

  private logProjectMetadataUpdate(project_id: string, event: any): void {
    this.redux
      .getProjectActions(project_id)
      ?.async_log(event)
      .catch((err) => {
        console.warn("error recording project metadata log entry", {
          project_id,
          err,
          event,
        });
      });
  }

  set_project_title = async (
    project_id: string,
    title: string,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set title -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    const before = store.getIn(["project_map", project_id, "title"]);
    if (before === title) {
      // title is already set as requested; nothing to do
      return;
    }
    await this.updateProjectScalarField(project_id, "title", title, before);
  };

  set_project_description = async (
    project_id: string,
    description: string,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set description -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    const before = store.getIn(["project_map", project_id, "description"]);
    if (before === description) {
      // description is already set as requested; nothing to do
      return;
    }
    await this.updateProjectScalarField(
      project_id,
      "description",
      description,
      before,
    );
  };

  set_project_name = async (
    project_id: string,
    name: string,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set project name -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    const before = store.getIn(["project_map", project_id, "name"]);
    if (before == name) return;
    await this.updateProjectScalarField(project_id, "name", name, before);
  };

  set_project_settings = async (
    project_id: string,
    settings: object,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set settings -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    await this.projects_table_set({ project_id, settings }, "deep");
  };

  set_project_launcher = async (
    project_id: string,
    launcher: object,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set launcher defaults -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    await webapp_client.conat_client.hub.projects.setProjectLauncher({
      project_id,
      launcher,
    });
    publishProjectDetailInvalidation({
      project_id,
      fields: ["launcher"],
    });
  };

  set_project_allow_collaborator_starts_using_sponsor = async (
    project_id: string,
    allow_collaborator_starts_using_sponsor: boolean,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set collaborator start policy -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    await this.projects_table_set({
      project_id,
      allow_collaborator_starts_using_sponsor,
    });
  };

  set_project_allow_collaborator_destructive_storage_actions = async (
    project_id: string,
    allow_collaborator_destructive_storage_actions: boolean,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set destructive storage-history policy -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    await this.projects_table_set({
      project_id,
      allow_collaborator_destructive_storage_actions,
    });
  };

  set_project_runtime_sponsor_to_me = async (
    project_id: string,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set runtime sponsor -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    const account_id = redux.getStore("account").get("account_id");
    if (!is_valid_uuid_string(account_id)) {
      throw Error("You must be signed in to sponsor project runtime.");
    }
    await this.projects_table_set({
      project_id,
      runtime_sponsor_account_id: account_id,
    });
    publishProjectDetailInvalidation({
      project_id,
      fields: ["runtime_sponsor_account_id"],
    });
  };

  set_project_runtime_sponsor_to_owner = async (
    project_id: string,
    owner_account_id: string,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set runtime sponsor -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    if (!is_valid_uuid_string(owner_account_id)) {
      throw Error("Project owner account id is not available.");
    }
    await this.projects_table_set({
      project_id,
      runtime_sponsor_account_id: owner_account_id,
    });
    publishProjectDetailInvalidation({
      project_id,
      fields: ["runtime_sponsor_account_id"],
    });
  };

  set_project_autostart_enabled = async (
    project_id: string,
    autostart_enabled: boolean,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set autostart policy -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    await this.projects_table_set({
      project_id,
      autostart_enabled,
    });
  };

  setProjectTheme = async (
    project_id: string,
    theme: ProjectTheme | null,
  ): Promise<void> => {
    if (!(await this.have_project(project_id))) {
      console.warn(
        `Can't set project theme -- you are not a collaborator on project '${project_id}'.`,
      );
      return;
    }
    const normalizedTheme: ProjectTheme = {
      color: theme?.color ?? null,
      accent_color: theme?.accent_color ?? null,
      icon: theme?.icon?.trim() || null,
      image_blob: theme?.image_blob?.trim() || null,
    };
    const before = store.getIn(["project_map", project_id, "theme"]);
    const beforeJS = before?.toJS?.() ?? before ?? null;
    if (isEqual(beforeJS, normalizedTheme)) return;
    this.setProjectLocalTheme(project_id, normalizedTheme);
    try {
      await this.projects_query_set({
        project_id,
        theme: normalizedTheme,
      });
    } catch (err) {
      this.setProjectLocalTheme(project_id, beforeJS);
      throw err;
    }
    this.logProjectMetadataUpdate(project_id, {
      event: "set",
      theme: normalizedTheme,
    });
  };

  add_ssh_key_to_project = async (opts: {
    project_id: string;
    fingerprint: string;
    title: string;
    value: string;
  }): Promise<void> => {
    const { project_id } = opts;
    const creation_date = Date.now();
    await webapp_client.conat_client.hub.projects.setProjectSshKey({
      project_id,
      fingerprint: opts.fingerprint,
      title: opts.title,
      value: opts.value,
      creation_date,
    });
    this.setProjectLocalSshKey(
      project_id,
      webapp_client.account_id,
      opts.fingerprint,
      {
        title: opts.title,
        value: opts.value,
        creation_date,
      },
    );
    await this.updateAuthorizedKeys(project_id);
  };

  delete_ssh_key_from_project = async (opts: {
    project_id: string;
    fingerprint: string;
  }): Promise<void> => {
    const { project_id } = opts;
    await webapp_client.conat_client.hub.projects.deleteProjectSshKey({
      project_id,
      fingerprint: opts.fingerprint,
    });
    this.setProjectLocalSshKey(
      project_id,
      webapp_client.account_id,
      opts.fingerprint,
      null,
    );
    await this.updateAuthorizedKeys(project_id);
  };

  updateAuthorizedKeys = async (project_id: string) => {
    // only do this if running, since it only matters when
    // running and is updated on startup
    if (store.get_state(project_id) == "running") {
      try {
        await webapp_client.conat_client.hub.projects.updateAuthorizedKeysOnHost(
          { project_id },
        );
        const api = webapp_client.conat_client.projectApi({ project_id });
        await api.system.updateSshKeys();
      } catch (err) {
        // ignore; host will catch up on next start.
        console.warn("failed to push ssh keys to project-host", err);
      }
    }
  };

  public async set_project_course_info({
    project_id,
    course_project_id,
    path,
    student_pay,
    institute_pay,
    site_license_pay,
    required_membership_class,
    student_membership_required_at,
    student_membership_grace_days,
    course_ends_at,
    account_id,
    email_address,
    datastore,
    type,
    student_project_functionality,
    envvars,
    rootfs_image,
    rootfs_image_id,
  }: {
    project_id: string;
    course_project_id: string;
    path: string;
    student_pay?: boolean;
    institute_pay?: boolean;
    site_license_pay?: boolean;
    required_membership_class?: string;
    student_membership_required_at?: string;
    student_membership_grace_days?: number;
    course_ends_at?: string;
    account_id?: string | null;
    email_address?: string | null;
    datastore: Datastore;
    type: "student" | "shared" | "nbgrader";
    student_project_functionality?: StudentProjectFunctionality | null;
    envvars?: EnvVars;
    rootfs_image?: string;
    rootfs_image_id?: string;
  }): Promise<void | { course: null | CourseInfo }> {
    if (!(await this.have_project(project_id))) {
      const msg = `Can't set course info -- you are not a collaborator on project '${project_id}'.`;
      console.warn(msg);
      return;
    }
    const course_info = (await ensureProjectCourseInfo(project_id))?.toJS();
    const course: CourseInfo = {
      project_id: course_project_id,
      path,
      datastore,
      type,
    };
    if (student_pay != null) course.student_pay = student_pay;
    if (institute_pay != null) course.institute_pay = institute_pay;
    if (site_license_pay != null) course.site_license_pay = site_license_pay;
    if (required_membership_class?.trim()) {
      course.required_membership_class = required_membership_class.trim();
    }
    if (student_membership_required_at?.trim()) {
      course.student_membership_required_at =
        student_membership_required_at.trim();
    }
    if (
      typeof student_membership_grace_days === "number" &&
      Number.isFinite(student_membership_grace_days)
    ) {
      course.student_membership_grace_days = student_membership_grace_days;
    }
    if (course_ends_at?.trim()) {
      course.course_ends_at = course_ends_at.trim();
    }
    if (type == "student" && student_project_functionality != null) {
      course.student_project_functionality = student_project_functionality;
    }
    if (typeof envvars?.inherit === "boolean") {
      course.envvars = envvars;
    }
    if (rootfs_image?.trim()) {
      course.rootfs_image = rootfs_image.trim();
    }
    if (rootfs_image_id?.trim()) {
      course.rootfs_image_id = rootfs_image_id.trim();
    }
    // account_id and email are null for shared/nbgrader projects; student
    // projects use them to connect course membership requirements to a user.
    if (account_id != null) {
      course.account_id = account_id;
    }
    if (email_address != null) {
      course.email_address = email_address;
    }
    // lodash.isEqual: deep comparison of two objects
    if (isEqual(course_info, course)) {
      // already set as required; do nothing
      return;
    }
    const result = await api("projects/course/set-course-info", {
      project_id,
      course,
    });
    store.clearOpenAICache();
    publishProjectDetailInvalidation({
      project_id,
      fields: ["course"],
    });
    return result;
  }

  // Create a new project; returns the project_id of the new project.
  public async create_project(opts: {
    title?: string;
    description?: string;
    rootfs_image?: string; // if given, sets the rootfs image
    rootfs_image_id?: string;
    start?: boolean; // immediately start on create
    license?: string;
    host_id?: string;
    region?: string;
  }): Promise<string> {
    const opts2: {
      title: string;
      description: string;
      rootfs_image?: string;
      rootfs_image_id?: string;
      host_id?: string;
      region?: string;
      start: boolean;
      license?: string;
    } = defaults(opts, {
      title: "No Title",
      description: "No Description",
      rootfs_image: opts.rootfs_image,
      rootfs_image_id: opts.rootfs_image_id,
      host_id: undefined,
      region: undefined,
      start: false,
      license: undefined,
    });
    if (!opts2.rootfs_image) {
      delete opts2.rootfs_image;
    }
    if (!opts2.rootfs_image_id) {
      delete opts2.rootfs_image_id;
    }

    const project_id = await webapp_client.project_client.create(opts2);

    // At this point we know the project_id and that the project exists.
    // However, various code (e.g., setting the title) depends on the
    // project_map also having the project in it, which requires some
    // changefeeds to fire off and get handled. Under heavy account churn that
    // local feed processing can lag even though create already succeeded, so
    // fall back to a targeted direct row bootstrap instead of timing out.
    try {
      await store.async_wait({
        until: () => store.getIn(["project_map", project_id]) != null,
        timeout: ProjectsActions.CREATE_PROJECT_FEED_WAIT_TIMEOUT_S,
      });
    } catch (err) {
      if (
        `${err}` !== "timeout" ||
        !(await this.bootstrapCreatedProjectDirectly(project_id))
      ) {
        throw err;
      }
    }
    return project_id;
  }

  // Open the given project
  open_project = async (opts: {
    project_id: string; //  id of the project to open
    target?: string; // The file path to open
    fragmentId?: FragmentId; //  if given, an uri fragment in the editor that is opened.
    switch_to?: boolean; // (default: true) Whether or not to foreground it
    ignore_kiosk?: boolean; // Ignore ?fullscreen=kiosk
    change_history?: boolean; // (default: true) Whether or not to alter browser history
    restore_session?: boolean; // (default: true)  Opens up previously closed editor tabs
  }) => {
    opts = defaults(opts, {
      project_id: undefined,
      target: undefined,
      fragmentId: undefined,
      switch_to: true,
      ignore_kiosk: false,
      change_history: true,
      restore_session: true,
    });
    if (!is_valid_uuid_string(opts.project_id)) {
      throw Error(`invalid project_id - ${opts.project_id}`);
    }

    if (!store.getIn(["project_map", opts.project_id])) {
      if (COCALC_MINIMAL) {
        await switch_to_project(opts.project_id);
      }
    }
    if (
      isProjectHardDeleteBlocked(store.getIn(["project_map", opts.project_id]))
    ) {
      const project_actions = redux.getProjectActions(opts.project_id);
      if (!this.isProjectOpen(opts.project_id)) {
        this.setProjectOpen(opts.project_id);
      }
      project_actions?.set_active_tab?.("home", {
        change_history: false,
      });
      if (opts.switch_to) {
        redux
          .getActions("page")
          .set_active_tab(opts.project_id, opts.change_history);
      }
      if (
        isProjectHardDeleting(store.getIn(["project_map", opts.project_id]))
      ) {
        alert_message({
          type: "warning",
          message: projectHardDeletingMessage(),
          timeout: 12,
        });
      }
      return;
    }
    const host_id = store.getIn(["project_map", opts.project_id, "host_id"]);
    if (typeof host_id === "string") {
      // Ensure host routing info is ready before any conat project API calls.
      await this.ensure_host_info(host_id);
    }
    const project_actions = redux.getProjectActions(opts.project_id);
    let relation = store.get_my_group(opts.project_id);
    if (relation == null || ["public", "admin"].includes(relation)) {
      this.fetch_public_project_title(opts.project_id);
    }
    this.hydrateProjectMoveState(project_actions, opts.project_id);
    if (!this.isProjectOpen(opts.project_id)) {
      this.setProjectOpen(opts.project_id);
      if (opts.restore_session) {
        redux.getActions("page").restore_session(opts.project_id);
      }
    }
    const pstore = project_actions.get_store();
    const activeProjectTab = pstore?.get("active_project_tab");
    opts.target = defaultOpenProjectTarget({
      target: opts.target,
      activeProjectTab,
      switchTo: opts.switch_to,
    });
    if (opts.target != null) {
      await project_actions.load_target(
        opts.target,
        opts.switch_to,
        opts.ignore_kiosk,
        opts.change_history,
        opts.fragmentId,
      );
    }
    if (opts.switch_to) {
      redux
        .getActions("page")
        .set_active_tab(opts.project_id, opts.change_history);
    }
    // initialize project
    project_actions.init();
  };

  // tab at old_index taken out and then inserted into the resulting array's new index
  public move_project_tab({
    old_index,
    new_index,
  }: {
    old_index: number;
    new_index: number;
  }) {
    const x = store.get("open_projects");
    const item = x.get(old_index);
    if (item == null) return;
    const temp_list = x.delete(old_index);
    const open_projects = temp_list.splice(new_index, 0, item);
    this.setState({ open_projects });
    redux.getActions("page").save_session();
  }

  public async load_target(
    target?: string,
    switch_to?: boolean,
    ignore_kiosk?: boolean,
    change_history?: boolean,
    fragmentId?: FragmentId,
  ): Promise<void> {
    if (!target || target.length === 0) {
      redux.getActions("page").set_active_tab("projects");
      return;
    }
    const segments = target.split("/");
    if (is_valid_uuid_string(segments[0])) {
      const t = segments.slice(1).join("/");
      const project_id = segments[0];
      await this.open_project({
        project_id,
        target: t,
        fragmentId,
        switch_to,
        ignore_kiosk,
        change_history,
        restore_session: false,
      });
    }
  }

  // Put the given project in the foreground
  public async foreground_project(
    project_id: string,
    change_history: boolean = true,
  ): Promise<void> {
    redux.getActions("page").set_active_tab(project_id, change_history);

    // the database often isn't loaded at this moment (right when user refreshes)
    await store.async_wait({
      until: (s) => s.get_title(project_id) != null,
    });
    set_window_title(store.get_title(project_id)); // change title bar
  }

  // Given the id of a public project, make it so that sometime
  // in the future the projects store knows the corresponding title,
  // (at least what it is right now).  For convenience this works
  // even if the project isn't public if the user is an admin, and also
  // works on projects the user owns or collaborates on.
  // NOTE: this could mistitle the project "No Title" in case of a network
  // or database fail at the wrong moment; but this is really only used by
  // admins (who should usually be impersonating users instead!),
  // so not a serious concern.
  public async fetch_public_project_title(project_id: string): Promise<string> {
    let group;
    try {
      await store.async_wait({
        until: () => store.get_my_group(project_id) != null,
        timeout: 60,
      });
      group = store.get_my_group(project_id);
    } catch (err) {
      group = "public";
    }
    let table;
    switch (group) {
      case "admin":
        table = "projects_admin";
        break;
      case "owner":
      case "collaborator":
        table = "projects";
        break;
      default:
        table = "public_projects";
    }
    let resp: any = undefined;
    try {
      resp = await webapp_client.async_query({
        query: {
          [table]: { project_id, title: null },
        },
      });
    } catch (_) {
      // ignore err, since we just fall back to "No Title" below.
    }
    let title = resp?.query?.[table]?.title ?? "No Title";
    this.setState({
      public_project_titles: store
        .get("public_project_titles")
        .set(project_id, title),
    });
    return title;
  }

  // The next few actions below involve changing the users field
  // of a project.   See the users field of
  //      @cocalc/util/db-schema/project.ts
  // for documentation of the structure of this.

  /*
   * Collaborators
   */
  public async remove_collaborator(
    project_id: string,
    account_id: string,
  ): Promise<void> {
    const removed_name = redux.getStore("users").get_name(account_id);
    try {
      await this.redux
        .getProjectActions(project_id)
        .async_log({ event: "remove_collaborator", removed_name });
      await webapp_client.project_collaborators.remove({
        project_id,
        account_id,
      });
    } catch (err) {
      const message = `Error removing ${removed_name} from project ${project_id} -- ${err}`;
      alert_message({ type: "error", message });
    }
  }

  // this is for inviting existing users, the email is only known by the back-end
  public async invite_collaborator(
    project_id: string,
    account_id: string,
    body?: string, // if not set and nonempty, no email will be sent
    subject?: string,
    silent?: boolean, // if true, don't show error message on fail
    replyto?: string,
    replyto_name?: string,
  ): Promise<void> {
    await this.redux.getProjectActions(project_id).async_log({
      event: "invite_user",
      invitee_account_id: account_id,
    });

    const title = store.get_title(project_id);
    const link2proj = `https://${window.location.hostname}${getProjectUrlPath(project_id, undefined)}/`;
    // convert body from markdown to html, which is what the backend expects
    const email = body != null ? markdown_to_html(body) : undefined;

    try {
      await webapp_client.project_collaborators.invite({
        project_id,
        account_id,
        title,
        link2proj,
        replyto,
        replyto_name,
        email,
        subject,
        message: body,
      });
      notifyCollabInvitesChanged(project_id);
    } catch (err) {
      if (!silent) {
        const message = `Error inviting collaborator ${account_id} from ${project_id} -- ${err}`;
        alert_message({ type: "error", message });
      }
    }
  }

  // this is for inviting non-existing users, email is set via the UI
  public async invite_collaborators_by_email(
    project_id: string,
    to: string,
    body: string,
    subject: string,
    silent: boolean,
    replyto: string | undefined,
    replyto_name: string | undefined,
  ): Promise<void> {
    await this.redux.getProjectActions(project_id).async_log({
      event: "invite_nonuser",
      invitee_email: to,
    });

    const title = store.get_title(project_id);
    if (body == null) {
      const name = this.redux.getStore("account").get_fullname();
      body = `Please collaborate with me using CoCalc on '${title}'.\n\n\n--\n${name}`;
    }
    const link2proj = `https://${window.location.hostname}${getProjectUrlPath(project_id, undefined)}/`;
    const email = markdown_to_html(body);

    try {
      await webapp_client.project_collaborators.invite_noncloud({
        project_id,
        title,
        link2proj,
        replyto,
        replyto_name,
        to,
        email,
        subject,
        message: body,
      });
      notifyCollabInvitesChanged(project_id);
      if (!silent) {
        alert_message({
          message: `Invited ${to} to collaborate on project.`,
        });
      }
    } catch (err) {
      if (!silent) {
        const message = `Error inviting collaborator ${to} from ${project_id} -- ${err}`;
        alert_message({ type: "error", message, timeout: 60 });
      }
    }
  }

  public async project_log(project_id: string, entry): Promise<void> {
    await this.redux.getProjectActions(project_id).log(entry);
  }

  // return true, if it actually started the project
  start_project = reuseInFlight(
    async (
      project_id: string,
      opts: {
        autostart?: boolean;
        onStartOp?: (op: { op_id?: string }) => void;
      } = {},
    ): Promise<boolean> => {
      if (!store.getIn(["project_map", project_id])) {
        return false;
      }
      if (isProjectHardDeleting(store.getIn(["project_map", project_id]))) {
        const message = projectHardDeletingMessage();
        redux.getProjectActions(project_id)?.setState({
          control_error: message,
        });
        alert_message({ type: "warning", message, timeout: 12 });
        return false;
      }
      const lifecycleState = store.getIn([
        "project_map",
        project_id,
        "state",
        "state",
      ]) as string | undefined;
      if (lifecycleState === "starting" || lifecycleState === "running") {
        return false;
      }
      const assignedHostId = store.getIn([
        "project_map",
        project_id,
        "host_id",
      ]) as string | undefined;
      if (assignedHostId) {
        const hostInfo = await this.ensure_host_info(assignedHostId);
        const hostState = evaluateHostOperational(hostInfo as any);
        if (hostState.state === "unavailable") {
          const hostName = hostLabel(hostInfo as any, assignedHostId);
          const reason = hostState.reason ?? "Assigned host is unavailable.";
          const message =
            `Cannot start project because ${hostName} is unavailable (${reason}). ` +
            "Open Settings and move this project to an available host, or start the assigned host.";
          redux
            .getProjectActions(project_id)
            ?.setState({ control_error: message });
          alert_message({ type: "error", message, timeout: 20 });
          return false;
        }
      }

      if (lifecycleState === "archived") {
        await this.resetProjectRuntimeAfterArchiveCycle(project_id, {
          closeOpenFiles: false,
        });
      }

      const t0 = webapp_client.server_time().getTime();
      // make an action request:
      this.project_log(project_id, {
        event: "project_start_requested",
      });
      const actions = redux.getProjectActions(project_id);
      try {
        const resp = await webapp_client.conat_client.hub.projects.start({
          project_id,
          ...(opts.autostart ? { autostart: true } : {}),
          wait: false,
        });
        actions.trackStartOp(resp);
        opts.onStartOp?.(resp);
        const host_id = store.getIn(["project_map", project_id, "host_id"]) as
          | string
          | undefined;
        if (host_id) {
          void this.ensure_host_info(host_id, true);
        }
      } catch (err) {
        if (extractRuntimeSponsorDenial(err)) {
          actions.setState({ control_error: "" });
        } else {
          actions.setState({
            control_error: `Error starting project -- ${err}`,
          });
        }
        throw err;
      }
      actions.setState({ control_error: "" });

      this.project_log(project_id, {
        event: "project_started",
        duration_ms: webapp_client.server_time().getTime() - t0,
        ...store.classify_project(project_id),
      });

      return true;
    },
  );

  private resetProjectRuntimeAfterArchiveCycle = async (
    project_id: string,
    opts: {
      closeOpenFiles?: boolean;
    } = {},
  ) => {
    const host_id = store.getIn(["project_map", project_id, "host_id"]) as
      | string
      | undefined;
    webapp_client.conat_client.releaseProjectHostRouting({ project_id });
    if (host_id) {
      webapp_client.conat_client.refreshProjectHostRouting({
        source_host_id: host_id,
        dest_host_id: host_id,
      });
      await this.ensure_host_info(host_id, true);
    }
    const projectActions = redux.getProjectActions(project_id) as
      | {
          clearFilesystemClient?: () => void;
          close_all_files?: () => void;
          set_active_tab?: (
            tab: string,
            opts?: { change_history?: boolean },
          ) => void;
        }
      | undefined;
    projectActions?.clearFilesystemClient?.();
    if (opts.closeOpenFiles !== false) {
      projectActions?.close_all_files?.();
      projectActions?.set_active_tab?.("settings", {
        change_history: false,
      });
    }
  };

  // allow UI elements to open the move modal via project actions
  open_move_modal?: (project_id: string) => void;

  cloneProject = async ({
    project_id,
    title,
  }: {
    project_id: string;
    title?: string;
  }) => {
    const project = redux
      .getStore("projects")
      .getIn(["project_map", project_id])
      ?.toJS();
    if (project == null) {
      throw Error("unknown project");
    }
    // this clones due to src_project_id
    const new_project_id = await webapp_client.project_client.create({
      title: title ?? `Clone of ${project.title}`,
      description: project?.description ?? "",
      src_project_id: project_id,
      rootfs_image: project.rootfs_image,
      rootfs_image_id: project.rootfs_image_id,
    });
    this.open_project({ project_id: new_project_id });
  };

  private optimisticProjectStateUpdate = (
    project_id: string,
    state: string,
  ) => {
    // do optimistic update of local state, since several things like project
    // restart are so fas we won't see anything otherwise, which is very disturbing.
    const project_map = store.get("project_map");
    if (project_map != null) {
      const project = project_map
        .get(project_id)
        ?.set("state", fromJS({ state, time: new Date() }));
      if (project != null) {
        this.setState({
          project_map: project_map.set(project_id, project),
        });
      }
    }
  };

  public mark_project_hard_delete_accepted = (
    project_id: string,
    op_id?: string,
  ) => {
    const project_map = store.get("project_map");
    if (project_map == null) return;
    const project = project_map.get(project_id);
    if (project == null) return;
    const nextState = (project.get("state") ?? Map<string, any>())
      .set("state", "deleting")
      .set("time", new Date())
      .set("hard_delete_op_id", op_id);
    this.setState({
      project_map: project_map.set(project_id, project.set("state", nextState)),
    } as ProjectsState);
  };

  private watchMoveLro = (
    actions: ReturnType<typeof redux.getProjectActions> | undefined,
    op: {
      op_id?: string;
      scope_type?: LroSummary["scope_type"];
      scope_id?: string;
    },
    logInfo: {
      project_id: string;
      source_host_id?: string;
      dest_host_id?: string;
      dest_project_region?: string;
    },
  ) => {
    if (!actions || !op?.op_id || !op.scope_type) {
      return;
    }
    const scope_id =
      op.scope_id ??
      (op.scope_type === "project" ? actions.project_id : undefined);
    if (!scope_id && op.scope_type !== "hub") {
      return;
    }
    const applySuccessfulMove = () => {
      actions.setState({ control_error: "" });
      this.noteProjectHostTransition(logInfo.project_id);
      const previous_host_id =
        logInfo.source_host_id ||
        (store.getIn(["project_map", logInfo.project_id, "host_id"]) as
          | string
          | undefined);
      if (logInfo.dest_host_id) {
        const project_map = store.get("project_map");
        const project = project_map?.get(logInfo.project_id);
        if (project_map && project) {
          let nextProject = project;
          if (project.get("host_id") !== logInfo.dest_host_id) {
            nextProject = nextProject.set("host_id", logInfo.dest_host_id);
          }
          if (
            logInfo.dest_project_region &&
            nextProject.get("region") !== logInfo.dest_project_region
          ) {
            nextProject = nextProject.set(
              "region",
              logInfo.dest_project_region,
            );
          }
          if (nextProject !== project) {
            this.setState({
              project_map: project_map.set(logInfo.project_id, nextProject),
            } as ProjectsState);
          }
        }
        if (logInfo.dest_project_region) {
          publishProjectDetailInvalidation({
            project_id: logInfo.project_id,
            fields: ["region"],
          });
        }
        void this.ensure_host_info(logInfo.dest_host_id, true);
      }
      // Do not eagerly recreate the synced projects table after a move
      // succeeds. The move path already patches the destination host and region
      // locally, and a lagging table refresh can rehydrate stale placement back
      // into project_map before the projection catches up.
      this.handleOpenProjectHostChange({
        project_id: logInfo.project_id,
        source_host_id: previous_host_id,
        dest_host_id: logInfo.dest_host_id,
      });
    };
    void webapp_client.conat_client
      .lroWait({
        op_id: op.op_id,
        scope_type: op.scope_type,
        scope_id,
      })
      .then((summary) => {
        if (summary.status !== "succeeded") {
          const reason = summary.error ?? summary.status;
          const error = `Error move project -- ${reason}`;
          actions.setState({ control_error: error });
          return;
        }
        applySuccessfulMove();
      })
      .catch(async (err) => {
        try {
          const summary = await webapp_client.conat_client.hub.lro.get({
            op_id: op.op_id!,
          });
          if (summary?.status === "succeeded") {
            applySuccessfulMove();
            return;
          }
          if (
            summary &&
            summary.status !== "queued" &&
            summary.status !== "running"
          ) {
            const reason = summary.error ?? summary.status;
            actions.setState({
              control_error: `Error move project -- ${reason}`,
            });
            return;
          }
        } catch (recoverErr) {
          console.warn("watchMoveLro summary recovery failed", {
            op_id: op.op_id,
            err: `${recoverErr}`,
          });
        }
        const error = `Error move project -- ${err}`;
        actions.setState({ control_error: error });
      });
  };

  private confirmOfflineMove = async (
    payload: ReturnType<typeof parseOfflineMoveConfirmationError>,
  ): Promise<boolean> => {
    if (payload == null) return false;
    const dialog = buildOfflineMoveConfirmationDialog(payload);
    return await new Promise((resolve) => {
      Modal.confirm({
        title: dialog.title,
        content: dialog.content,
        okText: dialog.okText,
        okButtonProps: dialog.okButtonProps,
        cancelText: "Cancel",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  };

  private requestMoveProject = async ({
    project_id,
    dest_host_id,
    allow_offline,
    backup_region_cutover,
  }: {
    project_id: string;
    dest_host_id?: string;
    allow_offline?: boolean;
    backup_region_cutover?: boolean;
  }): Promise<{
    op_id?: string;
    scope_type?: LroSummary["scope_type"];
    scope_id?: string;
  } | null> => {
    try {
      return await webapp_client.conat_client.hub.projects.moveProject({
        project_id,
        browser_id: webapp_client.browser_id,
        dest_host_id,
        allow_offline,
        backup_region_cutover,
      });
    } catch (err) {
      if (!allow_offline) {
        const payload = parseOfflineMoveConfirmationError(err);
        if (payload != null) {
          const proceed = await this.confirmOfflineMove(payload);
          if (!proceed) {
            return null;
          }
          return await this.requestMoveProject({
            project_id,
            dest_host_id,
            allow_offline: true,
            backup_region_cutover,
          });
        }
      }
      if (this.isTimeoutError(err)) {
        const op = await this.findRecentMoveOp({
          project_id,
          dest_host_id,
        });
        if (op) {
          console.warn(
            "requestMoveProject timed out but recovered recent move operation",
            { project_id, dest_host_id, op_id: op.op_id },
          );
          return op;
        }
      }
      throw err;
    }
  };

  private isTimeoutError(err: unknown): boolean {
    const text = `${err}`.toLowerCase();
    return (
      text.includes("timeout") ||
      text.includes("timed out") ||
      text.includes("code='408'") ||
      text.includes("code=408")
    );
  }

  private lroTime(summary: LroSummary): number {
    const candidate =
      summary.updated_at ?? summary.started_at ?? summary.created_at;
    const ts = new Date(candidate as any).getTime();
    return Number.isFinite(ts) ? ts : 0;
  }

  private findRecentMoveOp = async ({
    project_id,
    dest_host_id,
  }: {
    project_id: string;
    dest_host_id?: string;
  }): Promise<
    | {
        op_id: string;
        scope_type: LroSummary["scope_type"];
        scope_id: string;
      }
    | undefined
  > => {
    try {
      const ops = await webapp_client.conat_client.hub.lro.list({
        scope_type: "project",
        scope_id: project_id,
        include_completed: true,
      });
      const now = Date.now();
      const candidates = ops
        .filter((op) => op.kind === "project-move")
        .filter((op) => !op.dismissed_at)
        .filter((op) =>
          dest_host_id
            ? op.input?.dest_host_id == null ||
              op.input?.dest_host_id === dest_host_id
            : true,
        )
        .sort((a, b) => this.lroTime(b) - this.lroTime(a));
      const latest = candidates[0];
      if (!latest) return;
      if (now - this.lroTime(latest) > 3 * 60 * 1000) {
        return;
      }
      return {
        op_id: latest.op_id,
        scope_type: latest.scope_type,
        scope_id: latest.scope_id,
      };
    } catch (lookupErr) {
      console.warn("findRecentMoveOp failed", {
        project_id,
        dest_host_id,
        err: `${lookupErr}`,
      });
      return;
    }
  };

  // returns true, if it actually stopped the project
  stop_project = reuseInFlight(
    async (project_id: string, _force?: boolean): Promise<boolean> => {
      const t0 = webapp_client.server_time().getTime();
      this.project_log(project_id, {
        event: "project_stop_requested",
      });
      const actions = redux.getProjectActions(project_id);
      try {
        await webapp_client.conat_client.hub.projects.stop({ project_id });
      } catch (err) {
        actions.setState({ control_error: `Error stopping project -- ${err}` });
        throw err;
      }
      actions.setState({ control_error: "" });
      this.optimisticProjectStateUpdate(project_id, "opened");
      this.project_log(project_id, {
        event: "project_stopped",
        duration_ms: webapp_client.server_time().getTime() - t0,
        ...store.classify_project(project_id),
      });
      return true;
    },
  );

  private createBackupAndWaitForArchive = async (
    project_id: string,
  ): Promise<void> => {
    const projectActions = redux.getProjectActions(project_id) as
      | {
          trackBackupOp?: (op: {
            op_id?: string;
            scope_type?: LroSummary["scope_type"];
            scope_id?: string;
          }) => void;
        }
      | undefined;
    const op = await webapp_client.conat_client.hub.projects.createBackup({
      project_id,
    });
    projectActions?.trackBackupOp?.(op);
    const summary = await webapp_client.conat_client.lroWait({
      op_id: op.op_id,
      scope_type: op.scope_type,
      scope_id: op.scope_id,
    });
    if (summary.status !== "succeeded") {
      throw Error(summary.error ?? `backup ${summary.status}`);
    }
  };

  private ensureArchiveBackupFresh = async (
    project_id: string,
    actions?: { setState?: (next: any) => void },
  ): Promise<void> => {
    const lifecycleState = store.getIn([
      "project_map",
      project_id,
      "state",
      "state",
    ]) as string | undefined;
    const lastEdited = store.getIn([
      "project_map",
      project_id,
      "last_edited",
    ]) as Date | undefined;
    const lastBackup = store.getIn([
      "project_map",
      project_id,
      "last_backup",
    ]) as Date | undefined;
    const host_id = store.getIn(["project_map", project_id, "host_id"]) as
      | string
      | undefined;

    if (host_id) {
      await this.ensure_host_info(host_id, true);
      const hostInfo = store.get("host_info")?.get(host_id);
      const hostStatus = `${hostInfo?.get?.("status") ?? ""}`
        .trim()
        .toLowerCase();
      const hostOperational = evaluateHostOperational(hostInfo);
      if (hostStatus === "deprovisioned") {
        actions?.setState?.({
          control_status: "Archiving project from deprovisioned host...",
        });
        await this.project_log(project_id, {
          event: "project_archive_backup_skipped",
          reason: "host_deprovisioned",
          host_id,
          backup_time:
            lastBackup instanceof Date ? lastBackup.toISOString() : undefined,
        });
        return;
      }
      if (hostOperational.state === "unavailable") {
        actions?.setState?.({
          control_status:
            "Archiving project using the latest available backup...",
        });
        const backupDescription =
          lastBackup instanceof Date
            ? `the latest available backup from ${lastBackup.toLocaleString()}`
            : "the latest available backup";
        alert_message({
          type: "warning",
          message: `The assigned host ${hostLabel(
            hostInfo,
            host_id,
          )} is unavailable, so CoCalc cannot create a final backup. Archiving will use ${backupDescription}; newer edits may be lost.`,
          timeout: 20,
        });
        await this.project_log(project_id, {
          event: "project_archive_backup_skipped",
          reason: "host_unavailable",
          host_id,
          host_status: hostStatus || hostOperational.status,
          last_edited:
            lastEdited instanceof Date ? lastEdited.toISOString() : undefined,
          backup_time:
            lastBackup instanceof Date ? lastBackup.toISOString() : undefined,
        });
        return;
      }
    }

    let latestBackupTime: Date | undefined;
    try {
      const backups = await getProjectBackups({
        project_id,
        indexed_only: true,
      });
      for (const backup of backups) {
        const time =
          backup.time instanceof Date
            ? backup.time
            : new Date(`${backup.time}`);
        if (
          Number.isFinite(time.getTime()) &&
          (latestBackupTime == null || time > latestBackupTime)
        ) {
          latestBackupTime = time;
        }
      }
    } catch {
      latestBackupTime = undefined;
    }

    const backupCoversLatestEdits =
      latestBackupTime != null &&
      (!(lastEdited instanceof Date) || latestBackupTime >= lastEdited);
    if (backupCoversLatestEdits) {
      const backupTime = latestBackupTime;
      actions?.setState?.({ control_status: "Archiving project..." });
      await this.project_log(project_id, {
        event: "project_archive_backup_reused",
        backup_time: backupTime?.toISOString(),
      });
      return;
    }

    if (lifecycleState === "running" || lifecycleState === "starting") {
      actions?.setState?.({
        control_status: "Stopping project before final backup...",
      });
      await this.stop_project(project_id);
    }

    actions?.setState?.({
      control_status: "Creating final backup before archive...",
    });
    await this.project_log(project_id, {
      event: "project_archive_backup_requested",
      last_edited:
        lastEdited instanceof Date ? lastEdited.toISOString() : undefined,
      backup_time: latestBackupTime?.toISOString(),
    });
    await this.createBackupAndWaitForArchive(project_id);
  };

  private async getLatestIndexedBackupTime(
    project_id: string,
  ): Promise<Date | undefined> {
    try {
      const backups = await getProjectBackups({ project_id });
      let latestBackupTime: Date | undefined;
      for (const backup of backups) {
        const time =
          backup.time instanceof Date
            ? backup.time
            : new Date(`${backup.time}`);
        if (
          Number.isFinite(time.getTime()) &&
          (latestBackupTime == null || time > latestBackupTime)
        ) {
          latestBackupTime = time;
        }
      }
      return latestBackupTime;
    } catch {
      return undefined;
    }
  }

  archive_project = reuseInFlight(async (project_id: string): Promise<void> => {
    this.project_log(project_id, {
      event: "project_archive_requested",
    });
    const actions = redux.getProjectActions(project_id);
    try {
      actions?.setState?.({
        control_error: "",
        control_status: "Checking backups before archive...",
      });
      await this.ensureArchiveBackupFresh(project_id, actions);
      actions?.setState?.({ control_status: "Archiving project..." });
      await webapp_client.conat_client.hub.projects.archiveProject({
        project_id,
        timeout: ProjectsActions.ARCHIVE_RPC_TIMEOUT_MS,
      });
    } catch (err) {
      actions?.setState({
        control_status: "",
        control_error: `Error archiving project -- ${err}`,
      });
      throw err;
    }
    actions?.setState({ control_error: "", control_status: "" });
    const latestBackupTime = await this.getLatestIndexedBackupTime(project_id);
    this.optimisticProjectStateUpdate(project_id, "archived");
    if (latestBackupTime != null) {
      const project_map = store.get("project_map");
      if (project_map?.has(project_id)) {
        this.setState({
          project_map: project_map.setIn(
            [project_id, "last_backup"],
            latestBackupTime,
          ),
        } as ProjectsState);
      }
    }
    await this.resetProjectRuntimeAfterArchiveCycle(project_id, {
      closeOpenFiles: true,
    });
    this.project_log(project_id, {
      event: "project_archived",
      ...store.classify_project(project_id),
    });
  });

  move_project = reuseInFlight(async (project_id: string): Promise<boolean> => {
    const actions = redux.getProjectActions(project_id);
    try {
      const resp = await this.requestMoveProject({ project_id });
      if (!resp) {
        return false;
      }
      actions.trackMoveOp(resp);
      this.watchMoveLro(actions, resp, {
        project_id,
        source_host_id: store.getIn(["project_map", project_id, "host_id"]) as
          | string
          | undefined,
      });
    } catch (err) {
      const error = `Error move project -- ${err}`;
      if (!isFreshAuthRequiredError(err)) {
        actions.setState({ control_error: error });
      }
      throw err;
    }
    return true;
  });

  move_project_to_host = reuseInFlight(
    async (
      project_id: string,
      dest_host_id: string,
      opts?: {
        backup_region_cutover?: boolean;
        dest_project_region?: string;
      },
    ): Promise<boolean> => {
      const current_host = store.getIn(["project_map", project_id, "host_id"]);
      if (dest_host_id === current_host) return true;
      const actions = redux.getProjectActions(project_id);
      try {
        const resp = await this.requestMoveProject({
          project_id,
          dest_host_id,
          backup_region_cutover: opts?.backup_region_cutover,
        });
        if (!resp) {
          return false;
        }
        actions?.trackMoveOp(resp);
        this.watchMoveLro(actions, resp, {
          project_id,
          source_host_id:
            typeof current_host === "string" ? current_host : undefined,
          dest_host_id,
          dest_project_region: opts?.dest_project_region,
        });
      } catch (err) {
        const error = `Error move project -- ${err}`;
        console.log(error);
        if (!isFreshAuthRequiredError(err)) {
          actions?.setState({ control_error: error });
        }
        throw err;
      }
      return true;
    },
  );

  restart_project = reuseInFlight(
    async (project_id: string, _options?): Promise<void> => {
      if (isProjectHardDeleting(store.getIn(["project_map", project_id]))) {
        const message = projectHardDeletingMessage();
        redux.getProjectActions(project_id)?.setState({
          control_error: message,
        });
        alert_message({ type: "warning", message, timeout: 12 });
        return;
      }
      this.project_log(project_id, {
        event: "project_restart_requested",
      });
      const actions = redux.getProjectActions(project_id);
      try {
        const resp = await webapp_client.conat_client.hub.projects.restart({
          project_id,
          wait: false,
        });
        actions.trackStartOp(resp);
      } catch (err) {
        actions.setState({
          control_error: `Error restarting project -- ${err}`,
        });
        throw err;
      }
      actions.setState({ control_error: "" });
    },
  );

  // Explcitly set whether or not project is hidden for the given account
  // (hide=true means hidden)
  public async set_project_hide(
    account_id: string,
    project_id: string,
    hide: boolean,
  ): Promise<void> {
    const before = store.getIn([
      "project_map",
      project_id,
      "users",
      account_id,
      "hide",
    ]);
    this.setProjectLocalUserHide(project_id, account_id, hide);
    try {
      await webapp_client.conat_client.hub.projects.setProjectHidden({
        project_id,
        hide,
      });
      await this.project_log(project_id, {
        event: hide ? "hide_project" : "unhide_project",
      });
    } catch (err) {
      this.setProjectLocalUserHide(project_id, account_id, before);
      const message = `Error ${hide ? "hiding" : "unhiding"} project ${project_id} -- ${err}`;
      alert_message({ type: "error", message });
      throw err;
    }
  }

  // Toggle whether or not project is hidden project
  public async toggle_hide_project(project_id: string): Promise<void> {
    const account_id = this.redux.getStore("account").get_account_id();
    const hide = store.is_hidden_from(project_id, account_id);
    await this.set_project_hide(account_id, project_id, !hide);
  }

  public async hard_delete_project(project_id: string): Promise<{
    op_id: string;
  }> {
    const op = await webapp_client.conat_client.hub.projects.hardDeleteProject({
      project_id,
      browser_id: webapp_client.browser_id,
    });
    this.mark_project_hard_delete_accepted(project_id, op.op_id);
    await this.project_log(project_id, { event: "delete_project" });
    return op;
  }

  public display_hidden_projects(hidden: boolean): void {
    this.setState({ hidden });
  }

  public toggle_hashtag(filter: string, tag: string): void {
    let selected_hashtags = store.get("selected_hashtags");
    let hashtags = selected_hashtags.get(filter, Set<string>());
    if (hashtags.has(tag)) {
      hashtags = hashtags.delete(tag);
    } else {
      hashtags = hashtags.add(tag);
    }
    selected_hashtags = selected_hashtags.set(filter, hashtags);
    this.setState({ selected_hashtags });
  }

  // Set which project row is expanded in the projects table
  public set_expanded_project(project_id?: string): void {
    this.setState({ expanded_project_id: project_id });
  }

  // Toggle expanded state for a project row in the projects table
  public toggle_expanded_project(project_id: string): void {
    const current = store.get("expanded_project_id");
    if (current === project_id) {
      this.setState({ expanded_project_id: undefined });
    } else {
      this.setState({ expanded_project_id: project_id });
    }
  }
}

// Register projects actions
export function init() {
  redux.createActions("projects", ProjectsActions);
}
