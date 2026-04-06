/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";
import type { DStream } from "@cocalc/conat/sync/dstream";
import {
  newsFeedStreamName,
  type NewsFeedEvent,
} from "@cocalc/conat/hub/api/news-feed";

import {
  Actions,
  createTypedMap,
  Store,
  TypedMap,
  redux,
} from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  get_local_storage,
  set_local_storage,
} from "@cocalc/frontend/misc/local-storage";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { NewsItemWebapp, SYSTEM_CHANNEL } from "@cocalc/util/types/news";

export const NEWS = "news";
const NewsItemMap = createTypedMap<NewsItemWebapp>();
const SYSTEM_NEWS_SEEN_STORAGE_KEY = "system_news_seen";

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

function getSeenSystemNews(): Record<string, number> {
  const raw = get_local_storage(SYSTEM_NEWS_SEEN_STORAGE_KEY);
  if (raw == null) {
    return {};
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, number>;
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? (raw as Record<string, number>) : {};
}

function setSeenSystemNews(seen: Record<string, number>): void {
  set_local_storage(SYSTEM_NEWS_SEEN_STORAGE_KEY, JSON.stringify(seen));
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
      this.setState({ loading: false, unread: 0, news: Map() });
      return;
    }
    this.setState({ loading: true });
    try {
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
    const seen = getSeenSystemNews();
    const now = webapp_client.server_time();
    const liveIds = new Set<string>();
    let changed = false;

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
      if (seen[id] != null) return;

      seen[id] = date.getTime();
      changed = true;
      alert_message({
        type: "warning",
        title: item.get("title") || "System notice",
        message: item.get("text") || item.get("title") || "System notice",
        block: true,
      });
    });

    for (const id in seen) {
      if (!liveIds.has(id)) {
        delete seen[id];
        changed = true;
      }
    }

    if (changed) {
      setSeenSystemNews(seen);
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
