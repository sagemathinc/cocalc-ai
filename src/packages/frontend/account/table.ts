/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  accountFeedStreamName,
  type AccountFeedAccountRow,
  type AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { Table } from "@cocalc/frontend/app-framework/Table";
import { getSharedAccountDStream } from "@cocalc/frontend/conat/account-dstream";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { redux as appRedux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";

export function normalizeAccountPatch(redux, obj: Record<string, any>) {
  const next = { ...obj };
  if (next.other_settings != null) {
    const current =
      redux.getStore("account")?.get("other_settings")?.toJS?.() ?? {};
    next.other_settings = { ...current, ...next.other_settings };
  }
  if (Object.prototype.hasOwnProperty.call(next, "home_bay_id")) {
    next.home_bay_source = next.home_bay_id ? "account-row" : undefined;
  }
  return next;
}

export function applyAccountPatch(opts: {
  redux;
  patch: Record<string, any>;
  first_set?: boolean;
}): void {
  const actions = opts.redux.getActions("account");
  const next = normalizeAccountPatch(opts.redux, opts.patch);
  actions.setState(next);
  if (opts.first_set) {
    actions.setState({ is_ready: true });
    opts.redux.getStore("account").emit("is_ready");
  }
}

// Create and register account table, which gets automatically
// synchronized with the server.
export class AccountTable extends Table {
  private first_set = true;

  constructor(name, redux) {
    super(name, redux);
    this.query = this.query.bind(this);
    this._change = this._change.bind(this);
  }

  options() {
    return [];
  }

  no_changefeed() {
    return true;
  }

  query() {
    return {
      accounts: [
        {
          account_id: null,
          home_bay_id: null,
          balance: null,
          min_balance: null,
          balance_alert: null,
          auto_balance: null,
          email_address: null,
          email_address_verified: null,
          email_address_problem: null,
          editor_settings: null,
          other_settings: null,
          name: null,
          first_name: null,
          last_name: null,
          terminal: null,
          autosave: null,
          evaluate_key: null,
          font_size: null,
          passports: null,
          groups: null,
          last_active: null,
          ssh_keys: null,
          default_rootfs_image: null,
          default_rootfs_image_gpu: null,
          created: null,
          ephemeral: null,
          customize: null,
          unlisted: null,
          tags: null,
          tours: null,
          purchase_closing_day: null,
          email_daily_statements: null,
          stripe_checkout_session: null,
          stripe_usage_subscription: null,
          stripe_customer: null,
          unread_message_count: null,
          profile: null,
        },
      ],
    };
  }

  _change(table: { get_one: () => { toJS: () => any } }) {
    const changes = table.get_one();
    if (!changes) return;
    const obj = changes.toJS();
    applyAccountPatch({
      redux: this.redux,
      patch: obj,
      first_set: this.first_set,
    });
    if (this.first_set) {
      this.first_set = false;
    }
  }
}

let signedInListener: (() => void) | undefined;
let signedOutListener: (() => void) | undefined;
let rememberMeFailedListener: (() => void) | undefined;
let conatConnectedListener: (() => void) | undefined;
let realtimeFeed: DStream<AccountFeedEvent> | undefined;
let realtimeFeedAccountId: string | undefined;
let realtimeRedux: any;
let recreateAccountTable: ((redux) => void) | undefined;

function getAccountId(): string | undefined {
  return (
    webapp_client.account_id ?? appRedux.getStore("account")?.get("account_id")
  );
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
  if (!webapp_client.is_signed_in()) {
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
    console.warn("account realtime feed error", err);
  }
}

const refreshAccountSnapshot = reuseInFlight(async (): Promise<void> => {
  if (realtimeRedux == null || recreateAccountTable == null) {
    return;
  }
  recreateAccountTable(realtimeRedux);
});

function handleRealtimeFeedChange(event?: AccountFeedEvent): void {
  if (
    event == null ||
    event.type !== "account.upsert" ||
    realtimeRedux == null
  ) {
    return;
  }
  applyAccountPatch({
    redux: realtimeRedux,
    patch: event.account as AccountFeedAccountRow,
  });
}

function handleRealtimeFeedHistoryGap(): void {
  void refreshAccountSnapshot();
}

export function initAccountRealtime(opts: {
  redux;
  recreate_account_table: (redux) => void;
}): void {
  realtimeRedux = opts.redux;
  recreateAccountTable = opts.recreate_account_table;
  if (signedInListener != null) {
    return;
  }
  signedInListener = () => {
    if (!lite) {
      opts.recreate_account_table(opts.redux);
    }
    void ensureRealtimeFeedForCurrentAccount();
  };
  signedOutListener = () => {
    closeRealtimeFeed();
  };
  rememberMeFailedListener = () => {
    closeRealtimeFeed();
  };
  conatConnectedListener = () => {
    void ensureRealtimeFeedForCurrentAccount();
  };
  webapp_client.on("signed_in", signedInListener);
  webapp_client.on("signed_out", signedOutListener);
  webapp_client.on("remember_me_failed", rememberMeFailedListener);
  webapp_client.conat_client.on("connected", conatConnectedListener);
  void ensureRealtimeFeedForCurrentAccount();
}
