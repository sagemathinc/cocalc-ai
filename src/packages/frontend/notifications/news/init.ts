/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";
import { notification } from "antd";
import type { DStream } from "@cocalc/conat/sync/dstream";
import type { DKV } from "@cocalc/conat/sync/dkv";
import {
  newsFeedStreamName,
  type NewsFeedEvent,
} from "@cocalc/conat/hub/api/news-feed";
import { createElement } from "react";

import {
  Actions,
  createTypedMap,
  Store,
  TypedMap,
  redux,
} from "@cocalc/frontend/app-framework";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { NewsItemWebapp, SYSTEM_CHANNEL } from "@cocalc/util/types/news";

export const NEWS = "news";
const NewsItemMap = createTypedMap<NewsItemWebapp>();
const SEEN_STATE_DKV_NAME = "seen-state";
const SYSTEM_NEWS_SEEN_PREFIX = "system-news.";

export interface NewsState {
  loading: boolean;
  unread: number;
  news: Map<string, TypedMap<NewsItemWebapp>>;
}

export class NewsStore extends Store<NewsState> {
  // returns the newest timestamp of all news items as an epoch timestamp in milliseconds
  public getNewestTimestamp(): number {
    const news = this.get("news");
    if (news == null) {
      return 0;
    }
    let newest = 0;
    news.map((m) => {
      const date = m.get("date")?.getTime();
      if (date && date > newest) {
        newest = date;
      }
    });
    return newest;
  }

  public getNews(): NewsState["news"] {
    return this.get("news");
  }
}

const store: NewsStore = redux.createStore(NEWS, NewsStore, {
  loading: true,
  unread: 0,
  news: Map<string, TypedMap<NewsItemWebapp>>(),
});

let systemNewsSeenState: DKV<number> | undefined;
let systemNewsSeenStateInit: Promise<void> | undefined;
let systemNewsSeenStateListener:
  | ((changeEvent: { key: string; value?: number }) => void)
  | undefined;
const seenSystemNewsIds = new globalThis.Map<string, number>();
const openSystemNewsAlertIds = new Set<string>();

function systemNewsSeenKey(id: string): string {
  return `${SYSTEM_NEWS_SEEN_PREFIX}${id}`;
}

function getSystemNewsIdFromSeenKey(key: string): string | undefined {
  if (!key.startsWith(SYSTEM_NEWS_SEEN_PREFIX)) {
    return;
  }
  return key.slice(SYSTEM_NEWS_SEEN_PREFIX.length);
}

function closeSystemNewsSeenState(): void {
  for (const id of openSystemNewsAlertIds) {
    notification.destroy(`system-news:${id}`);
  }
  openSystemNewsAlertIds.clear();
  seenSystemNewsIds.clear();
  if (systemNewsSeenState != null && systemNewsSeenStateListener != null) {
    systemNewsSeenState.off("change", systemNewsSeenStateListener);
  }
  systemNewsSeenStateListener = undefined;
  systemNewsSeenState?.close();
  systemNewsSeenState = undefined;
  systemNewsSeenStateInit = undefined;
}

async function ensureSystemNewsSeenState(): Promise<void> {
  if (!webapp_client.is_signed_in()) {
    closeSystemNewsSeenState();
    return;
  }
  if (systemNewsSeenState != null && !systemNewsSeenState.isClosed()) {
    return;
  }
  if (systemNewsSeenStateInit != null) {
    await systemNewsSeenStateInit;
    return;
  }
  systemNewsSeenStateInit = (async () => {
    const accountStore = redux.getStore("account");
    await accountStore.async_wait({
      until: () => accountStore.get_account_id() != null,
      timeout: 0,
    });
    const account_id = accountStore.get_account_id();
    const dkv = await webapp_client.conat_client.dkv<number>({
      account_id,
      name: SEEN_STATE_DKV_NAME,
      merge: ({ local, remote }) => local ?? remote,
    });
    if (systemNewsSeenState != null && systemNewsSeenState !== dkv) {
      systemNewsSeenState.close();
    }
    systemNewsSeenState = dkv;
    seenSystemNewsIds.clear();
    for (const [key, value] of Object.entries(dkv.getAll())) {
      const id = getSystemNewsIdFromSeenKey(key);
      if (id == null || typeof value !== "number") {
        continue;
      }
      seenSystemNewsIds.set(id, value);
    }
    systemNewsSeenStateListener = (changeEvent) => {
      const id = getSystemNewsIdFromSeenKey(changeEvent.key);
      if (id == null) {
        return;
      }
      if (typeof changeEvent.value === "number") {
        seenSystemNewsIds.set(id, changeEvent.value);
        notification.destroy(`system-news:${id}`);
        openSystemNewsAlertIds.delete(id);
      } else {
        seenSystemNewsIds.delete(id);
      }
    };
    dkv.on("change", systemNewsSeenStateListener);
  })();
  try {
    await systemNewsSeenStateInit;
  } finally {
    systemNewsSeenStateInit = undefined;
  }
}

