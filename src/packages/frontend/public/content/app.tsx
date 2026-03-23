/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";

import { joinUrlPath } from "@cocalc/util/url-path";
import { slugURL } from "@cocalc/util/news";
import {
  CHANNELS_DESCRIPTIONS,
  type Channel,
  type NewsItem,
  type NewsPrevNext,
} from "@cocalc/util/types/news";
import { COLORS, SITE_NAME } from "@cocalc/util/theme";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { contentPath, type PublicContentRoute, topLevelView } from "./routes";

const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));

interface ContentConfig {
  help_email?: string;
  imprint?: string;
  on_cocalc_com?: boolean;
  policies?: string;
  site_name?: string;
}

interface PublicContentAppProps {
  config?: ContentConfig;
  initialNews?: NewsItem[];
  initialRoute: PublicContentRoute;
}

interface EventsPayload {
  past?: NewsItem[];
  upcoming?: NewsItem[];
}

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

const TEAM_MEMBERS = [
  {
    description:
      "CEO and founder of SageMath, Inc., with a long track record in mathematics, open-source software, and cloud computing.",
    email: "wstein@sagemath.com",
    name: "William Stein",
    title: "CEO and Founder",
  },
  {
    description:
      "CTO at SageMath, Inc., focused on infrastructure, product direction, and pushing CoCalc into new technical territory.",
    email: "hsy@sagemath.com",
    name: "Harald Schilly",
    title: "CTO",
  },
  {
    description:
      "COO at SageMath, Inc., overseeing daily operations, educational deployments, and customer-facing logistics.",
    email: "andrey@cocalc.com",
    name: "Andrey Novoseltsev",
    title: "COO",
  },
  {
    description:
      "CSO at SageMath, Inc., combining applied mathematics, software development, and partnership work.",
    email: "blaec@cocalc.com",
    name: "Blaec Bejarano",
    title: "CSO",
  },
] as const;

const PAGE_STYLE: CSSProperties = {
  minHeight: "100%",
  background: COLORS.GRAY_LLL,
  color: COLORS.GRAY_D,
} as const;

const SHELL_STYLE: CSSProperties = {
  width: "min(1100px, 100%)",
  margin: "0 auto",
  padding: "32px 16px 56px",
} as const;

const HERO_STYLE: CSSProperties = {
  display: "grid",
  gap: "16px",
  borderRadius: "24px",
  background: "white",
  border: `1px solid ${COLORS.GRAY_LL}`,
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.08)",
  padding: "28px",
} as const;

const NAV_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  marginTop: "12px",
} as const;

const NAV_LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "40px",
  padding: "0 14px",
  borderRadius: "999px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  background: "white",
  color: COLORS.GRAY_D,
  textDecoration: "none",
  fontWeight: 600,
} as const;

const NAV_LINK_ACTIVE_STYLE: CSSProperties = {
  ...NAV_LINK_STYLE,
  background: COLORS.BLUE_D,
  borderColor: COLORS.BLUE_D,
  color: "white",
} as const;

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
  gap: "16px",
  marginTop: "24px",
} as const;

const CARD_STYLE: CSSProperties = {
  display: "grid",
  gap: "10px",
  borderRadius: "18px",
  background: "white",
  border: `1px solid ${COLORS.GRAY_LL}`,
  padding: "20px",
} as const;

const LINK_STYLE: CSSProperties = {
  color: COLORS.BLUE_D,
  textDecoration: "none",
  fontWeight: 600,
} as const;

const MUTED_STYLE: CSSProperties = {
  color: COLORS.GRAY_M,
} as const;

const TAG_STYLE: CSSProperties = {
  display: "inline-block",
  padding: "4px 8px",
  borderRadius: "999px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  color: COLORS.GRAY_D,
  fontSize: "12px",
  fontWeight: 600,
} as const;

const FILTER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "center",
  marginTop: "20px",
} as const;

const FILTER_BUTTON_STYLE: CSSProperties = {
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: "999px",
  background: "white",
  color: COLORS.GRAY_D,
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: 600,
  minHeight: "36px",
  padding: "0 12px",
} as const;

