/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import {
  getProjectedNotificationCounts,
  listProjectedNotificationSnapshotForAccount,
  listProjectedNotificationsForAccount,
  markProjectedNotificationsReadThrough,
  setProjectedNotificationArchivedState,
  setProjectedNotificationReadState,
  setProjectedNotificationSavedState,
} from "@cocalc/database/postgres/account-notification-index";
import {
  createNotificationEventGraph,
  type NotificationKind,
} from "@cocalc/database/postgres/notifications-core";
import getPool from "@cocalc/database/pool";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import type {
  CodexFreshAuthActionStart,
  CreateAccountNoticeOptions,
  CreateCodexAttentionNoticeOptions,
  CreateCodexTurnNoticeOptions,
  CodexFreshAuthActionStatus,
  GetCodexFreshAuthActionStatusOptions,
  ArchiveNotificationOptions,
  CreateMentionNotificationOptions,
  CreateNotificationResult,
  ListNotificationsOptions,
  MarkAllNotificationsReadOptions,
  MarkAllNotificationsReadResult,
  MarkNotificationReadOptions,
  MarkNotificationReadResult,
  MentionNotificationReason,
  NotificationCountsResult,
  NotificationListRow,
  NotificationListSnapshot,
  NotificationPriority,
  NotificationSeverity,
  SaveNotificationOptions,
  StartCodexFreshAuthActionOptions,
} from "@cocalc/conat/hub/api/notifications";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { isValidUUID } from "@cocalc/util/misc";
import {
  publishProjectedNotificationFeedCountsBestEffort,
  publishProjectedNotificationFeedUpdatesBestEffort,
} from "@cocalc/server/notifications/feed";
import { forwardRemoteNotificationTargetsBestEffort } from "@cocalc/server/notifications/remote-feed";
import {
  getCodexFreshAuthActionStatus as getAuthoritativeFreshAuthStatus,
  normalizeCodexFreshAuthAttentionContext,
  startCodexFreshAuthChallengeLocal,
} from "@cocalc/server/auth/cli-auth";
import {
  codexFreshAuthAttentionEnabled,
  registerCodexFreshAuthAttention,
} from "@cocalc/server/auth/codex-attention";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

const MAX_MENTION_TARGETS = 25;
const MENTION_RATE_LIMIT_WINDOW_MINUTES = 60;
const MAX_MENTIONS_PER_WINDOW = 120;
const PROJECT_COLLABORATOR_GROUPS = new Set(["owner", "collaborator"]);

function requireAccountId(account_id?: string): string {
  const normalized = `${account_id ?? ""}`.trim();
  if (!normalized) {
    throw Error("user must be signed in");
  }
  return normalized;
}

function normalizeTargetAccountIds({
  target_account_ids,
  max,
}: {
  target_account_ids: string[];
  max: number;
}): string[] {
  const normalized = Array.from(
    new Set(
      (Array.isArray(target_account_ids) ? target_account_ids : []).map((id) =>
        requireUuid(id, "target account id"),
      ),
    ),
  );
  if (normalized.length === 0) {
    throw Error("at least one target account is required");
  }
  if (normalized.length > max) {
    throw Error(`at most ${max} target accounts are allowed`);
  }
  return normalized;
}

function assertTargetAccountsAreProjectCollaborators({
  users,
  target_account_ids,
}: {
  users: Record<string, { group?: string }>;
  target_account_ids: string[];
}) {
  const unauthorized = target_account_ids.filter((account_id) => {
    const group = users?.[account_id]?.group;
    return typeof group !== "string" || !PROJECT_COLLABORATOR_GROUPS.has(group);
  });
  if (unauthorized.length > 0) {
    throw Error("mention targets must be collaborators on the source project");
  }
}

