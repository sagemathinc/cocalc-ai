/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, Map } from "immutable";

import { Actions } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { once } from "@cocalc/util/async-utils";
import type {
  NotificationCountsResult,
  NotificationListRow,
} from "@cocalc/conat/hub/api/notifications";
import type { AccountFeedEvent } from "@cocalc/conat/hub/api/account-feed";
import { accountFeedStreamName } from "@cocalc/conat/hub/api/account-feed";
import { MentionsState } from "./store";
import {
  type MentionInfo,
  type MentionsMap,
  NotificationFilter,
} from "./types";
import type { DStream } from "@cocalc/conat/sync/dstream";

const DEFAULT_INBOX_LIMIT = 500;

function mentionSort(a: MentionInfo, b: MentionInfo): number {
  return b.get("time").getTime() - a.get("time").getTime();
}

function buildNotificationMention(
  account_id: string,
  row: Pick<
    NotificationListRow,
    | "notification_id"
    | "kind"
    | "project_id"
    | "summary"
    | "read_state"
    | "created_at"
    | "updated_at"
  >,
): MentionInfo {
  const time = row.created_at ?? row.updated_at ?? new Date();
  const summary = row.summary ?? {};
  return fromJS({
    kind: row.kind,
    notification_id: row.notification_id,
    path: summary.path ?? "",
    priority: summary.priority ?? 2,
    project_id: row.project_id,
    source: summary.actor_account_id ?? "",
    target: account_id,
    time,
    title: summary.title,
    body_markdown: summary.body_markdown,
    origin_label: summary.origin_label,
    action_link: summary.action_link,
    action_label: summary.action_label,
    severity: summary.severity,
    description: summary.description,
    fragment_id: summary.fragment_id,
    users: {
      [account_id]: {
        read: !!row.read_state?.read,
        saved: !!row.read_state?.saved,
      },
    },
  }) as unknown as MentionInfo;
}

export function buildNotificationInboxMap(opts: {
  account_id: string;
  rows: NotificationListRow[];
}): MentionsMap {
  const mentions = Map<string, MentionInfo>().asMutable();
  for (const row of opts.rows) {
    if (row.read_state?.archived) {
      continue;
    }
    mentions.set(
      row.notification_id,
      buildNotificationMention(opts.account_id, row),
    );
  }
  return mentions.asImmutable().sort(mentionSort) as MentionsMap;
}

export function getUnreadNotificationCount(
  counts?: NotificationCountsResult,
): number {
  return counts?.unread ?? 0;
}

type ProjectKey = string | null;

function matchesProjectKey(
  mention: MentionInfo,
  projectKey: ProjectKey,
): boolean {
  const project_id = mention.get("project_id");
  return projectKey == null ? project_id == null : project_id === projectKey;
}

export class MentionsActions extends Actions<MentionsState> {
  private refreshInFlight?: Promise<void>;
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

