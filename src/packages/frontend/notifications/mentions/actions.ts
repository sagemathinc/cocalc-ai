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
import { MentionsState } from "./store";
import {
  type MentionInfo,
  type MentionsMap,
  NotificationFilter,
} from "./types";

const DEFAULT_INBOX_LIMIT = 500;
const REFRESH_INTERVAL_MS = 5_000;

function mentionSort(a: MentionInfo, b: MentionInfo): number {
  return b.get("time").getTime() - a.get("time").getTime();
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
    const time = row.created_at ?? row.updated_at ?? new Date();
    const summary = row.summary ?? {};
    mentions.set(
      row.notification_id,
      fromJS({
        kind: row.kind,
        notification_id: row.notification_id,
        path: summary.path ?? "",
        priority: summary.priority ?? 2,
        project_id: row.project_id,
        source: summary.actor_account_id ?? "",
        target: opts.account_id,
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
          [opts.account_id]: {
            read: !!row.read_state?.read,
            saved: !!row.read_state?.saved,
          },
        },
      }) as unknown as MentionInfo,
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
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<void>;
  private signedInListener?: () => void;

  _init() {
    this.signedInListener = () => {
      void this.refresh();
    };
    webapp_client.on("signed_in", this.signedInListener);
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    void this.refresh();
  }

  public override destroy = (): void => {
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.signedInListener != null) {
      webapp_client.removeListener?.("signed_in", this.signedInListener);
      this.signedInListener = undefined;
    }
    Actions.prototype.destroy.call(this);
  };

  public set_filter(filter: NotificationFilter, id?: number) {
    this.setState({ filter, id });
  }

  public update_state(mentions: MentionsMap): void {
    this.setState({
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
      this.setState({ mentions: Map(), unread_count: 0 });
      return;
    }
    const account_id = this.getAccountId();
    if (account_id == null) {
      this.setState({ mentions: Map(), unread_count: 0 });
      return;
    }
    const notifications = webapp_client.conat_client?.hub?.notifications;
    if (notifications == null) {
      return;
    }
    try {
      const [rows, counts] = await Promise.all([
        notifications.list({ limit: DEFAULT_INBOX_LIMIT }),
        notifications.counts({}),
      ]);
      this.setState({
        mentions: buildNotificationInboxMap({ account_id, rows }),
        unread_count: getUnreadNotificationCount(counts),
      });
    } catch (err) {
      console.warn("WARNING: notifications refresh error -- ", err);
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
    await this.refresh();
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
    await this.refresh();
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