function markSystemNewsSeen(id: string, seenAt: number): void {
  seenSystemNewsIds.set(id, seenAt);
  openSystemNewsAlertIds.delete(id);
  void ensureSystemNewsSeenState()
    .then(() => systemNewsSeenState?.set(systemNewsSeenKey(id), seenAt))
    .catch((err) => {
      console.warn("system news seen-state update error", err);
    });
}

export class NewsActions extends Actions<NewsState> {
  public getStore(): NewsStore {
    return store;
  }

  private setNewsReadState(readUntil: number): void {
    const account_actions = redux.getActions("account");
    const currentOtherSettings = redux
      .getStore("account")
      ?.get("other_settings");
    const nextOtherSettings =
      typeof (currentOtherSettings as any)?.set === "function"
        ? (currentOtherSettings as any)
            .set("news_read_until", readUntil)
            .set("news_read_ids", [])
        : {
            ...(currentOtherSettings?.toJS?.() ?? currentOtherSettings ?? {}),
            news_read_until: readUntil,
            news_read_ids: [],
          };
    account_actions.setState({ other_settings: nextOtherSettings });
    const nextOtherSettingsPlain =
      typeof (nextOtherSettings as any)?.toJS === "function"
        ? (nextOtherSettings as any).toJS()
        : nextOtherSettings;
    void redux
      .getTable("account")
      .set({ other_settings: nextOtherSettingsPlain }, "shallow");
    this.updateUnreadCount(readUntil);
  }

  public refresh = async (): Promise<void> => {
    if (!webapp_client.is_signed_in()) {
      closeSystemNewsSeenState();
      this.setState({ loading: false, unread: 0, news: Map() });
      return;
    }
    this.setState({ loading: true });
    try {
      await ensureSystemNewsSeenState();
      const rows = await webapp_client.conat_client.hub.system.listNews();
      const news = Map<string, TypedMap<NewsItemWebapp>>(
        rows.map((row) => [
          row.id,
          new NewsItemMap({
            ...row,
            date: row.date instanceof Date ? row.date : new Date(row.date),
            until:
              row.until == null
                ? undefined
                : row.until instanceof Date
                  ? row.until
                  : new Date(row.until),
          }),
        ]),
      );
      this.setState({ loading: false, news });
      const otherSettings = redux.getStore("account")?.get("other_settings");
      const readUntil = otherSettings?.get("news_read_until");
      this.updateUnreadCount(readUntil);
      this.showSystemNewsAlerts(news);
    } catch (err) {
      console.warn("WARNING: news refresh error -- ", err);
      this.setState({ loading: false });
    }
  };

  public markNewsRead(opts?: { date?: Date; current?: number }): void {
    const newest: number =
      opts?.date?.getTime() ?? this.getStore().getNewestTimestamp();
    const current = opts?.current ?? 0;
    const until = Math.max(current, newest);
    this.setNewsReadState(until);
  }

  public markNewsUnread(): void {
    this.setNewsReadState(0);
  }

  public updateUnreadCount(readUntil: number): void {
    let unread = 0;
    const now = webapp_client.server_time();
    const account_created = redux.getStore("account")?.get("created");
    this.getStore()
      .getNews()
      .map((m) => {
        if (m.get("hide", false)) return;
        const date = m.get("date");
        if (date != null && date < now && date.getTime() > (readUntil ?? 0)) {
          // further filter news, which are older then when the user's account has been created
          // if they open the news panel, they'll still see them, though – but initially there is no notification
          if (account_created && date < account_created) return;
          unread++;
        }
      });
    actions.setState({ unread });
  }

