/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";

import {
  App as AntdApp,
  Button,
  Empty,
  Flex,
  Segmented,
  Spin,
  Tag,
  Typography,
} from "antd";
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
import {
  PublicHero,
  PublicPageRoot,
  PublicSectionCard,
} from "@cocalc/frontend/public/ui/shell";
import { contentPath, type PublicContentRoute, topLevelView } from "./routes";

const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));
const { Paragraph, Text, Title } = Typography;

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

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
  gap: "16px",
  marginTop: "24px",
} as const;

const MUTED_STYLE: CSSProperties = {
  color: COLORS.GRAY_M,
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
    case "software-cocalc-plus":
      return "CoCalc Plus";
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
    <PublicSectionCard>
      <Suspense fallback={<div>Loading content…</div>}>
        <Markdown value={value} />
      </Suspense>
    </PublicSectionCard>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <PublicSectionCard>
      <Flex align="center" gap={12}>
        <Spin size="small" />
        <Text>{label}</Text>
      </Flex>
    </PublicSectionCard>
  );
}

function EmptyCard({ label }: { label: string }) {
  return (
    <PublicSectionCard>
      <Empty description={label} image={Empty.PRESENTED_IMAGE_SIMPLE} />
    </PublicSectionCard>
  );
}

function LinkButton({ children, href }: { children: ReactNode; href: string }) {
  return (
    <Button type="link" href={href} style={{ paddingInline: 0 }}>
      {children}
    </Button>
  );
}

function CodeCommand({ value }: { value: string }) {
  return (
    <div
      style={{
        background: "#f8fafc",
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 12,
        padding: 16,
      }}
    >
      <code style={{ fontSize: "0.95rem", wordBreak: "break-all" }}>
        {value}
      </code>
    </div>
  );
}

function CopyCommandButton({ value }: { value: string }) {
  const { message } = AntdApp.useApp();

  return (
    <Button
      onClick={() => {
        if (typeof navigator === "undefined" || navigator.clipboard == null) {
          void message.info("Copy the command manually from the box below.");
          return;
        }
        void navigator.clipboard.writeText(value).then(
          () => void message.success("Install command copied."),
          () => void message.error("Unable to copy command."),
        );
      }}
    >
      Copy command
    </Button>
  );
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
    <PublicPageRoot>
      <PublicHero
        eyebrow="PUBLIC CONTENT"
        title={title}
        subtitle={subtitle}
        actions={
          <Flex wrap gap={8}>
            {[
              ["About", "about"],
              ["Policies", "policies"],
              ["News", "news"],
              ["Software", "software/cocalc-plus"],
            ].map(([label, view]) => (
              <Button
                key={view}
                type={currentTop === view ? "primary" : "default"}
                href={contentPath(view)}
              >
                {label}
              </Button>
            ))}
          </Flex>
        }
      />
      <div style={{ marginTop: "24px" }}>{children}</div>
    </PublicPageRoot>
  );
}

function CocalcPlusPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash";

  return (
    <div style={GRID_STYLE}>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          What CoCalc Plus is
        </Title>
        <Paragraph style={{ margin: 0 }}>
          CoCalc Plus is the local single-user version of CoCalc. It is meant to
          feel more like installing VS Code or JupyterLab on your own machine
          than signing up for a hosted multi-user service.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Under the hood it builds on the Lite core, so it reuses the same
          application and document model while packaging it as a local product.
        </Paragraph>
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Install CoCalc Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          The current install flow uses the hosted software distribution:
        </Paragraph>
        <CodeCommand value={installCommand} />
        <Flex wrap gap={12}>
          <CopyCommandButton value={installCommand} />
          <Button href="https://software.cocalc.ai/software/cocalc-plus/install.sh">
            Open install script
          </Button>
        </Flex>
        <Paragraph style={{ margin: 0 }}>
          Current target platforms are Linux and macOS. The installer places the
          runtime in a user-owned location and adds a launcher if needed.
        </Paragraph>
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why this matters for the public site
        </Title>
        <Paragraph style={{ margin: 0 }}>
          The product story is no longer just “use CoCalc in the browser”.
          Hosted CoCalc and CoCalc Plus both matter, so the public marketing
          pages should stop implying that online use is the only option.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          This is especially relevant for notebook workflows, where some users
          want the same broader CoCalc environment on their own machine.
        </Paragraph>
        <Flex wrap gap={12}>
          <LinkButton href={appPath("features/jupyter-notebook")}>
            Jupyter notebooks
          </LinkButton>
          <LinkButton href={appPath("features/linux")}>
            Linux workflow
          </LinkButton>
        </Flex>
      </PublicSectionCard>
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
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            Events
          </Title>
          <Paragraph style={{ margin: 0 }}>
            See conference appearances and other public events.
          </Paragraph>
          <div style={{ display: "grid", gap: "8px" }}>
            <LinkButton href={contentPath("about/events")}>
              Open events
            </LinkButton>
          </div>
        </PublicSectionCard>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            Team
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Meet the people building and operating {siteName}.
          </Paragraph>
          <div>
            <LinkButton href={contentPath("about/team")}>
              Meet the team
            </LinkButton>
          </div>
        </PublicSectionCard>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            Support
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Need help or want to contact us directly?
          </Paragraph>
          <div style={{ display: "grid", gap: "8px" }}>
            <LinkButton href={appPath("support")}>Open support</LinkButton>
            {helpEmail ? (
              <LinkButton href={`mailto:${helpEmail}`}>{helpEmail}</LinkButton>
            ) : null}
          </div>
        </PublicSectionCard>
      </div>
    </>
  );
}