  _init() {
    this.signedInListener = () => {
      void this.refresh();
    };
    this.signedOutListener = () => {
      this.closeRealtimeFeed();
      this.setState({ mentions: Map(), unread_count: 0, loading: false });
    };
    this.conatConnectedListener = () => {
      void this.refresh();
    };
    this.accountStoreReadyListener = () => {
      void this.refresh();
    };
    webapp_client.on("signed_in", this.signedInListener);
    webapp_client.on("signed_out", this.signedOutListener);
    webapp_client.conat_client.on("connected", this.conatConnectedListener);
    this.observeAccountStoreReady();
    void this.refresh();
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

  public set_filter(filter: NotificationFilter, id?: number) {
    this.setState({ filter, id });
  }

  public update_state(mentions: MentionsMap): void {
    this.setState({
      loading: false,
      mentions: mentions.sort(mentionSort) as MentionsMap,
    });
  }

  private getAccountId(): string | undefined {
    return this.redux.getStore("account")?.get("account_id");
  }

  private getMentions(): MentionsMap {
    return (this.redux.getStore("mentions")?.get("mentions") ??
      Map()) as MentionsMap;
  }

  private updateMention(new_mention: MentionInfo, id: string) {
    const current_mentions = this.getMentions().set(id, new_mention);
    this.setState({ mentions: current_mentions });
  }

  public refresh = async (): Promise<void> => {
    if (this.refreshInFlight != null) {
      return await this.refreshInFlight;
    }
    this.refreshInFlight = this.refreshImpl().finally(() => {
      this.refreshInFlight = undefined;
    });
    return await this.refreshInFlight;
  };

  private async refreshImpl(): Promise<void> {
    if (!webapp_client.is_signed_in()) {
      this.setState({ mentions: Map(), unread_count: 0, loading: false });
      return;
    }
    const account_id = this.getAccountId();
    if (account_id == null) {
      this.setState({ mentions: Map(), unread_count: 0, loading: true });
      return;
    }
    const notifications = webapp_client.conat_client?.hub?.notifications;
    if (notifications == null) {
      this.setState({ loading: true });
      return;
    }
    this.setState({ loading: true });
    try {
      const [rows, counts] = await Promise.all([
        notifications.list({ limit: DEFAULT_INBOX_LIMIT }),
        notifications.counts({}),
      ]);
      this.setState({
        loading: false,
        mentions: buildNotificationInboxMap({ account_id, rows }),
        unread_count: getUnreadNotificationCount(counts),
      });
      await this.ensureRealtimeFeed(account_id);
    } catch (err) {
      console.warn("WARNING: notifications refresh error -- ", err);
    }
  }

  private closeRealtimeFeed(): void {
    if (this.realtimeFeed != null) {
      this.realtimeFeed.removeListener("change", this.handleRealtimeFeedChange);
      this.realtimeFeed.removeListener(
        "history-gap",
        this.handleRealtimeFeedHistoryGap,
      );
      this.realtimeFeed.close();
      this.realtimeFeed = undefined;
    }
    this.realtimeFeedAccountId = undefined;
  }

  private handleRealtimeFeedChange = (event?: AccountFeedEvent): void => {
    const account_id = this.getAccountId();
    if (event == null || account_id == null || event.account_id !== account_id) {
      return;
    }
    switch (event.type) {
      case "notification.upsert": {
        const mention = buildNotificationMention(account_id, {
          ...event.notification,
          created_at: event.notification.created_at
            ? new Date(event.notification.created_at)
            : null,
          updated_at: event.notification.updated_at
            ? new Date(event.notification.updated_at)
            : null,
        });
        this.setState({
          mentions: this.getMentions()
            .set(event.notification.notification_id, mention)
            .sort(mentionSort) as MentionsMap,
        });
        return;
      }
      case "notification.remove":
        this.setState({
          mentions: this.getMentions().remove(event.notification_id),
        });
        return;
      case "notification.counts":
        this.setState({ unread_count: event.counts.unread });
        return;
      default:
        return;
    }
  };

  private handleRealtimeFeedHistoryGap = (): void => {
    void this.refresh();
  };

  private observeAccountStoreReady(): void {
    const onReady = this.accountStoreReadyListener;
    if (onReady == null) {
      return;
    }

    const attachStore = (
      store = this.redux.getStore("account") as typeof this.observedAccountStore,
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

  private async ensureRealtimeFeed(account_id: string): Promise<void> {
    if (
      this.realtimeFeed != null &&
      this.realtimeFeedAccountId === account_id &&
      !this.realtimeFeed.isClosed()
    ) {
      return;
    }
    this.closeRealtimeFeed();
    try {
      const feed = await webapp_client.conat_client.dstream<AccountFeedEvent>({
        account_id,
        name: accountFeedStreamName(),
        ephemeral: true,
      });
      feed.on("change", this.handleRealtimeFeedChange);
      feed.on("history-gap", this.handleRealtimeFeedHistoryGap);
      this.realtimeFeed = feed;
      this.realtimeFeedAccountId = account_id;
    } catch (err) {
      console.warn("WARNING: notifications realtime feed error -- ", err);
    }
  }

  private async ensureSignedIn() {
    if (!webapp_client.is_signed_in()) {
      await once(webapp_client, "signed_in");
    }
  }

  private async updateReadState(opts: {
    notification_ids: string[];
    read: boolean;
  }): Promise<void> {
    if (opts.notification_ids.length === 0) {
      return;
    }
    await this.ensureSignedIn();
    await webapp_client.conat_client.hub.notifications.markRead(opts);
  }

  private async updateSavedState(opts: {
    notification_ids: string[];
    saved: boolean;
  }): Promise<void> {
    if (opts.notification_ids.length === 0) {
      return;
    }
    await this.ensureSignedIn();
    await webapp_client.conat_client.hub.notifications.save(opts);
  }

  public mark(mention: MentionInfo, id: string, type: "read" | "unread"): void {
    const account_id = this.getAccountId();
    if (account_id == null) {
      return;
    }
    const adjusted_mention = mention.setIn(
      ["users", account_id, "read"],
      type === "read",
    );
    this.updateMention(adjusted_mention, id);
    void this.updateReadState({
      notification_ids: [id],
      read: type === "read",
    }).catch(async (err) => {
      console.warn("WARNING: notifications mark error -- ", err);
      await this.refresh();
    });
  }

  public async markAll(
    project_id: ProjectKey,
    as: "read" | "unread",
  ): Promise<void> {
    const account_id = this.getAccountId();
    if (account_id == null) {
      return;
    }
    const notification_ids = this.getMentions()
      .filter(
        (mention) =>
          matchesProjectKey(mention, project_id) &&
          mention.getIn(["users", account_id, "read"]) !== (as === "read"),
      )
      .keySeq()
      .toArray();
    try {
      await this.updateReadState({
        notification_ids,
        read: as === "read",
      });
    } catch (err) {
      console.warn("WARNING: notifications markAll error -- ", err);
    }
  }

  public async saveAll(
    project_id: ProjectKey,
    filter: "read" | "unread",
  ): Promise<void> {
    const account_id = this.getAccountId();
    if (account_id == null) {
      return;
    }
    const notification_ids = this.getMentions()
      .filter(
        (mention) =>
          matchesProjectKey(mention, project_id) &&
          mention.getIn(["users", account_id, "read"]) ===
            (filter === "read") &&
          !mention.getIn(["users", account_id, "saved"]),
      )
      .keySeq()
      .toArray();
    try {
      await this.updateSavedState({
        notification_ids,
        saved: true,
      });
    } catch (err) {
      console.warn("WARNING: notifications saveAll error -- ", err);
    }
  }

  public markSaved(
    mention: MentionInfo,
    id: string,
    as: "saved" | "unsaved",
  ): void {
    const account_id = this.getAccountId();
    if (account_id == null) {
      return;
    }
    const adjusted_mention = mention.setIn(
      ["users", account_id, "saved"],
      as === "saved",
    );
    this.updateMention(adjusted_mention, id);
    void this.updateSavedState({
      notification_ids: [id],
      saved: as === "saved",
    }).catch(async (err) => {
      console.warn("WARNING: notifications save error -- ", err);
      await this.refresh();
    });
  }
}
