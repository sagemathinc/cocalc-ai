/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";

import {
  Actions,
  createTypedMap,
  Store,
  TypedMap,
  redux,
} from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { NewsItemWebapp } from "@cocalc/util/types/news";

export const NEWS = "news";
const NewsItemMap = createTypedMap<NewsItemWebapp>();

export interface NewsState {
  loading: boolean;
  unread: number;
  news: Map<string, TypedMap<NewsItemWebapp>>;
}

function toReadIds(value: unknown): Set<string> {
  const rawValue =
    typeof (value as any)?.toJS === "function" ? (value as any).toJS() : value;
  const raw = Array.isArray(rawValue) ? rawValue : [];
  return new Set(
    raw.filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    ),
  );
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

export class NewsActions extends Actions<NewsState> {
  public getStore(): NewsStore {
    return store;
  }

  private setNewsReadState(readUntil: number, readIds: string[]): void {
    const account_actions = redux.getActions("account");
    const currentOtherSettings = redux
      .getStore("account")
      ?.get("other_settings");
    const nextOtherSettings =
      typeof (currentOtherSettings as any)?.set === "function"
        ? (currentOtherSettings as any)
            .set("news_read_until", readUntil)
            .set("news_read_ids", readIds)
        : {
            ...(currentOtherSettings?.toJS?.() ?? currentOtherSettings ?? {}),
            news_read_until: readUntil,
            news_read_ids: readIds,
          };
    account_actions.setState({ other_settings: nextOtherSettings });
    const nextOtherSettingsPlain =
      typeof (nextOtherSettings as any)?.toJS === "function"
        ? (nextOtherSettings as any).toJS()
        : nextOtherSettings;
    void redux
      .getTable("account")
      .set({ other_settings: nextOtherSettingsPlain }, "shallow");
    this.updateUnreadCount(readUntil, readIds);
  }

  public refresh = async (): Promise<void> => {
    if (!webapp_client.is_signed_in()) {
      this.setState({ loading: false });
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
          }),
        ]),
      );
      this.setState({ loading: false, news });
      const otherSettings = redux.getStore("account")?.get("other_settings");
      const readUntil = otherSettings?.get("news_read_until");
      const readIds = otherSettings?.get("news_read_ids");
      this.updateUnreadCount(readUntil, readIds);
    } catch (err) {
      console.warn("WARNING: news refresh error -- ", err);
      this.setState({ loading: false });
    }
  };

  public markNewsRead(opts?: {
    item?: Pick<NewsItemWebapp, "id" | "date">;
    date?: Date;
    current?: number;
  }): void {
    if (opts?.item != null) {
      const readIds = toReadIds(
        redux.getStore("account")?.getIn(["other_settings", "news_read_ids"]),
      );
      readIds.add(opts.item.id);
      const readUntil =
        redux
          .getStore("account")
          ?.getIn(["other_settings", "news_read_until"]) ?? 0;
      this.setNewsReadState(readUntil, Array.from(readIds));
      return;
    }
    const newest: number =
      opts?.date?.getTime() ?? this.getStore().getNewestTimestamp();
    const current = opts?.current ?? 0;
    const until = Math.max(current, newest);
    this.setNewsReadState(until, []);
  }

  public markNewsUnread(): void {
    this.setNewsReadState(0, []);
  }

  public updateUnreadCount(readUntil: number, readIdsValue?: unknown): void {
    let unread = 0;
    const now = webapp_client.server_time();
    const account_created = redux.getStore("account")?.get("created");
    const readIds = toReadIds(readIdsValue);
    this.getStore()
      .getNews()
      .map((m, id) => {
        if (m.get("hide", false)) return;
        const date = m.get("date");
        if (
          date != null &&
          date < now &&
          date.getTime() > (readUntil ?? 0) &&
          !readIds.has(id)
        ) {
          // further filter news, which are older then when the user's account has been created
          // if they open the news panel, they'll still see them, though – but initially there is no notification
          if (account_created && date < account_created) return;
          unread++;
        }
      });
    actions.setState({ unread });
  }
}

const actions = redux.createActions(NEWS, NewsActions);
void actions.refresh();
webapp_client.on("connected", () => void actions.refresh());
webapp_client.on("signed_in", () => void actions.refresh());