const FILTER_BUTTON_ACTIVE_STYLE: CSSProperties = {
  ...FILTER_BUTTON_STYLE,
  background: COLORS.BLUE_D,
  borderColor: COLORS.BLUE_D,
  color: "white",
} as const;

async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(path);
  return await resp.json();
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function contentNewsPath(news?: Pick<NewsItem, "id" | "title">): string {
  return appPath(slugURL(news));
}

function newsHistoryPath(permalink: string, timestamp: number): string {
  return `${permalink.replace(/\/$/, "")}/${timestamp}`;
}

function titleForRoute(route: PublicContentRoute, siteName: string): string {
  switch (route.view) {
    case "about-events":
      return `${siteName} events`;
    case "about-team":
      return `${siteName} team`;
    case "policies":
      return `${siteName} policies`;
    case "policies-imprint":
      return `${siteName} imprint`;
    case "policies-custom":
      return `${siteName} policies`;
    case "news":
      return `${siteName} news`;
    case "news-detail":
    case "news-history":
      return `${siteName} news`;
    case "about":
    default:
      return `About ${siteName}`;
  }
}

function stripMarkdown(text?: string): string {
  return `${text ?? ""}`
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatNewsDate(value?: number | Date): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function truncate(text: string, max = 260): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function MarkdownCard({ value }: { value: string }) {
  return (
    <div style={CARD_STYLE}>
      <Suspense fallback={<div>Loading content…</div>}>
        <Markdown value={value} />
      </Suspense>
    </div>
  );
}

function LoadingCard({ label }: { label: string }) {
  return <div style={{ ...CARD_STYLE, marginTop: "18px" }}>{label}</div>;
}

function EmptyCard({ label }: { label: string }) {
  return <div style={{ ...CARD_STYLE, marginTop: "18px" }}>{label}</div>;
}

function PageShell({
  children,
  route,
  subtitle,
  title,
}: {
  children: ReactNode;
  route: PublicContentRoute;
  subtitle: string;
  title: string;
}) {
  const currentTop = topLevelView(route);
  return (
    <div style={PAGE_STYLE}>
      <div style={SHELL_STYLE}>
        <div style={HERO_STYLE}>
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
            PUBLIC CONTENT
          </div>
          <h1 style={{ margin: 0, fontSize: "36px", lineHeight: 1.1 }}>
            {title}
          </h1>
          <div style={{ ...MUTED_STYLE, fontSize: "17px", maxWidth: "68ch" }}>
            {subtitle}
          </div>
          <div style={NAV_STYLE}>
            {[
              ["About", "about"],
              ["Policies", "policies"],
              ["News", "news"],
            ].map(([label, view]) => (
              <a
                key={view}
                href={contentPath(view)}
                style={
                  currentTop === view ? NAV_LINK_ACTIVE_STYLE : NAV_LINK_STYLE
                }
              >
                {label}
              </a>
            ))}
          </div>
        </div>
        <div style={{ marginTop: "24px" }}>{children}</div>
      </div>
    </div>
  );
}

function AboutHome({
  helpEmail,
  siteName,
}: {
  helpEmail?: string;
  siteName: string;
}) {
  return (
    <>
      <div style={{ ...MUTED_STYLE, fontSize: "17px", maxWidth: "70ch" }}>
        {siteName} is collaborative software for technical computing, teaching,
        and research. These public pages stay available in launchpad mode and
        outside the main app shell.
      </div>
      <div style={GRID_STYLE}>
        <div style={CARD_STYLE}>
          <h2 style={{ margin: 0, fontSize: "22px" }}>Events</h2>
          <div>See conference appearances and other public events.</div>
          <div>
            <a href={contentPath("about/events")} style={LINK_STYLE}>
              Open events
            </a>
          </div>
        </div>
        <div style={CARD_STYLE}>
          <h2 style={{ margin: 0, fontSize: "22px" }}>Team</h2>
          <div>Meet the people building and operating {siteName}.</div>
          <div>
            <a href={contentPath("about/team")} style={LINK_STYLE}>
              Meet the team
            </a>
          </div>
        </div>
        <div style={CARD_STYLE}>
          <h2 style={{ margin: 0, fontSize: "22px" }}>Support</h2>
          <div>Need help or want to contact us directly?</div>
          <div style={{ display: "grid", gap: "8px" }}>
            <a href={appPath("support")} style={LINK_STYLE}>
              Open support
            </a>
            {helpEmail ? (
              <a href={`mailto:${helpEmail}`} style={LINK_STYLE}>
                {helpEmail}
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function AboutTeamPage() {
  return (
    <div style={GRID_STYLE}>
      {TEAM_MEMBERS.map((member) => (
        <div key={member.email} style={CARD_STYLE}>
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
            {member.title}
          </div>
          <h2 style={{ margin: 0, fontSize: "24px" }}>{member.name}</h2>
          <div>{member.description}</div>
          <div>
            <a href={`mailto:${member.email}`} style={LINK_STYLE}>
              {member.email}
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

function EventList({ items }: { items: NewsItem[] }) {
  if (items.length === 0) {
    return <EmptyCard label="No events found." />;
  }
  return (
    <div style={GRID_STYLE}>
      {items.map((item) => (
        <div key={`${item.id ?? item.title}-${item.date}`} style={CARD_STYLE}>
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
            {formatNewsDate(item.date)}
          </div>
          <h2 style={{ margin: 0, fontSize: "22px" }}>{item.title}</h2>
          {item.tags?.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {item.tags.map((tag) => (
                <span key={tag} style={TAG_STYLE}>
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}
          <Suspense fallback={<div>Loading content…</div>}>
            <Markdown value={item.text} />
          </Suspense>
          {item.url ? (
            <div>
              <a href={item.url} style={LINK_STYLE}>
                Event website
              </a>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function AboutEventsPage() {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<EventsPayload>({});

  useEffect(() => {
    let canceled = false;
    void fetchJson<EventsPayload>(
      joinUrlPath(appBasePath, "api/v2/news/events"),
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
  }, []);

  if (loading) {
    return <LoadingCard label="Loading events…" />;
  }

  return (
    <div style={{ display: "grid", gap: "24px" }}>
      <div>
        <h2 style={{ marginBottom: "10px" }}>Upcoming events</h2>
        <EventList items={payload.upcoming ?? []} />
      </div>
      <div>
        <h2 style={{ marginBottom: "10px" }}>Past events</h2>
        <EventList items={payload.past ?? []} />
      </div>
    </div>
  );
}

function PoliciesHome({ config }: { config: ContentConfig }) {
  const items = config.on_cocalc_com
    ? [
        {
          description: "The terms governing use of CoCalc.",
          href: "/policies/terms",
          title: "Terms of service",
        },
        {
          description: "Compliance and operational security information.",
          href: "/policies/trust",
          title: "Trust",
        },
        {
          description: "How copyright complaints and notices are handled.",
          href: "/policies/copyright",
          title: "Copyright policy",
        },
        {
          description: "How user data is handled and protected.",
          href: "/policies/privacy",
          title: "Privacy",
        },
        {
          description: "The third-party services involved in operating CoCalc.",
          href: "/policies/thirdparties",
          title: "Third parties",
        },
        {
          description: "Our FERPA compliance statement for educational use.",
          href: "/policies/ferpa",
          title: "FERPA compliance",
        },
        {
          description: "Accessibility and VPAT information.",
          href: "/policies/accessibility",
          title: "Accessibility",
        },
      ]
    : [
        ...(config.imprint
          ? [
              {
                description: "Site-specific legal imprint information.",
                href: contentPath("policies/imprint"),
                title: "Imprint",
              },
            ]
          : []),
        ...(config.policies
          ? [
              {
                description:
                  "Site-specific policy information configured by admins.",
                href: contentPath("policies/policies"),
                title: "Policies",
              },
            ]
          : []),
      ];

  if (items.length === 0) {
    return (
      <div style={CARD_STYLE}>
        <h2 style={{ margin: 0, fontSize: "22px" }}>
          No public policies configured
        </h2>
        <div>This deployment has not exposed any public policy pages yet.</div>
      </div>
    );
  }

  return (
    <div style={GRID_STYLE}>
      {items.map((item) => (
        <div key={item.href} style={CARD_STYLE}>
          <h2 style={{ margin: 0, fontSize: "22px" }}>{item.title}</h2>
          <div>{item.description}</div>
          <div>
            <a href={item.href} style={LINK_STYLE}>
              Open page
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

function PoliciesDetailPage({
  markdown,
  title,
}: {
  markdown?: string;
  title: string;
}) {
  if (!markdown) {
    return (
      <EmptyCard label={`No ${title.toLowerCase()} content configured.`} />
    );
  }
  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <div>
        <a href={contentPath("policies")} style={LINK_STYLE}>
          Back to policies
        </a>
      </div>
      <MarkdownCard value={markdown} />
    </div>
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  const body = truncate(stripMarkdown(item.text));
  return (
    <div style={CARD_STYLE}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        <span style={TAG_STYLE}>{item.channel}</span>
        <span style={MUTED_STYLE}>{formatNewsDate(item.date)}</span>
      </div>
      <h2 style={{ margin: 0, fontSize: "22px" }}>{item.title}</h2>
      <div>{body}</div>
      {item.tags?.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {item.tags.map((tag) => (
            <span key={tag} style={TAG_STYLE}>
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <a href={contentNewsPath(item)} style={LINK_STYLE}>
          Open post
        </a>
        {item.url ? (
          <a href={item.url} style={LINK_STYLE}>
            External link
          </a>
        ) : null}
      </div>
    </div>
  );
}

function NewsListPage({ initialNews }: { initialNews?: NewsItem[] }) {
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [items, setItems] = useState<NewsItem[]>(initialNews ?? []);
  const [loading, setLoading] = useState(initialNews == null);

  useEffect(() => {
    if (initialNews != null) return;
    let canceled = false;
    void fetchJson<NewsItem[]>(joinUrlPath(appBasePath, "api/v2/news/list"))
      .then((payload) => {
        if (!canceled) setItems(Array.isArray(payload) ? payload : []);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [initialNews]);

  const visible = useMemo(
    () => items.filter((item) => channel === "all" || item.channel === channel),
    [channel, items],
  );

  return (
    <>
      <div style={{ ...MUTED_STYLE, fontSize: "17px", maxWidth: "70ch" }}>
        Recent announcements and feature updates. Subscribe via{" "}
        <a href={contentPath("news/rss.xml")} style={LINK_STYLE}>
          RSS
        </a>{" "}
        or{" "}
        <a href={contentPath("news/feed.json")} style={LINK_STYLE}>
          JSON Feed
        </a>
        .
      </div>
      <div style={FILTER_ROW_STYLE}>
        <button
          style={
            channel === "all" ? FILTER_BUTTON_ACTIVE_STYLE : FILTER_BUTTON_STYLE
          }
          type="button"
          onClick={() => setChannel("all")}
        >
          All
        </button>
        {(Object.keys(CHANNELS_DESCRIPTIONS) as Channel[]).map((name) => (
          <button
            key={name}
            style={
              channel === name
                ? FILTER_BUTTON_ACTIVE_STYLE
                : FILTER_BUTTON_STYLE
            }
            type="button"
            onClick={() => setChannel(name)}
            title={CHANNELS_DESCRIPTIONS[name]}
          >
            {name}
          </button>
        ))}
      </div>
      {loading ? (
        <LoadingCard label="Loading news…" />
      ) : visible.length === 0 ? (
        <EmptyCard label="No news items match the selected filter." />
      ) : (
        <div style={GRID_STYLE}>
          {visible.map((item) => (
            <NewsCard
              key={`${item.id ?? item.title}-${item.date}`}
              item={item}
            />
          ))}
        </div>
      )}
    </>
  );
}

function NewsDetailPage({ route }: { route: PublicContentRoute }) {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<NewsDetailPayload>({});

  useEffect(() => {
    let canceled = false;
    const params = new URLSearchParams({ id: `${route.newsId}` });
    if (route.timestamp != null) {
      params.set("timestamp", `${route.timestamp}`);
    }
    void fetchJson<NewsDetailPayload>(
      `${joinUrlPath(appBasePath, "api/v2/news/get")}?${params.toString()}`,
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
  }, [route.newsId, route.timestamp]);

  if (loading) return <LoadingCard label="Loading news item…" />;
  if (!payload.news) return <EmptyCard label="This news item was not found." />;

  const { news } = payload;
  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <a href={contentPath("news")} style={LINK_STYLE}>
          Back to news
        </a>
        {payload.history && payload.permalink ? (
          <a href={appPath(payload.permalink)} style={LINK_STYLE}>
            Current version
          </a>
        ) : null}
        {news.url ? (
          <a href={news.url} style={LINK_STYLE}>
            External link
          </a>
        ) : null}
      </div>
      {payload.history ? (
        <div style={CARD_STYLE}>
          Historic snapshot from {formatNewsDate(payload.timestamp)}
        </div>
      ) : null}
      <div style={CARD_STYLE}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          <span style={TAG_STYLE}>{news.channel}</span>
          <span style={MUTED_STYLE}>{formatNewsDate(news.date)}</span>
        </div>
        <h2 style={{ margin: 0, fontSize: "28px" }}>{news.title}</h2>
        {news.tags?.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {news.tags.map((tag) => (
              <span key={tag} style={TAG_STYLE}>
                #{tag}
              </span>
            ))}
          </div>
        ) : null}
        <Suspense fallback={<div>Loading content…</div>}>
          <Markdown value={news.text} />
        </Suspense>
      </div>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        {!payload.history && payload.prev ? (
          <a href={contentNewsPath(payload.prev)} style={LINK_STYLE}>
            Older
          </a>
        ) : null}
        {!payload.history && payload.next ? (
          <a href={contentNewsPath(payload.next)} style={LINK_STYLE}>
            Newer
          </a>
        ) : null}
        {payload.history && payload.prevTimestamp != null ? (
          <a
            href={newsHistoryPath(
              appPath(payload.permalink ?? `news/${route.newsId}`),
              payload.prevTimestamp,
            )}
            style={LINK_STYLE}
          >
            Older revision
          </a>
        ) : null}
        {payload.history && payload.nextTimestamp != null ? (
          <a
            href={newsHistoryPath(
              appPath(payload.permalink ?? `news/${route.newsId}`),
              payload.nextTimestamp,
            )}
            style={LINK_STYLE}
          >
            Newer revision
          </a>
        ) : null}
      </div>
    </div>
  );
}

export default function PublicContentApp({
  config,
  initialNews,
  initialRoute,
}: PublicContentAppProps) {
  const siteName = config?.site_name ?? SITE_NAME;
  const title = titleForRoute(initialRoute, siteName);

  useEffect(() => {
    document.title = title;
  }, [title]);

  if (initialRoute.view === "about-events") {
    return (
      <PageShell
        route={initialRoute}
        subtitle={`Where to find ${siteName} in person.`}
        title={title}
      >
        <AboutEventsPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "about-team") {
    return (
      <PageShell
        route={initialRoute}
        subtitle={`Meet the people behind ${siteName}.`}
        title={title}
      >
        <AboutTeamPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies-imprint") {
    return (
      <PageShell
        route={initialRoute}
        subtitle="Deployment-specific imprint information."
        title={title}
      >
        <PoliciesDetailPage markdown={config?.imprint} title="Imprint" />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies-custom") {
    return (
      <PageShell
        route={initialRoute}
        subtitle="Deployment-specific policy information configured by admins."
        title={title}
      >
        <PoliciesDetailPage markdown={config?.policies} title="Policies" />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies") {
    return (
      <PageShell
        route={initialRoute}
        subtitle="Public legal and compliance information for this deployment."
        title={title}
      >
        <PoliciesHome config={config ?? {}} />
      </PageShell>
    );
  }

  if (
    initialRoute.view === "news-detail" ||
    initialRoute.view === "news-history"
  ) {
    return (
      <PageShell
        route={initialRoute}
        subtitle={`News and release notes for ${siteName}.`}
        title={title}
      >
        <NewsDetailPage route={initialRoute} />
      </PageShell>
    );
  }

  if (initialRoute.view === "news") {
    return (
      <PageShell
        route={initialRoute}
        subtitle={`News and release notes for ${siteName}.`}
        title={title}
      >
        <NewsListPage initialNews={initialNews} />
      </PageShell>
    );
  }

  return (
    <PageShell
      route={initialRoute}
      subtitle={`Background information and public resources for ${siteName}.`}
      title={title}
    >
      <AboutHome helpEmail={config?.help_email} siteName={siteName} />
    </PageShell>
  );
}