function AboutTeamPage() {
  return (
    <div style={GRID_STYLE}>
      {TEAM_MEMBERS.map((member) => (
        <PublicSectionCard key={member.email}>
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
            {member.title}
          </div>
          <Title level={3} style={{ margin: 0 }}>
            {member.name}
          </Title>
          <div>{member.description}</div>
          <div>
            <LinkButton href={`mailto:${member.email}`}>
              {member.email}
            </LinkButton>
          </div>
        </PublicSectionCard>
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
        <PublicSectionCard key={`${item.id ?? item.title}-${item.date}`}>
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
            {formatNewsDate(item.date)}
          </div>
          <Title level={3} style={{ margin: 0 }}>
            {item.title}
          </Title>
          {item.tags?.length ? (
            <Flex wrap gap={8}>
              {item.tags.map((tag) => (
                <Tag key={tag}>#{tag}</Tag>
              ))}
            </Flex>
          ) : null}
          <Suspense fallback={<div>Loading content…</div>}>
            <Markdown value={item.text} />
          </Suspense>
          {item.url ? (
            <div>
              <LinkButton href={item.url}>Event website</LinkButton>
            </div>
          ) : null}
        </PublicSectionCard>
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
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          No public policies configured
        </Title>
        <Paragraph style={{ margin: 0 }}>
          This deployment has not exposed any public policy pages yet.
        </Paragraph>
      </PublicSectionCard>
    );
  }

  return (
    <div style={GRID_STYLE}>
      {items.map((item) => (
        <PublicSectionCard key={item.href}>
          <Title level={3} style={{ margin: 0 }}>
            {item.title}
          </Title>
          <Paragraph style={{ margin: 0 }}>{item.description}</Paragraph>
          <div>
            <LinkButton href={item.href}>Open page</LinkButton>
          </div>
        </PublicSectionCard>
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
        <LinkButton href={contentPath("policies")}>Back to policies</LinkButton>
      </div>
      <MarkdownCard value={markdown} />
    </div>
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  const body = truncate(stripMarkdown(item.text));
  return (
    <PublicSectionCard>
      <Flex wrap gap={8}>
        <Tag color="blue">{item.channel}</Tag>
        <Text type="secondary">{formatNewsDate(item.date)}</Text>
      </Flex>
      <Title level={3} style={{ margin: 0 }}>
        {item.title}
      </Title>
      <Paragraph style={{ margin: 0 }}>{body}</Paragraph>
      {item.tags?.length ? (
        <Flex wrap gap={8}>
          {item.tags.map((tag) => (
            <Tag key={tag}>#{tag}</Tag>
          ))}
        </Flex>
      ) : null}
      <Flex wrap gap={12}>
        <LinkButton href={contentNewsPath(item)}>Open post</LinkButton>
        {item.url ? (
          <LinkButton href={item.url}>External link</LinkButton>
        ) : null}
      </Flex>
    </PublicSectionCard>
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
      <Paragraph style={{ marginTop: 24, maxWidth: "70ch" }}>
        Recent announcements and feature updates. Subscribe via{" "}
        <LinkButton href={contentPath("news/rss.xml")}>RSS</LinkButton> or{" "}
        <LinkButton href={contentPath("news/feed.json")}>JSON Feed</LinkButton>.
      </Paragraph>
      <div style={{ marginTop: 12 }}>
        <Segmented
          block
          options={[
            { label: "All", value: "all", title: "All channels" },
            ...(Object.keys(CHANNELS_DESCRIPTIONS) as Channel[]).map(
              (name) => ({
                label: name,
                value: name,
                title: CHANNELS_DESCRIPTIONS[name],
              }),
            ),
          ]}
          value={channel}
          onChange={(value) => setChannel(value as Channel | "all")}
        />
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
      <Flex wrap gap={12}>
        <LinkButton href={contentPath("news")}>Back to news</LinkButton>
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
        <PublicSectionCard>
          Historic snapshot from {formatNewsDate(payload.timestamp)}
        </PublicSectionCard>
      ) : null}
      <PublicSectionCard>
        <Flex wrap gap={8}>
          <Tag color="blue">{news.channel}</Tag>
          <Text type="secondary">{formatNewsDate(news.date)}</Text>
        </Flex>
        <Title level={2} style={{ margin: 0 }}>
          {news.title}
        </Title>
        {news.tags?.length ? (
          <Flex wrap gap={8}>
            {news.tags.map((tag) => (
              <Tag key={tag}>#{tag}</Tag>
            ))}
          </Flex>
        ) : null}
        <Suspense fallback={<div>Loading content…</div>}>
          <Markdown value={news.text} />
        </Suspense>
      </PublicSectionCard>
      <Flex wrap gap={12}>
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

  if (initialRoute.view === "software-cocalc-plus") {
    return (
      <PageShell
        route={initialRoute}
        subtitle="The local single-user CoCalc experience for your own machine."
        title={title}
      >
        <CocalcPlusPage />
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
