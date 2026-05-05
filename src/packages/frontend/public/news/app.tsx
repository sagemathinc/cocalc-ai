/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, lazy, useEffect, useMemo, useState } from "react";

import { Flex, Segmented, Tag, Typography } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  CHANNELS_DESCRIPTIONS,
  PUBLIC_NEWS_CHANNELS,
  type Channel,
  type NewsItem,
  type NewsPrevNext,
} from "@cocalc/util/types/news";
import {
  appPath,
  EmptyCard,
  fetchJson,
  getSiteName,
  LinkButton,
  LoadingCard,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { publicPath } from "../routes";
import type { PublicNewsRoute } from "./routes";
import { contentNewsPath, formatNewsDate, newsHistoryPath } from "./utils";
import { PublicCard, PublicGrid } from "../layout/shell";

const StaticMarkdown = lazy(
  () => import("@cocalc/frontend/editors/slate/static-markdown-public"),
);
const { Paragraph, Text, Title } = Typography;

interface NewsDetailPayload {
  history?: boolean;
  news?: NewsItem & {
    expired?: boolean;
    future?: boolean;
    hide?: boolean;
    history?: Record<number, Omit<NewsItem, "id" | "hide">>;
  };
  next?: NewsPrevNext | null;
  nextTimestamp?: number | null;
  permalink?: string;
  prev?: NewsPrevNext | null;
  prevTimestamp?: number | null;
  timestamp?: number;
}

type PublicNewsDetailRoute = Exclude<PublicNewsRoute, { view: "news" }>;

function NewsMarkdown({
  preview,
  value,
}: {
  preview?: boolean;
  value: string;
}) {
  return (
    <Suspense fallback={<div>Loading content…</div>}>
      <StaticMarkdown
        style={{
          fontSize: preview ? "0.98rem" : undefined,
          overflowX: "auto",
        }}
        value={value}
      />
    </Suspense>
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  return (
    <PublicCard>
      <Flex gap={8} wrap>
        <Tag color="blue">{item.channel}</Tag>
        <Text type="secondary">{formatNewsDate(item.date)}</Text>
      </Flex>
      <Title level={3} style={{ margin: 0 }}>
        {item.title}
      </Title>
      <NewsMarkdown preview value={item.text} />
      {item.tags?.length ? (
        <Flex gap={8} wrap>
          {item.tags.map((tag) => (
            <Tag key={tag}>#{tag}</Tag>
          ))}
        </Flex>
      ) : null}
      <Flex gap={12} wrap>
        <LinkButton href={contentNewsPath(item)}>Open post</LinkButton>
        {item.url ? (
          <LinkButton href={item.url}>External link</LinkButton>
        ) : null}
      </Flex>
    </PublicCard>
  );
}

function NewsListPage({ isAdmin }: { isAdmin?: boolean }) {
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [items, setItems] = useState<NewsItem[]>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    void fetchJson<NewsItem[]>(`${appBasePath}/api/v2/news/list`)
      .then((payload) => {
        if (!canceled) setItems(Array.isArray(payload) ? payload : []);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const visible = useMemo(
    () =>
      (items ?? []).filter(
        (item) => channel === "all" || item.channel === channel,
      ),
    [channel, items],
  );

  return (
    <>
      <Paragraph style={{ margin: 0, maxWidth: "70ch" }}>
        Recent announcements and feature updates. Subscribe via{" "}
        <LinkButton href={publicPath("news/rss.xml")}>RSS</LinkButton> or{" "}
        <LinkButton href={publicPath("news/feed.json")}>JSON Feed</LinkButton>.
      </Paragraph>
      {isAdmin ? (
        <PublicCard>
          <Flex gap={12} wrap>
            <LinkButton href={appPath("admin/news")}>Manage news</LinkButton>
            <LinkButton href={appPath("admin/news/new")}>
              Create post
            </LinkButton>
            <LinkButton href={appPath("admin/news/new?channel=event")}>
              Create event
            </LinkButton>
          </Flex>
        </PublicCard>
      ) : null}
      <Segmented
        block
        onChange={(value) => setChannel(value as Channel | "all")}
        options={[
          { label: "All", title: "All channels", value: "all" },
          ...PUBLIC_NEWS_CHANNELS.map((name) => ({
            label: name,
            title: CHANNELS_DESCRIPTIONS[name],
            value: name,
          })),
        ]}
        value={channel}
      />
      {!loading && visible.length === 0 ? (
        <EmptyCard label="No news items match the selected filter." />
      ) : (
        <PublicGrid columns={3}>
          {visible.map((item) => (
            <NewsCard
              item={item}
              key={`${item.id ?? item.title}-${item.date}`}
            />
          ))}
        </PublicGrid>
      )}
    </>
  );
}

function NewsDetailPage({ route }: { route: PublicNewsDetailRoute }) {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<NewsDetailPayload>({});
  const routeTimestamp =
    route.view === "news-history" ? route.timestamp : undefined;

  useEffect(() => {
    let canceled = false;
    const params = new URLSearchParams({ id: `${route.newsId}` });
    if (routeTimestamp != null) {
      params.set("timestamp", `${routeTimestamp}`);
    }
    void fetchJson<NewsDetailPayload>(
      `${appBasePath}/api/v2/news/get?${params.toString()}`,
    )
      .then((value) => {
        if (!canceled) setPayload(value ?? {});
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [route.newsId, routeTimestamp]);

  if (loading) return <LoadingCard label="Loading news item…" />;
  if (!payload.news) return <EmptyCard label="This news item was not found." />;

  const { news } = payload;
  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <Flex gap={12} wrap>
        <LinkButton href={publicPath("news")}>Back to news</LinkButton>
        {payload.history && payload.permalink ? (
          <LinkButton href={appPath(payload.permalink)}>
            Current version
          </LinkButton>
        ) : null}
        {news.url ? (
          <LinkButton href={news.url}>External link</LinkButton>
        ) : null}
      </Flex>
      {payload.history ? (
        <PublicCard>
          Historic snapshot from {formatNewsDate(payload.timestamp)}
        </PublicCard>
      ) : null}
      <PublicCard>
        <Flex gap={8} wrap>
          <Tag color="blue">{news.channel}</Tag>
          <Text type="secondary">{formatNewsDate(news.date)}</Text>
        </Flex>
        <Title level={2} style={{ margin: 0 }}>
          {news.title}
        </Title>
        {news.tags?.length ? (
          <Flex gap={8} wrap>
            {news.tags.map((tag) => (
              <Tag key={tag}>#{tag}</Tag>
            ))}
          </Flex>
        ) : null}
        <NewsMarkdown value={news.text} />
      </PublicCard>
      <Flex gap={12} wrap>
        {!payload.history && payload.prev ? (
          <LinkButton href={contentNewsPath(payload.prev)}>Older</LinkButton>
        ) : null}
        {!payload.history && payload.next ? (
          <LinkButton href={contentNewsPath(payload.next)}>Newer</LinkButton>
        ) : null}
        {payload.history && payload.prevTimestamp != null ? (
          <LinkButton
            href={newsHistoryPath(
              appPath(payload.permalink ?? `news/${route.newsId}`),
              payload.prevTimestamp,
            )}
          >
            Older revision
          </LinkButton>
        ) : null}
        {payload.history && payload.nextTimestamp != null ? (
          <LinkButton
            href={newsHistoryPath(
              appPath(payload.permalink ?? `news/${route.newsId}`),
              payload.nextTimestamp,
            )}
          >
            Newer revision
          </LinkButton>
        ) : null}
      </Flex>
    </div>
  );
}

export default function PublicNewsApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicNewsRoute;
}) {
  const siteName = getSiteName(config);
  const title = `${siteName} News`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell active="news" config={config} title={title}>
      {initialRoute.view === "news-detail" ||
      initialRoute.view === "news-history" ? (
        <NewsDetailPage route={initialRoute} />
      ) : (
        <NewsListPage isAdmin={!!config?.is_admin} />
      )}
    </PublicSectionShell>
  );
}
