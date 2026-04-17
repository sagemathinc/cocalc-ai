/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, Map } from "immutable";

import {
  accountFeedStreamName,
  type AccountFeedCollaboratorRow,
  type AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { once } from "@cocalc/util/async-utils";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { getSharedAccountDStream } from "@cocalc/frontend/conat/account-dstream";
import { Table, redux } from "../app-framework";
import { COCALC_MINIMAL } from "../fullscreen";
import { webapp_client } from "../webapp-client";
import { actions } from "./actions";
import { store } from "./store";

function dateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function buildCollaboratorRecord(
  row: AccountFeedCollaboratorRow,
): Map<string, any> {
  return (
    fromJS({
      account_id: row.account_id,
      first_name: row.first_name ?? "",
      last_name: row.last_name ?? "",
      name: row.name ?? "",
      profile: row.profile ?? null,
      collaborator: true,
    }) as Map<string, any>
  ).set("last_active", dateOrNull(row.last_active));
}

export function mergeUsersSnapshot(
  upstream_user_map: Map<string, Map<string, any>>,
): Map<string, any> {
  let next = (store.get("user_map") ?? Map<string, any>()).asMutable();
  next.forEach((data, account_id) => {
    if (data?.get?.("collaborator")) {
      next = next.set(account_id, data.set("collaborator", false));
    }
  });
  upstream_user_map.forEach((data, account_id) => {
    next = next.set(
      account_id,
      (next.get(account_id) ?? Map<string, any>())
        .merge(data)
        .set("collaborator", true),
    );
  });
  return next.asImmutable();
}

function applyCollaboratorFeedUpsert(row: AccountFeedCollaboratorRow): void {
  const user_map = store.get("user_map") ?? Map<string, any>();
  const next = buildCollaboratorRecord(row);
  if (next.equals(user_map.get(row.account_id))) {
    return;
  }
  actions.setState({
    user_map: user_map.set(
      row.account_id,
      (user_map.get(row.account_id) ?? Map<string, any>()).merge(next),
    ),
  });
}

function applyCollaboratorFeedRemove(collaborator_account_id: string): void {
  const user_map = store.get("user_map");
  const existing = user_map?.get(collaborator_account_id);
  if (existing == null || !existing.get("collaborator")) {
    return;
  }
  actions.setState({
    user_map: user_map.set(
      collaborator_account_id,
      existing.set("collaborator", false),
    ),
  });
}

function getKioskProjectId(): string | undefined {
  return redux.getStore("page")?.get("kiosk_project_id");
}

function shouldHaveUsersTable(): boolean {
  return !COCALC_MINIMAL || getKioskProjectId() != null;
}

class UsersTable extends Table {
  query() {
    const kiosk_project_id = getKioskProjectId();
    if (kiosk_project_id) {
      const query = require("@cocalc/sync/table/util").parse_query(
        "collaborators_one_project",
      );
      query.collaborators_one_project[0].project_id = kiosk_project_id;
      return query;
    }
    return "collaborators";
  }

  no_changefeed() {
    return true;
  }

  _change(table, _keys) {
    actions.setState({ user_map: mergeUsersSnapshot(table.get()) });
  }
}

let signedInListener: (() => void) | undefined;
let signedOutListener: (() => void) | undefined;
let conatConnectedListener: (() => void) | undefined;
let accountStoreReadyListener: (() => void) | undefined;
let observedAccountStore:
  | {
      get?: (key: string) => unknown;
      on?: (event: string, cb: () => void) => void;
      removeListener?: (event: string, cb: () => void) => void;
    }
  | undefined;
let realtimeFeed: DStream<AccountFeedEvent> | undefined;
let realtimeFeedAccountId: string | undefined;

function getAccountId(): string | undefined {
  return redux.getStore("account")?.get("account_id");
}

function closeRealtimeFeed(): void {
  if (realtimeFeed != null) {
    realtimeFeed.removeListener("change", handleRealtimeFeedChange);
    realtimeFeed.removeListener("history-gap", handleRealtimeFeedHistoryGap);
    realtimeFeed = undefined;
  }
  realtimeFeedAccountId = undefined;
}

async function ensureRealtimeFeedForCurrentAccount(): Promise<void> {
  if (!webapp_client.is_signed_in() || getKioskProjectId() != null) {
    closeRealtimeFeed();
    return;
  }
  const account_id = getAccountId();
  if (account_id == null) {
    return;
  }
  if (
    realtimeFeed != null &&
    realtimeFeedAccountId === account_id &&
    !realtimeFeed.isClosed()
  ) {
    return;
  }
  closeRealtimeFeed();
  try {
    const feed = await getSharedAccountDStream<AccountFeedEvent>({
      account_id,
      name: accountFeedStreamName(),
      ephemeral: true,
      maxListeners: 100,
    });
    feed.on("change", handleRealtimeFeedChange);
    feed.on("history-gap", handleRealtimeFeedHistoryGap);
    realtimeFeed = feed;
    realtimeFeedAccountId = account_id;
  } catch (err) {
    console.warn("users realtime feed error", err);
  }
}

const refreshUsersTable = reuseInFlight(async (): Promise<void> => {
  if (!shouldHaveUsersTable()) {
    return;
  }
  redux.removeTable("users");
  const table = redux.createTable("users", UsersTable);
  await once(table._table, "connected");
});

function handleRealtimeFeedChange(event?: AccountFeedEvent): void {
  if (event == null) {
    return;
  }
  switch (event.type) {
    case "collaborator.upsert":
      applyCollaboratorFeedUpsert(event.collaborator);
      break;
    case "collaborator.remove":
      applyCollaboratorFeedRemove(event.collaborator_account_id);
      break;
    default:
      break;
  }
}

function handleRealtimeFeedHistoryGap(): void {
  void refreshUsersTable();
}

function observeAccountStoreReady(): void {
  const onReady = accountStoreReadyListener;
  if (onReady == null) {
    return;
  }
  const attachStore = (
    nextStore = redux.getStore("account") as typeof observedAccountStore,
  ): void => {
    if (nextStore === observedAccountStore) {
      return;
    }
    observedAccountStore?.removeListener?.("is_ready", onReady);
    observedAccountStore = nextStore;
    observedAccountStore?.on?.("is_ready", onReady);
    if (observedAccountStore?.get?.("is_ready")) {
      onReady();
    }
  };

  attachStore();
  redux.reduxStore.subscribe(() => {
    attachStore();
  });
}

function initRealtime(): void {
  if (signedInListener != null) {
    return;
  }
  signedInListener = () => {
    void refreshUsersTable();
    void ensureRealtimeFeedForCurrentAccount();
  };
  signedOutListener = () => {
    closeRealtimeFeed();
    actions.setState({ user_map: fromJS({}) });
  };
  conatConnectedListener = () => {
    void ensureRealtimeFeedForCurrentAccount();
  };
  accountStoreReadyListener = () => {
    void ensureRealtimeFeedForCurrentAccount();
  };
  webapp_client.on("signed_in", signedInListener);
  webapp_client.on("signed_out", signedOutListener);
  webapp_client.conat_client.on("connected", conatConnectedListener);
  observeAccountStoreReady();
  void ensureRealtimeFeedForCurrentAccount();
}

if (shouldHaveUsersTable()) {
  redux.createTable("users", UsersTable);
}
initRealtime();

export function recreate_users_table(): void {
  void refreshUsersTable();
  void ensureRealtimeFeedForCurrentAccount();
}
