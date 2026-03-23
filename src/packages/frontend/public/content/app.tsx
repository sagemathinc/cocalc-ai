/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import {
  CHANNELS_DESCRIPTIONS,
  type Channel,
  type NewsItem,
} from "@cocalc/util/types/news";
import { COLORS, SITE_NAME } from "@cocalc/util/theme";

export type PublicContentView = "about" | "policies" | "news";

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
  initialView: PublicContentView;
}

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

function contentPath(view: PublicContentView): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}/${view}`;
}

export function getContentViewFromPath(pathname: string): PublicContentView {
  if (pathname.includes("/policies")) {
    return "policies";
  }
  if (pathname.includes("/news")) {
    return "news";
  }
  return "about";
}

function titleForView(view: PublicContentView, siteName: string): string {
  switch (view) {
    case "policies":
      return `${siteName} policies`;
    case "news":
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

function PageShell({
  children,
  currentView,
  subtitle,
  title,
}: {
  children: ReactNode;
  currentView: PublicContentView;
  subtitle: string;
  title: string;
}) {
  const navItems: Array<{ label: string; view: PublicContentView }> = [
    { label: "About", view: "about" },
    { label: "Policies", view: "policies" },
    { label: "News", view: "news" },
  ];

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
            {navItems.map(({ label, view }) => (
              <a
                key={view}
                href={contentPath(view)}
                style={
                  currentView === view ? NAV_LINK_ACTIVE_STYLE : NAV_LINK_STYLE
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

function AboutPage({
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
          <div>
            We regularly exhibit at academic conferences and community events.
          </div>
          <div>
            <a href="/about/events" style={LINK_STYLE}>
              See upcoming events
            </a>
          </div>
        </div>
        <div style={CARD_STYLE}>
          <h2 style={{ margin: 0, fontSize: "22px" }}>Team</h2>
          <div>Meet the people building and operating {siteName}.</div>
          <div>
            <a href="/about/team" style={LINK_STYLE}>
              View the team
            </a>
          </div>
        </div>
        <div style={CARD_STYLE}>
          <h2 style={{ margin: 0, fontSize: "22px" }}>Support</h2>
          <div>
            Need help or want to contact us directly about deployment or usage?
          </div>
          <div style={{ display: "grid", gap: "8px" }}>
            <a href="/support" style={LINK_STYLE}>
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

function PoliciesPage({ config }: { config: ContentConfig }) {
  const items = config.on_cocalc_com
    ? [
        {
          title: "Terms of service",
          href: "/policies/terms",
          description: "The terms governing use of CoCalc.",
        },
        {
          title: "Trust",
          href: "/policies/trust",
          description: "Compliance and operational security information.",
        },
        {
          title: "Copyright policy",
          href: "/policies/copyright",
          description: "How copyright complaints and notices are handled.",
        },
        {
          title: "Privacy",
          href: "/policies/privacy",
          description: "How user data is handled and protected.",
        },
        {
          title: "Third parties",
          href: "/policies/thirdparties",
          description: "The third-party services involved in operating CoCalc.",
        },
        {
          title: "FERPA compliance",
          href: "/policies/ferpa",
          description: "Our FERPA compliance statement for educational use.",
        },
        {
          title: "Accessibility",
          href: "/policies/accessibility",
          description: "Accessibility and VPAT information.",
        },
      ]
    : [
        ...(config.imprint
          ? [
              {
                title: "Imprint",
                href: "/policies/imprint",
                description: "Site-specific legal imprint information.",
              },
            ]
          : []),
        ...(config.policies
          ? [
              {
                title: "Policies",
                href: "/policies/policies",
                description:
                  "Site-specific policy information configured by admins.",
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
      {item.url ? (
        <div>
          <a href={item.url} style={LINK_STYLE}>
            Read more
          </a>
        </div>
      ) : null}
    </div>
  );
}

function NewsPage({ initialNews }: { initialNews?: NewsItem[] }) {
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [error, setError] = useState<string>("");
  const [items, setItems] = useState<NewsItem[]>(initialNews ?? []);
  const [loading, setLoading] = useState(initialNews == null);

  useEffect(() => {
    let canceled = false;
    if (initialNews != null) {
      return;
    }
    async function load() {
      try {
        setLoading(true);
        const resp = await fetch(joinUrlPath(appBasePath, "api/v2/news/list"));
        const payload = await resp.json();
        if (canceled) return;
        if (payload?.error) {
          setError(`${payload.error}`);
          setItems([]);
        } else {
          setError("");
          setItems(Array.isArray(payload) ? payload : []);
        }
      } catch (err) {
        if (canceled) return;
        setError(`${err}`);
        setItems([]);
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    void load();
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
        <a href="/news/rss.xml" style={LINK_STYLE}>
          RSS
        </a>{" "}
        or{" "}
        <a href="/news/feed.json" style={LINK_STYLE}>
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
        <div style={{ ...CARD_STYLE, marginTop: "18px" }}>Loading news…</div>
      ) : error ? (
        <div style={{ ...CARD_STYLE, marginTop: "18px" }}>
          Unable to load news right now.
        </div>
      ) : visible.length === 0 ? (
        <div style={{ ...CARD_STYLE, marginTop: "18px" }}>
          No news items match the selected filter.
        </div>
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

export default function PublicContentApp({
  config,
  initialNews,
  initialView,
}: PublicContentAppProps) {
  const [view, setView] = useState<PublicContentView>(initialView);
  const siteName = config?.site_name ?? SITE_NAME;
  const title = useMemo(() => titleForView(view, siteName), [siteName, view]);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    const onPopstate = () =>
      setView(getContentViewFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, []);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  if (view === "policies") {
    return (
      <PageShell
        currentView={view}
        subtitle="Public legal and compliance information for this deployment."
        title={title}
      >
        <PoliciesPage config={config ?? {}} />
      </PageShell>
    );
  }

  if (view === "news") {
    return (
      <PageShell
        currentView={view}
        subtitle={`News and release notes for ${siteName}.`}
        title={title}
      >
        <NewsPage initialNews={initialNews} />
      </PageShell>
    );
  }

  return (
    <PageShell
      currentView={view}
      subtitle={`Background information and public resources for ${siteName}.`}
      title={title}
    >
      <AboutPage helpEmail={config?.help_email} siteName={siteName} />
    </PageShell>
  );
}
