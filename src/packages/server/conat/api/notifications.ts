/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import {
  getProjectedNotificationCounts,
  listProjectedNotificationsForAccount,
  setProjectedNotificationArchivedState,
  setProjectedNotificationReadState,
  setProjectedNotificationSavedState,
} from "@cocalc/database/postgres/account-notification-index";
import {
  createNotificationEventGraph,
  resolveNotificationTargetHomeBays,
  type NotificationKind,
} from "@cocalc/database/postgres/notifications-core";
import type {
  CreateAccountNoticeOptions,
  ArchiveNotificationOptions,
  CreateMentionNotificationOptions,
  CreateNotificationResult,
  ListNotificationsOptions,
  MarkNotificationReadOptions,
  MarkNotificationReadResult,
  NotificationCountsResult,
  NotificationListRow,
  NotificationPriority,
  NotificationSeverity,
  SaveNotificationOptions,
} from "@cocalc/conat/hub/api/notifications";
import { isValidUUID } from "@cocalc/util/misc";
import { publishProjectedNotificationFeedUpdatesBestEffort } from "@cocalc/server/notifications/feed";

function requireAccountId(account_id?: string): string {
  const normalized = `${account_id ?? ""}`.trim();
  if (!normalized) {
    throw Error("user must be signed in");
  }
  return normalized;
}

function requireUuid(value: string | undefined, label: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw Error(`invalid ${label} '${value ?? ""}'`);
  }
  return normalized;
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

function normalizePriority(value?: string): NotificationPriority {
  const priority = `${value ?? "normal"}`.trim();
  if (!["low", "normal", "high"].includes(priority)) {
    throw Error(`invalid priority '${value ?? ""}'`);
  }
  return priority as NotificationPriority;
}

function normalizeSeverity(value?: string): NotificationSeverity {
  const severity = `${value ?? ""}`.trim();
  if (!["info", "warning", "error"].includes(severity)) {
    throw Error(`invalid severity '${value ?? ""}'`);
  }
  return severity as NotificationSeverity;
}

async function authorizeActor(opts: {
  account_id: string;
  actor_account_id?: string;
}): Promise<string> {
  const actor_account_id = opts.actor_account_id
    ? requireUuid(opts.actor_account_id, "actor account id")
    : opts.account_id;
  if (actor_account_id === opts.account_id) {
    return actor_account_id;
  }
  if (!(await isAdmin(opts.account_id))) {
    throw Error("only admin may act as another account");
  }
  return actor_account_id;
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
  const target_home_bays = await resolveNotificationTargetHomeBays({
    account_ids: opts.targets,
    default_bay_id: opts.source_bay_id,
  });
  const graph = await createNotificationEventGraph({
    ...(await opts.buildEvent(target_home_bays)),
    targets: await opts.buildTargets(target_home_bays),
  });
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
  await assertLocalProjectCollaborator({
    account_id,
    project_id: source_project_id,
  });
  const source_path = requireNonEmptyString(opts.source_path, "source_path");
  const description = requireNonEmptyString(opts.description, "description");
  const priority = normalizePriority(opts.priority);
  const actor_account_id = await authorizeActor({
    account_id,
    actor_account_id: opts.actor_account_id,
  });
  const target_account_ids = Array.from(
    new Set(
      opts.target_account_ids.map((id) => requireUuid(id, "target account id")),
    ),
  );
  if (target_account_ids.length === 0) {
    throw Error("at least one target account is required");
  }
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
          fragment_id: source_fragment_id,
          actor_account_id,
          priority,
          stable_source_id,
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

  return await createNotificationResult({
    kind: "account_notice",
    source_bay_id,
    targets: target_account_ids,
    buildEvent: async () => ({
      kind: "account_notice",
      source_bay_id,
      source_project_id: null,
      actor_account_id: account_id,
      origin_kind: "system",
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
        },
      })),
  });
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