async function assertMentionRateLimit(actor_account_id: string): Promise<void> {
  const { rows } = await getPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::TEXT AS count
        FROM notification_events
       WHERE kind = 'mention'
         AND actor_account_id = $1::UUID
         AND created_at >= NOW() - ($2::TEXT || ' minutes')::INTERVAL
    `,
    [actor_account_id, MENTION_RATE_LIMIT_WINDOW_MINUTES],
  );
  if (Number(rows[0]?.count ?? 0) >= MAX_MENTIONS_PER_WINDOW) {
    throw Error("mention rate limit exceeded");
  }
}

function requireUuid(value: string | undefined, label: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw Error(`invalid ${label} '${value ?? ""}'`);
  }
  return normalized;
}

async function resolveNotificationTargetHomeBaysAllowRemote(opts: {
  account_ids: string[];
  default_bay_id: string;
}): Promise<Record<string, string>> {
  const account_ids = Array.from(
    new Set(opts.account_ids.map((id) => requireUuid(id, "account id"))),
  );
  if (account_ids.length === 0) {
    return {};
  }
  const accounts = await getClusterAccountsByIds(account_ids);
  const byAccountId: Record<string, string> = {};
  for (const account of accounts) {
    const account_id = `${account.account_id ?? ""}`.trim();
    if (!account_id) {
      continue;
    }
    byAccountId[account_id] =
      `${account.home_bay_id ?? ""}`.trim() || opts.default_bay_id;
  }
  for (const account_id of account_ids) {
    if (!byAccountId[account_id]) {
      throw Error(`account '${account_id}' not found`);
    }
  }
  return byAccountId;
}

function requireNonEmptyString(
  value: string | undefined,
  label: string,
): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw Error(`${label} is required`);
  }
  return normalized;
}

function displayPathRelativeToHome(path: string | null | undefined): string {
  const normalized = `${path ?? ""}`.trim();
  if (normalized === "/home/user") {
    return ".";
  }
  const homePrefix = "/home/user/";
  if (normalized.startsWith(homePrefix)) {
    return normalized.slice(homePrefix.length);
  }
  return normalized;
}

function normalizePriority(value?: string): NotificationPriority {
  const priority = `${value ?? "normal"}`.trim();
  if (!["low", "normal", "high"].includes(priority)) {
    throw Error(`invalid priority '${value ?? ""}'`);
  }
  return priority as NotificationPriority;
}

function normalizeMentionNotificationReason(
  value?: string,
): MentionNotificationReason {
  const reason = `${value ?? "mention"}`.trim();
  if (!["mention", "thread_follow"].includes(reason)) {
    throw Error(`invalid mention notification reason '${value ?? ""}'`);
  }
  return reason as MentionNotificationReason;
}

function normalizeSeverity(value?: string): NotificationSeverity {
  const severity = `${value ?? ""}`.trim();
  if (!["info", "warning", "error"].includes(severity)) {
    throw Error(`invalid severity '${value ?? ""}'`);
  }
  return severity as NotificationSeverity;
}

async function assertHostCodexTurnNoticeAccess(opts: {
  host_id: string;
  project_id: string;
  account_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `
      SELECT 1
      FROM projects
      WHERE project_id=$1
        AND host_id=$2
        AND deleted IS NOT true
        AND users ? $3::text
      LIMIT 1
    `,
    [opts.project_id, opts.host_id, opts.account_id],
  );
  if (!rowCount) {
    throw Error("host is not authorized to create codex turn notices");
  }
}

async function createNotificationResult(opts: {
  kind: NotificationKind;
  source_bay_id: string;
  targets: string[];
  buildTargets: (
    targetHomeBays: Record<string, string>,
  ) => Promise<Parameters<typeof createNotificationEventGraph>[0]["targets"]>;
  buildEvent: (
    targetHomeBays: Record<string, string>,
  ) => Promise<
    Omit<Parameters<typeof createNotificationEventGraph>[0], "targets">
  >;
}): Promise<CreateNotificationResult> {
  const target_home_bays = await resolveNotificationTargetHomeBaysAllowRemote({
    account_ids: opts.targets,
    default_bay_id: opts.source_bay_id,
  });
  const graph = await createNotificationEventGraph({
    ...(await opts.buildEvent(target_home_bays)),
    targets: await opts.buildTargets(target_home_bays),
  });
  const remoteOutboxIds = graph.outbox
    .filter((outbox) => outbox.target_home_bay_id !== opts.source_bay_id)
    .map((outbox) => outbox.outbox_id);
  if (remoteOutboxIds.length > 0) {
    await forwardRemoteNotificationTargetsBestEffort({
      bay_id: opts.source_bay_id,
      outbox_ids: remoteOutboxIds,
      limit: remoteOutboxIds.length,
    });
  }
  return {
    event_id: graph.event.event_id,
    kind: graph.event.kind,
    source_bay_id: graph.event.source_bay_id,
    target_count: graph.targets.length,
    notification_ids: graph.targets.map((target) => target.notification_id),
    targets: graph.targets.map((target) => ({
      target_account_id: target.target_account_id,
      target_home_bay_id: target.target_home_bay_id,
      notification_id: target.notification_id,
    })),
  };
}

export async function createMention(
  opts: CreateMentionNotificationOptions,
): Promise<CreateNotificationResult> {
  const account_id = requireAccountId(opts.account_id);
  const source_project_id = requireUuid(
    opts.source_project_id,
    "source project id",
  );
  const projectReference = await assertProjectCollaboratorAccessAllowRemote({
    account_id,
    project_id: source_project_id,
  });
  const source_path = requireNonEmptyString(opts.source_path, "source_path");
  const description = requireNonEmptyString(opts.description, "description");
  const priority = normalizePriority(opts.priority);
  const notification_reason = normalizeMentionNotificationReason(
    opts.notification_reason,
  );
  const actor_account_id = account_id;
  const target_account_ids = normalizeTargetAccountIds({
    target_account_ids: opts.target_account_ids,
    max: MAX_MENTION_TARGETS,
  });
  assertTargetAccountsAreProjectCollaborators({
    users: projectReference.users ?? {},
    target_account_ids,
  });
  await assertMentionRateLimit(actor_account_id);
  const source_bay_id = getConfiguredBayId();
  const source_fragment_id =
    opts.source_fragment_id == null ||
    `${opts.source_fragment_id}`.trim() === ""
      ? null
      : `${opts.source_fragment_id}`.trim();
  const stable_source_id =
    opts.stable_source_id == null || `${opts.stable_source_id}`.trim() === ""
      ? null
      : `${opts.stable_source_id}`.trim();

  return await createNotificationResult({
    kind: "mention",
    source_bay_id,
    targets: target_account_ids,
    buildEvent: async () => ({
      kind: "mention",
      source_bay_id,
      source_project_id,
      source_path,
      source_fragment_id,
      actor_account_id,
      origin_kind: "project",
      payload_json: {
        description,
        priority,
        stable_source_id,
        notification_reason,
      },
    }),
    buildTargets: async (targetHomeBays) =>
      target_account_ids.map((target_account_id) => ({
        target_account_id,
        target_home_bay_id: targetHomeBays[target_account_id],
        dedupe_key: stable_source_id
          ? [
              "mention",
              source_project_id,
              source_path,
              source_fragment_id ?? "",
              stable_source_id,
              target_account_id,
            ].join(":")
          : null,
        summary_json: {
          description,
          path: source_path,
          display_path: displayPathRelativeToHome(source_path),
          fragment_id: source_fragment_id,
          actor_account_id,
          priority,
          stable_source_id,
          notification_reason,
        },
      })),
  });
}

export async function createAccountNotice(
  opts: CreateAccountNoticeOptions,
): Promise<CreateNotificationResult> {
  const account_id = requireAccountId(opts.account_id);
  if (!(await isAdmin(account_id))) {
    throw Error("only admin may create account notices");
  }
  const target_account_ids = Array.from(
    new Set(
      opts.target_account_ids.map((id) => requireUuid(id, "target account id")),
    ),
  );
  if (target_account_ids.length === 0) {
    throw Error("at least one target account is required");
  }
  const severity = normalizeSeverity(opts.severity);
  const title = requireNonEmptyString(opts.title, "title");
  const body_markdown = requireNonEmptyString(
    opts.body_markdown,
    "body_markdown",
  );
  const source_bay_id = getConfiguredBayId();
  const origin_label =
    opts.origin_label == null || `${opts.origin_label}`.trim() === ""
      ? "System"
      : `${opts.origin_label}`.trim();
  const action_link =
    opts.action_link == null || `${opts.action_link}`.trim() === ""
      ? null
      : `${opts.action_link}`.trim();
  const action_label =
    opts.action_label == null || `${opts.action_label}`.trim() === ""
      ? null
      : `${opts.action_label}`.trim();
  const dedupe_key =
    opts.dedupe_key == null || `${opts.dedupe_key}`.trim() === ""
      ? null
      : `${opts.dedupe_key}`.trim();
  const source_project_id =
    opts.source_project_id == null || `${opts.source_project_id}`.trim() === ""
      ? null
      : requireUuid(opts.source_project_id, "source project id");
  const source_path =
    opts.source_path == null || `${opts.source_path}`.trim() === ""
      ? null
      : `${opts.source_path}`.trim();
  const source_fragment_id =
    opts.source_fragment_id == null ||
    `${opts.source_fragment_id}`.trim() === ""
      ? null
      : `${opts.source_fragment_id}`.trim();

  return await createNotificationResult({
    kind: "account_notice",
    source_bay_id,
    targets: target_account_ids,
    buildEvent: async () => ({
      kind: "account_notice",
      source_bay_id,
      source_project_id,
      source_path,
      source_fragment_id,
      actor_account_id: account_id,
      origin_kind: source_project_id ? "project" : "system",
      payload_json: {
        severity,
        title,
        body_markdown,
        origin_label,
        action_link,
        action_label,
        dedupe_key,
      },
    }),
    buildTargets: async (targetHomeBays) =>
      target_account_ids.map((target_account_id) => ({
        target_account_id,
        target_home_bay_id: targetHomeBays[target_account_id],
        dedupe_key: dedupe_key ? `${dedupe_key}:${target_account_id}` : null,
        summary_json: {
          title,
          body_markdown,
          severity,
          origin_label,
          action_link,
          action_label,
          path: source_path,
          display_path: displayPathRelativeToHome(source_path),
          fragment_id: source_fragment_id,
        },
      })),
  });
}

export async function createCodexTurnNotice(
  opts: CreateCodexTurnNoticeOptions,
): Promise<CreateNotificationResult> {
  const account_id = requireAccountId(opts.account_id);
  const source_project_id = requireUuid(
    opts.source_project_id,
    "source project id",
  );
  const host_id = opts.host_id
    ? requireUuid(opts.host_id, "host id")
    : undefined;
  if (host_id) {
    await assertHostCodexTurnNoticeAccess({
      host_id,
      project_id: source_project_id,
      account_id,
    });
  } else {
    await assertProjectCollaboratorAccessAllowRemote({
      account_id,
      project_id: source_project_id,
    });
  }
  const source_path = requireNonEmptyString(opts.source_path, "source_path");
  const source_fragment_id =
    opts.source_fragment_id == null ||
    `${opts.source_fragment_id}`.trim() === ""
      ? null
      : `${opts.source_fragment_id}`.trim();
  const thread_id = requireNonEmptyString(opts.thread_id, "thread_id");
  const thread_label =
    opts.thread_label == null || `${opts.thread_label}`.trim() === ""
      ? null
      : `${opts.thread_label}`.trim();
  const title = requireNonEmptyString(opts.title, "title");
  const body_markdown = requireNonEmptyString(
    opts.body_markdown,
    "body_markdown",
  );
  const severity = normalizeSeverity(opts.severity ?? "info");
  const stable_source_id =
    opts.stable_source_id == null || `${opts.stable_source_id}`.trim() === ""
      ? null
      : `${opts.stable_source_id}`.trim();
  const source_bay_id = getConfiguredBayId();

  return await createNotificationResult({
    kind: "account_notice",
    source_bay_id,
    targets: [account_id],
    buildEvent: async () => ({
      kind: "account_notice",
      source_bay_id,
      source_project_id,
      source_path,
      source_fragment_id,
      actor_account_id: account_id,
      origin_kind: "project",
      payload_json: {
        title,
        body_markdown,
        severity,
        origin_label: "Codex",
        notice_type: "codex_turn_completion",
        thread_id,
        thread_label,
        stable_source_id,
      },
    }),
    buildTargets: async (targetHomeBays) => [
      {
        target_account_id: account_id,
        target_home_bay_id: targetHomeBays[account_id],
        dedupe_key: stable_source_id
          ? [
              "codex_turn_completion",
              source_project_id,
              source_path,
              thread_id,
              stable_source_id,
              account_id,
            ].join(":")
          : null,
        summary_json: {
          title,
          body_markdown,
          severity,
          origin_label: "Codex",
          notice_type: "codex_turn_completion",
          path: source_path,
          display_path: displayPathRelativeToHome(source_path),
          fragment_id: source_fragment_id,
          thread_id,
          thread_label,
          stable_source_id,
        },
      },
    ],
  });
}

export async function createCodexAttentionNotice(
  opts: CreateCodexAttentionNoticeOptions,
): Promise<CreateNotificationResult> {
  const account_id = requireAccountId(opts.account_id);
  const source_project_id = requireUuid(
    opts.source_project_id,
    "source project id",
  );
  const host_id = opts.host_id
    ? requireUuid(opts.host_id, "host id")
    : undefined;
  if (host_id) {
    await assertHostCodexTurnNoticeAccess({
      host_id,
      project_id: source_project_id,
      account_id,
    });
  } else {
    await assertProjectCollaboratorAccessAllowRemote({
      account_id,
      project_id: source_project_id,
    });
  }
  const source_path = requireNonEmptyString(opts.source_path, "source_path");
  const thread_id = requireNonEmptyString(opts.thread_id, "thread_id");
  const attention_id = requireUuid(opts.attention_id, "attention id");
  const attention_kind = requireNonEmptyString(
    opts.attention_kind,
    "attention_kind",
  );
  requireNonEmptyString(opts.title, "title");
  // Question titles originate in model output and remain on the project data
  // plane. Home-bay inbox and email projections use only generic text.
  const title = "Codex needs your attention";
  const stable_source_id = requireNonEmptyString(
    opts.stable_source_id,
    "stable_source_id",
  );
  const source_bay_id = getConfiguredBayId();
  const thread_label = `${opts.thread_label ?? ""}`.trim() || null;
  const fragment_id = `${opts.source_fragment_id ?? ""}`.trim() || null;
  const state = opts.state ?? "pending";
  const body_markdown =
    state === "pending"
      ? opts.is_blocking
        ? "Codex is paused until you respond."
        : "Codex requested input and may continue working while it waits."
      : state === "stale"
        ? "Codex disconnected before it could accept the response."
        : `This Codex request is ${state}.`;
  return await createNotificationResult({
    kind: "account_notice",
    source_bay_id,
    targets: [account_id],
    buildEvent: async () => ({
      kind: "account_notice",
      source_bay_id,
      source_project_id,
      source_path,
      source_fragment_id: fragment_id,
      actor_account_id: account_id,
      origin_kind: "project",
      payload_json: {
        title,
        body_markdown,
        severity: "warning",
        origin_label: "Codex",
        notice_type: "codex_attention",
        thread_id,
        thread_label,
        attention_id,
        attention_kind,
        is_blocking: opts.is_blocking,
        stable_source_id,
        attention_state: state,
        acknowledged_at: opts.acknowledged_at,
        snoozed_until: opts.snoozed_until,
      },
    }),
    buildTargets: async (targetHomeBays) => [
      {
        target_account_id: account_id,
        target_home_bay_id: targetHomeBays[account_id],
        dedupe_key: [
          "codex_attention",
          source_project_id,
          stable_source_id,
          account_id,
        ].join(":"),
        summary_json: {
          title,
          body_markdown,
          severity: "warning",
          origin_label: "Codex",
          notice_type: "codex_attention",
          path: source_path,
          display_path: displayPathRelativeToHome(source_path),
          fragment_id,
          thread_id,
          thread_label,
          attention_id,
          attention_kind,
          is_blocking: opts.is_blocking,
          stable_source_id,
          attention_state: state,
          acknowledged_at: opts.acknowledged_at,
          snoozed_until: opts.snoozed_until,
        },
      },
    ],
  });
}

export async function getCodexFreshAuthActionStatus(
  opts: GetCodexFreshAuthActionStatusOptions,
): Promise<CodexFreshAuthActionStatus> {
  const account_id = requireAccountId(opts.account_id);
  const project_id = requireUuid(opts.source_project_id, "source project id");
  const host_id = opts.host_id
    ? requireUuid(opts.host_id, "host id")
    : undefined;
  if (host_id) {
    await assertHostCodexTurnNoticeAccess({
      host_id,
      project_id,
      account_id,
    });
  } else {
    await assertProjectCollaboratorAccessAllowRemote({
      account_id,
      project_id,
    });
  }
  const challenge_id = requireUuid(opts.challenge_id, "challenge id");
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const status =
    home_bay_id === getConfiguredBayId()
      ? await getAuthoritativeFreshAuthStatus({
          challenge_id,
          account_id,
          project_id,
        })
      : await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: home_bay_id,
        }).getCodexFreshAuthStatus({
          challenge_id,
          account_id,
          project_id,
        });
  return {
    ...status,
    expires_at: new Date(status.expires_at).toISOString(),
  };
}

export async function startCodexFreshAuthAction(
  opts: StartCodexFreshAuthActionOptions,
): Promise<CodexFreshAuthActionStart> {
  if (!codexFreshAuthAttentionEnabled()) {
    throw new Error("Codex fresh-auth attention is disabled");
  }
  const account_id = requireAccountId(opts.account_id);
  const project_id = requireUuid(opts.source_project_id, "source project id");
  const context = normalizeCodexFreshAuthAttentionContext(opts.context);
  if (!context || context.project_id !== project_id) {
    throw new Error("Codex attention context project mismatch");
  }
  await assertProjectCollaboratorAccessAllowRemote({
    account_id,
    project_id,
  });
  const browser_id = `${opts.browser_id ?? ""}`.trim();
  if (!browser_id || browser_id.length > 200) {
    throw new Error("valid browser id is required for fresh authorization");
  }
  const target_session_hash = getBrowserAuthSessionHash({
    account_id,
    browser_id,
  });
  if (!target_session_hash) {
    throw new Error(
      "The active CoCalc browser session could not be found. Keep the originating browser tab open and retry.",
    );
  }
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const started =
    home_bay_id === getConfiguredBayId()
      ? await startCodexFreshAuthChallengeLocal({
          account_id,
          session_hash: target_session_hash,
          duration: opts.duration,
          context,
        })
      : await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: home_bay_id,
        }).startCodexFreshAuth({
          account_id,
          target_session_hash,
          duration: opts.duration,
          context,
        });
  await registerCodexFreshAuthAttention({
    account_id,
    challenge_id: started.challenge_id,
    context,
  });
  return {
    challenge_id: started.challenge_id,
    state: "pending",
    expires_at: new Date(started.expires_at).toISOString(),
  };
}

export async function list(
  opts: ListNotificationsOptions = {},
): Promise<NotificationListRow[]> {
  const account_id = requireAccountId(opts.account_id);
  return await listProjectedNotificationsForAccount({
    account_id,
    limit: opts.limit,
    notification_id: opts.notification_id,
    kind: opts.kind,
    project_id: opts.project_id,
    state: opts.state,
  });
}

export async function listSnapshot(
  opts: ListNotificationsOptions = {},
): Promise<NotificationListSnapshot> {
  const account_id = requireAccountId(opts.account_id);
  return await listProjectedNotificationSnapshotForAccount({
    account_id,
    limit: opts.limit,
    notification_id: opts.notification_id,
    kind: opts.kind,
    project_id: opts.project_id,
    state: opts.state,
  });
}

export async function counts(opts?: {
  account_id?: string;
}): Promise<NotificationCountsResult> {
  const account_id = requireAccountId(opts?.account_id);
  return await getProjectedNotificationCounts({
    account_id,
  });
}

export async function markRead(
  opts: MarkNotificationReadOptions,
): Promise<MarkNotificationReadResult> {
  const account_id = requireAccountId(opts.account_id);
  const result = await setProjectedNotificationReadState({
    account_id,
    notification_ids: opts.notification_ids,
    read: opts.read ?? true,
  });
  const notification_ids = result.notification_ids ?? opts.notification_ids;
  if (result.updated_count > 0) {
    await publishProjectedNotificationFeedUpdatesBestEffort({
      account_id,
      reason: "read_state_updated",
      notification_ids,
    });
  }
  return {
    ...result,
    notification_ids,
  };
}

export async function markAllRead(
  opts: MarkAllNotificationsReadOptions,
): Promise<MarkAllNotificationsReadResult> {
  const account_id = requireAccountId(opts.account_id);
  const result = await markProjectedNotificationsReadThrough({
    account_id,
    project_id: opts.project_id,
    read_through_revision: opts.read_through_revision,
  });
  if (result.updated_count > 0) {
    await publishProjectedNotificationFeedCountsBestEffort({
      account_id,
      reason: "read_state_updated",
    });
  }
  return result;
}

export async function save(
  opts: SaveNotificationOptions,
): Promise<MarkNotificationReadResult> {
  const account_id = requireAccountId(opts.account_id);
  const result = await setProjectedNotificationSavedState({
    account_id,
    notification_ids: opts.notification_ids,
    saved: opts.saved ?? true,
  });
  const notification_ids = result.notification_ids ?? opts.notification_ids;
  if (result.updated_count > 0) {
    await publishProjectedNotificationFeedUpdatesBestEffort({
      account_id,
      reason: "saved_state_updated",
      notification_ids,
    });
  }
  return {
    ...result,
    notification_ids,
  };
}

export async function archive(
  opts: ArchiveNotificationOptions,
): Promise<MarkNotificationReadResult> {
  const account_id = requireAccountId(opts.account_id);
  const result = await setProjectedNotificationArchivedState({
    account_id,
    notification_ids: opts.notification_ids,
    archived: opts.archived ?? true,
  });
  const notification_ids = result.notification_ids ?? opts.notification_ids;
  if (result.updated_count > 0) {
    await publishProjectedNotificationFeedUpdatesBestEffort({
      account_id,
      reason: "archived_state_updated",
      notification_ids,
    });
  }
  return {
    ...result,
    notification_ids,
  };
}