  private showSystemNewsAlerts(
    news: Map<string, TypedMap<NewsItemWebapp>>,
  ): void {
    const now = webapp_client.server_time();
    const liveIds = new Set<string>();

    news.forEach((item) => {
      if (item.get("channel") !== SYSTEM_CHANNEL) return;
      if (item.get("hide")) return;
      const date = item.get("date");
      if (date == null || date > now) return;
      const until = item.get("until");
      if (until != null && until <= now) return;

      const id = item.get("id");
      if (!id) return;
      liveIds.add(id);
      if (seenSystemNewsIds.has(id) || openSystemNewsAlertIds.has(id)) return;

      openSystemNewsAlertIds.add(id);
      notification.warning({
        key: `system-news:${id}`,
        message: item.get("title") || "System notice",
        description: createElement(StaticMarkdown, {
          value: item.get("text") || item.get("title") || "System notice",
        }),
        duration: 0,
        onClose: () => {
          markSystemNewsSeen(id, now.getTime());
        },
      });
    });

    for (const id of Array.from(openSystemNewsAlertIds)) {
      if (!liveIds.has(id)) {
        notification.destroy(`system-news:${id}`);
        openSystemNewsAlertIds.delete(id);
      }
    }

    for (const id of Array.from(seenSystemNewsIds.keys())) {
      if (liveIds.has(id)) {
        continue;
      }
      seenSystemNewsIds.delete(id);
      systemNewsSeenState?.delete(systemNewsSeenKey(id));
    }
  }
}

const actions = redux.createActions(NEWS, NewsActions);

let realtimeFeed: DStream<NewsFeedEvent> | undefined;
let signedInListener: (() => void) | undefined;
let signedOutListener: (() => void) | undefined;
let conatConnectedListener: (() => void) | undefined;

function closeRealtimeFeed(): void {
  if (realtimeFeed == null) return;
  realtimeFeed.removeListener("change", handleRealtimeFeedChange);
  realtimeFeed.removeListener("history-gap", handleRealtimeFeedHistoryGap);
  realtimeFeed.close();
  realtimeFeed = undefined;
}

async function ensureRealtimeFeed(): Promise<void> {
  if (!webapp_client.is_signed_in()) {
    closeRealtimeFeed();
    return;
  }
  if (realtimeFeed != null && !realtimeFeed.isClosed()) {
    return;
  }
  closeRealtimeFeed();
  try {
    const feed = await webapp_client.conat_client.dstream<NewsFeedEvent>({
      name: newsFeedStreamName(),
      ephemeral: true,
    });
    feed.on("change", handleRealtimeFeedChange);
    feed.on("history-gap", handleRealtimeFeedHistoryGap);
    realtimeFeed = feed;
  } catch (err) {
    console.warn("news realtime feed error", err);
  }
}

function handleRealtimeFeedChange(event?: NewsFeedEvent): void {
  if (event?.type !== "news.refresh") {
    return;
  }
  void actions.refresh();
}

function handleRealtimeFeedHistoryGap(): void {
  closeRealtimeFeed();
  void actions.refresh().then(() => ensureRealtimeFeed());
}

function initRealtime(): void {
  if (signedInListener != null) {
    return;
  }
  signedInListener = () => {
    void actions.refresh();
    void ensureRealtimeFeed();
  };
  signedOutListener = () => {
    closeRealtimeFeed();
    closeSystemNewsSeenState();
    actions.setState({ loading: false, unread: 0, news: Map() });
  };
  conatConnectedListener = () => {
    void actions.refresh();
    void ensureRealtimeFeed();
  };
  webapp_client.on("signed_in", signedInListener);
  webapp_client.on("signed_out", signedOutListener);
  webapp_client.on("connected", conatConnectedListener);
  if (webapp_client.is_signed_in()) {
    void actions.refresh();
    void ensureRealtimeFeed();
  } else {
    actions.setState({ loading: false });
  }
}

initRealtime();
