/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";

import {
  Button,
  Empty,
  Flex,
  Menu,
  Segmented,
  Spin,
  Tag,
  Typography,
} from "antd";
import { joinUrlPath } from "@cocalc/util/url-path";
import type { HistoricCounts, Stats } from "@cocalc/util/db-schema/stats";
import {
  CHANNELS_DESCRIPTIONS,
  PUBLIC_NEWS_CHANNELS,
  type Channel,
  type NewsItem,
  type NewsPrevNext,
} from "@cocalc/util/types/news";
import { COLORS, SITE_NAME } from "@cocalc/util/theme";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PublicSiteShell,
  PublicSectionCard,
} from "@cocalc/frontend/public/layout/shell";
import PublicAuthApp from "./auth/app";
import PublicFeaturesApp from "./features/app";
import PublicHomeApp from "./home/app";
import PublicLangApp from "./lang/app";
import PublicSupportApp from "./support/app";
import { ExactPolicyPage, getExactPolicyPage } from "./policies";
import PricingPage, { type PublicMembershipTier } from "./pricing/page";
import {
  publicPath,
  type PublicInfoRoute,
  type PublicRoute,
  topLevelInfoView,
} from "./routes";
import {
  getTeamMember,
  TEAM_MEMBERS,
  type TeamMemberProfile,
} from "./about/team-data";
import {
  contentNewsPath,
  formatDateTime,
  formatNewsDate,
  newsHistoryPath,
} from "./news/utils";
import { CodeCommand, CopyCommandButton } from "./software/components";

const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));
const StaticMarkdown = lazy(
  () => import("@cocalc/frontend/editors/slate/static-markdown-public"),
);
const { Paragraph, Text, Title } = Typography;

interface PublicConfig {
  help_email?: string;
  is_admin?: boolean;
  imprint?: string;
  is_authenticated?: boolean;
  on_cocalc_com?: boolean;
  policies?: string;
  site_name?: string;
  show_policies?: boolean;
  terms_of_service_url?: string;
}

interface PublicAppProps {
  config?: PublicConfig;
  initialRequiresToken?: boolean;
  initialMembershipTiers?: PublicMembershipTier[];
  initialNews?: NewsItem[];
  initialRoute: PublicRoute;
  redirectToPath?: string;
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

interface StatsPayload extends Partial<Stats> {
  error?: string;
}

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
  gap: "16px",
  marginTop: "24px",
} as const;

const MUTED_STYLE: CSSProperties = {
  color: COLORS.GRAY_M,
} as const;

const BUILTIN_POLICY_NAV_ITEMS = [
  { href: publicPath("policies/terms"), key: "terms", label: "Terms" },
  { href: publicPath("policies/trust"), key: "trust", label: "Trust" },
  {
    href: publicPath("policies/copyright"),
    key: "copyright",
    label: "Copyright",
  },
  { href: publicPath("policies/privacy"), key: "privacy", label: "Privacy" },
  {
    href: publicPath("policies/thirdparties"),
    key: "thirdparties",
    label: "Third parties",
  },
  { href: publicPath("policies/ferpa"), key: "ferpa", label: "FERPA" },
  {
    href: publicPath("policies/accessibility"),
    key: "accessibility",
    label: "Accessibility",
  },
  {
    href: publicPath("policies/enterprise-terms"),
    key: "enterprise-terms",
    label: "Enterprise",
  },
] as const;

async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(path);
  return await resp.json();
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function titleForRoute(route: PublicInfoRoute, siteName: string): string {
  switch (route.view) {
    case "about-events":
      return `${siteName} Events`;
    case "about-status":
      return `${siteName} Status`;
    case "about-team":
      return `${siteName} Team`;
    case "about-team-member":
      return `${getTeamMember(route.teamSlug)?.name ?? "Team"} - ${siteName}`;
    case "pricing":
      return `${siteName} Pricing`;
    case "policies":
      return `${siteName} Policies`;
    case "policies-imprint":
      return `${siteName} Imprint`;
    case "policies-custom":
      return `${siteName} Policies`;
    case "policies-detail":
      return `${getExactPolicyPage(route.policySlug)?.title ?? "Policies"} - ${siteName}`;
    case "news":
      return `${siteName} News`;
    case "news-detail":
    case "news-history":
      return `${siteName} News`;
    case "software":
      return `${siteName} Software`;
    case "software-cocalc-launchpad":
      return "CoCalc Launchpad";
    case "software-cocalc-plus":
      return "CoCalc Plus";
    case "about":
    default:
      return `About ${siteName}`;
  }
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

function arePoliciesVisible(config?: PublicConfig): boolean {
  return !!config?.show_policies;
}

function getExternalPoliciesUrl(config?: PublicConfig): string | undefined {
  const url = config?.terms_of_service_url?.trim();
  return url ? url : undefined;
}

function PolicyGateCard({ config }: { config?: PublicConfig }) {
  const externalUrl = getExternalPoliciesUrl(config);

  if (!arePoliciesVisible(config)) {
    return (
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Public policy pages are disabled
        </Title>
        <Paragraph style={{ margin: 0 }}>
          This deployment is not exposing a public policy section.
        </Paragraph>
      </PublicSectionCard>
    );
  }

  if (!externalUrl) {
    return null;
  }

  return (
    <PublicSectionCard>
      <Title level={3} style={{ margin: 0 }}>
        Public policy information
      </Title>
      <Paragraph style={{ margin: 0 }}>
        This deployment uses an external policy page instead of the built-in
        legal documents.
      </Paragraph>
      <div>
        <Button
          href={externalUrl}
          rel="noreferrer"
          target="_blank"
          type="primary"
        >
          Open policy page
        </Button>
      </div>
    </PublicSectionCard>
  );
}

function PageShell({
  children,
  config,
  route,
  title,
}: {
  children: ReactNode;
  config?: PublicConfig;
  route: PublicInfoRoute;
  title: string;
}) {
  return (
    <PublicSiteShell
      active={topLevelInfoView(route)}
      isAuthenticated={!!config?.is_authenticated}
      showPolicies={arePoliciesVisible(config)}
      siteName={config?.site_name ?? SITE_NAME}
      title={title}
    >
      {children}
    </PublicSiteShell>
  );
}

function SoftwareOverviewPage() {
  return (
    <div style={GRID_STYLE}>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Hosted CoCalc
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Use the full hosted service when you want managed infrastructure,
          multi-user collaboration, shared projects, and the broadest set of
          public pages and support workflows.
        </Paragraph>
        <Flex wrap gap={12}>
          <LinkButton href={appPath("features")}>Explore features</LinkButton>
          <LinkButton href={appPath("support")}>Support</LinkButton>
        </Flex>
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          CoCalc Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          The local single-user CoCalc experience for your own machine. It is
          the simplest path when you want the CoCalc workspace model without
          standing up a shared service.
        </Paragraph>
        <div>
          <LinkButton href={publicPath("software/cocalc-plus")}>
            Open CoCalc Plus
          </LinkButton>
        </div>
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          CoCalc Launchpad
        </Title>
        <Paragraph style={{ margin: 0 }}>
          The lightweight control-plane bundle for small teams and self-hosted
          deployments that want the CoCalc user model without the old Next.js
          stack.
        </Paragraph>
        <div>
          <LinkButton href={publicPath("software/cocalc-launchpad")}>
            Open Launchpad
          </LinkButton>
        </div>
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Documentation
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Read the main docs, deployment references, and operator-facing setup
          material before choosing an install path.
        </Paragraph>
        <Flex wrap gap={12}>
          <LinkButton href="https://doc.cocalc.com/">CoCalc docs</LinkButton>
          <LinkButton href="https://software.cocalc.ai/software/cocalc-launchpad/index.html">
            Launchpad software site
          </LinkButton>
        </Flex>
      </PublicSectionCard>
    </div>
  );
}

function CocalcLaunchpadPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-launchpad/install.sh | bash";

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div style={GRID_STYLE}>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            What CoCalc Launchpad is
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Launchpad is the lightweight control-plane bundle for small
            teams and self-hosted deployments. It is the clearest path when you
            want a shared CoCalc environment that you operate yourself.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            It is aimed at rapid iteration, small deployments, and productized
            use of the same collaborative workspace model that powers the hosted
            service.
          </Paragraph>
        </PublicSectionCard>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            Install CoCalc Launchpad
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Copy and run this in your terminal:
          </Paragraph>
          <CodeCommand value={installCommand} />
          <Flex wrap gap={12}>
            <CopyCommandButton value={installCommand} />
            <Button href="https://software.cocalc.ai/software/cocalc-launchpad/install.sh">
              Open install script
            </Button>
            <Button href="https://software.cocalc.ai/software/cocalc-launchpad/index.html">
              Open software page
            </Button>
          </Flex>
          <Paragraph style={{ margin: 0 }}>
            Current supported targets are Linux on x64 or arm64, and macOS on
            arm64.
          </Paragraph>
        </PublicSectionCard>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            What the installer does
          </Title>
          <Paragraph style={{ margin: 0 }}>
            The installer downloads the platform-specific manifest, verifies the
            corresponding Launchpad artifact, installs it into a user-owned
            directory, and adds a launcher to your PATH if needed.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            On Linux this lives under
            <code> ~/.local/share/cocalc-launchpad</code>, and on macOS under
            <code> ~/Library/Application Support/cocalc-launchpad</code>.
          </Paragraph>
        </PublicSectionCard>
      </div>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Choose Launchpad or CoCalc Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc Plus for a local single-user install. Choose Launchpad
          when you want a shared deployment for a small team or an operator-run
          instance with the same overall workspace model.
        </Paragraph>
        <Flex wrap gap={12}>
          <LinkButton href={publicPath("software/cocalc-plus")}>
            Compare with CoCalc Plus
          </LinkButton>
          <LinkButton href={appPath("features/api")}>HTTP API</LinkButton>
        </Flex>
      </PublicSectionCard>
    </div>
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
          It brings notebooks, terminals, files, and the broader CoCalc
          workspace model into a local single-user install.
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
          Choose hosted CoCalc or CoCalc Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Hosted CoCalc is the right fit when you want multi-user collaboration,
          shared projects, and managed infrastructure. CoCalc Plus is the right
          fit when you want the same style of environment on your own machine.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Both options matter for notebook-heavy technical work, and they share
          the same overall approach to projects, files, terminals, and
          computational workflows.
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
        and research. Use these pages to explore the platform, read public
        policies and news, and then move into projects when you are ready.
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
            <LinkButton href={publicPath("about/events")}>
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
            <LinkButton href={publicPath("about/team")}>
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
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            Documentation
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Browse the CoCalc manual, teaching guide, API docs, and admin
            references.
          </Paragraph>
          <div style={{ display: "grid", gap: "8px" }}>
            <LinkButton href={appPath("support")}>Open support</LinkButton>
            <LinkButton href="https://doc.cocalc.com/">Read docs</LinkButton>
          </div>
        </PublicSectionCard>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            System status
          </Title>
          <Paragraph style={{ margin: 0 }}>
            See current activity and high-level usage metrics for {siteName}.
          </Paragraph>
          <div>
            <LinkButton href={publicPath("about/status")}>
              Open status
            </LinkButton>
          </div>
        </PublicSectionCard>
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            Ways to run CoCalc
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Compare hosted CoCalc, CoCalc Plus, and CoCalc Launchpad.
          </Paragraph>
          <div>
            <LinkButton href={publicPath("software")}>Open software</LinkButton>
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
          <img
            alt={member.imageAlt}
            src={member.imageSrc}
            style={{
              width: "100%",
              aspectRatio: "4 / 3",
              objectFit: "cover",
              borderRadius: 14,
            }}
          />
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
            {member.title} · {member.positionTimeframe}
          </div>
          <Title level={3} style={{ margin: 0 }}>
            {member.name}
          </Title>
          <div>{member.summary}</div>
          <Flex wrap gap={12}>
            <LinkButton href={publicPath(`about/team/${member.slug}`)}>
              Read bio
            </LinkButton>
            <LinkButton href={`mailto:${member.email}`}>
              {member.email}
            </LinkButton>
          </Flex>
        </PublicSectionCard>
      ))}
    </div>
  );
}

function ExperienceList({ member }: { member: TeamMemberProfile }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {member.experience.map((item) => (
        <div
          key={`${item.position}-${item.institution}-${item.timeframe}`}
          style={{
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 12,
            padding: 14,
          }}
        >
          <div style={{ fontWeight: 700 }}>{item.position}</div>
          <div>{item.institution}</div>
          <div style={MUTED_STYLE}>{item.timeframe}</div>
        </div>
      ))}
    </div>
  );
}

function AboutTeamMemberPage({ slug }: { slug?: string }) {
  const member = getTeamMember(slug);

  if (!member) {
    return <EmptyCard label="This team profile was not found." />;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <LinkButton href={publicPath("about/team")}>Back to team</LinkButton>
      </div>
      <PublicSectionCard>
        <div
          style={{
            display: "grid",
            gap: 24,
            gridTemplateColumns: "minmax(220px, 320px) minmax(0, 1fr)",
            alignItems: "start",
          }}
        >
          <img
            alt={member.imageAlt}
            src={member.imageSrc}
            style={{
              width: "100%",
              borderRadius: 16,
              objectFit: "cover",
            }}
          />
          <div style={{ display: "grid", gap: 12 }}>
            <Text strong type="secondary">
              TEAM
            </Text>
            <Title level={2} style={{ margin: 0 }}>
              {member.name}
            </Title>
            <Paragraph style={{ fontSize: 18, margin: 0 }}>
              {member.position}
            </Paragraph>
            <Paragraph style={{ ...MUTED_STYLE, margin: 0 }}>
              {member.positionTimeframe}
            </Paragraph>
            <Paragraph style={{ fontSize: 17, margin: 0 }}>
              {member.summary}
            </Paragraph>
            {member.role.map((paragraph) => (
              <Paragraph key={paragraph} style={{ margin: 0 }}>
                {paragraph}
              </Paragraph>
            ))}
            <Flex wrap gap={12}>
              <Button href={`mailto:${member.email}`} type="primary">
                {member.email}
              </Button>
              {member.website ? (
                <Button href={member.website.href}>
                  {member.website.label}
                </Button>
              ) : null}
            </Flex>
          </div>
        </div>
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Background
        </Title>
        {member.background.map((paragraph) => (
          <Paragraph key={paragraph} style={{ margin: 0 }}>
            {paragraph}
          </Paragraph>
        ))}
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Personal notes
        </Title>
        {member.personal.map((paragraph) => (
          <Paragraph key={paragraph} style={{ margin: 0 }}>
            {paragraph}
          </Paragraph>
        ))}
      </PublicSectionCard>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Experience
        </Title>
        <ExperienceList member={member} />
      </PublicSectionCard>
    </div>
  );
}

function historicCount(
  counts: HistoricCounts | undefined,
  key: keyof HistoricCounts,
): number {
  const value = counts?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function StatusMetricCard({
  detail,
  title,
  value,
}: {
  detail: string;
  title: string;
  value: string;
}) {
  return (
    <PublicSectionCard>
      <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
        {title}
      </div>
      <div style={{ fontSize: "2rem", fontWeight: 700, lineHeight: 1.1 }}>
        {value}
      </div>
      <Paragraph style={{ margin: 0 }}>{detail}</Paragraph>
    </PublicSectionCard>
  );
}

function AboutStatusPage({ siteName }: { siteName: string }) {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<StatsPayload>({});

  useEffect(() => {
    let canceled = false;
    void fetchJson<StatsPayload>(joinUrlPath(appBasePath, "stats"))
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
    return <LoadingCard label="Loading system status…" />;
  }

  if (payload.error) {
    return <EmptyCard label={`Status unavailable: ${payload.error}`} />;
  }

  const connectedClients = (payload.hub_servers ?? []).reduce(
    (sum, server) => sum + (server.clients ?? 0),
    0,
  );

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Live activity snapshot
        </Title>
        <Paragraph style={{ margin: 0 }}>
          This is the current high-level activity view for {siteName}. It is
          intended as a public system monitor rather than a full admin console.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Last updated: {formatDateTime(payload.time)}
        </Paragraph>
      </PublicSectionCard>
      <div style={GRID_STYLE}>
        <StatusMetricCard
          title="Accounts"
          value={`${payload.accounts ?? 0}`}
          detail={`Active in 5 minutes: ${historicCount(payload.accounts_active, "5min")} · Active in 1 day: ${historicCount(payload.accounts_active, "1d")}`}
        />
        <StatusMetricCard
          title="Projects"
          value={`${payload.projects ?? 0}`}
          detail={`Edited in 5 minutes: ${historicCount(payload.projects_edited, "5min")} · Edited in 1 day: ${historicCount(payload.projects_edited, "1d")}`}
        />
        <StatusMetricCard
          title="Running projects"
          value={`${(payload.running_projects?.free ?? 0) + (payload.running_projects?.member ?? 0)}`}
          detail={`Free: ${payload.running_projects?.free ?? 0} · Member: ${payload.running_projects?.member ?? 0}`}
        />
        <StatusMetricCard
          title="Hub servers"
          value={`${payload.hub_servers?.length ?? 0}`}
          detail={`Connected browser sessions: ${connectedClients}`}
        />
      </div>
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

function PoliciesHome({ config }: { config: PublicConfig }) {
  const externalUrl = getExternalPoliciesUrl(config);
  if (!arePoliciesVisible(config) || externalUrl) {
    return <PolicyGateCard config={config} />;
  }

  const items = [
    {
      description: "The Terms of Service govern use of CoCalc.",
      href: publicPath("policies/terms"),
      title: "Terms of service",
    },
    {
      description:
        "The Trust page highlights our compliance with laws and frameworks, such as GDPR and SOC 2. We adhere to rigorous standards to protect your data and maintain transparency and accountability in all our operations.",
      href: publicPath("policies/trust"),
      title: "Trust",
    },
    {
      description:
        "The Copyright Policy explains how SageMath, Inc. respects copyright policies, and provides a site that does not infringe on others' copyright.",
      href: publicPath("policies/copyright"),
      title: "Copyright policies",
    },
    {
      description:
        "The Privacy Policy describes how SageMath, Inc. respects the privacy of its users.",
      href: publicPath("policies/privacy"),
      title: "Privacy",
    },
    {
      description:
        "Our List of third parties enumerates what is used to provide CoCalc.",
      href: publicPath("policies/thirdparties"),
      title: "Third parties",
    },
    {
      description:
        "CoCalc's FERPA Compliance statement explains how we address FERPA requirements at US educational instituations.",
      href: publicPath("policies/ferpa"),
      title: "FERPA compliance statement",
    },
    {
      description:
        "CoCalc's Voluntary Product Accessibility Template (VPAT) describes how we address accessibility issues.",
      href: publicPath("policies/accessibility"),
      title: "Accessibility",
    },
    {
      description: "Enterprise and institutional agreement overview.",
      href: publicPath("policies/enterprise-terms"),
      title: "Enterprise terms",
    },
    ...(config.imprint
      ? [
          {
            description: "Site-specific legal imprint information.",
            href: publicPath("policies/imprint"),
            title: "Imprint",
          },
        ]
      : []),
    ...(config.policies
      ? [
          {
            description:
              "Site-specific policy information configured by admins.",
            href: publicPath("policies/policies"),
            title: "Policies",
          },
        ]
      : []),
  ];

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
  config,
  markdown,
  title,
}: {
  config?: PublicConfig;
  markdown?: string;
  title: string;
}) {
  if (!arePoliciesVisible(config) || getExternalPoliciesUrl(config)) {
    return <PolicyGateCard config={config} />;
  }
  if (!markdown) {
    return (
      <EmptyCard label={`No ${title.toLowerCase()} content configured.`} />
    );
  }
  return <MarkdownCard value={markdown} />;
}

function PolicySubNav({ slug }: { slug?: string }) {
  const items = BUILTIN_POLICY_NAV_ITEMS.map((item) => ({
    key: item.key,
    label: <a href={item.href}>{item.label}</a>,
  }));
  return (
    <Flex justify="center" style={{ minWidth: 0 }}>
      <Menu
        aria-label="Policy pages"
        disabledOverflow
        items={items}
        mode="horizontal"
        selectedKeys={slug == null ? [] : [slug]}
        style={{
          background: "transparent",
          borderBottom: 0,
          flex: "0 1 auto",
          lineHeight: "normal",
        }}
      />
    </Flex>
  );
}

function ExactPolicyPageShell({ slug }: { slug?: string }) {
  if (getExactPolicyPage(slug) == null) {
    return <EmptyCard label="This policy page was not found." />;
  }

  return (
    <div style={{ display: "grid" }}>
      <PolicySubNav slug={slug} />
      <ExactPolicyPage slug={slug} />
    </div>
  );
}

function NewsMarkdown({
  value,
  preview,
}: {
  value: string;
  preview?: boolean;
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
    <PublicSectionCard>
      <Flex wrap gap={8}>
        <Tag color="blue">{item.channel}</Tag>
        <Text type="secondary">{formatNewsDate(item.date)}</Text>
      </Flex>
      <Title level={3} style={{ margin: 0 }}>
        {item.title}
      </Title>
      <NewsMarkdown preview value={item.text} />
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

function NewsListPage({
  initialNews,
  isAdmin,
}: {
  initialNews?: NewsItem[];
  isAdmin?: boolean;
}) {
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [items, setItems] = useState<NewsItem[]>(initialNews ?? []);
  const [loading, setLoading] = useState(initialNews == null);

  useEffect(() => {
    let canceled = false;
    if (initialNews == null) {
      setLoading(true);
    }
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
        <LinkButton href={publicPath("news/rss.xml")}>RSS</LinkButton> or{" "}
        <LinkButton href={publicPath("news/feed.json")}>JSON Feed</LinkButton>.
      </Paragraph>
      {isAdmin ? (
        <div style={{ marginTop: 16 }}>
          <PublicSectionCard>
            <Flex wrap gap={12}>
              <LinkButton href={appPath("admin/news")}>Manage news</LinkButton>
              <LinkButton href={appPath("admin/news/new")}>
                Create post
              </LinkButton>
              <LinkButton href={appPath("admin/news/new?channel=event")}>
                Create event
              </LinkButton>
            </Flex>
          </PublicSectionCard>
        </div>
      ) : null}
      <div style={{ marginTop: 12 }}>
        <Segmented
          block
          options={[
            { label: "All", value: "all", title: "All channels" },
            ...PUBLIC_NEWS_CHANNELS.map((name) => ({
              label: name,
              value: name,
              title: CHANNELS_DESCRIPTIONS[name],
            })),
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

function NewsDetailPage({ route }: { route: PublicInfoRoute }) {
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
        <NewsMarkdown value={news.text} />
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

function PublicInfoApp({
  config,
  initialMembershipTiers,
  initialNews,
  initialRoute,
}: {
  config?: PublicConfig;
  initialMembershipTiers?: PublicMembershipTier[];
  initialNews?: NewsItem[];
  initialRoute: PublicInfoRoute;
}) {
  const siteName = config?.site_name ?? SITE_NAME;
  const title = titleForRoute(initialRoute, siteName);

  useEffect(() => {
    document.title = title;
  }, [title]);

  if (initialRoute.view === "about-events") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <AboutEventsPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "about-team") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <AboutTeamPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "about-team-member") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <AboutTeamMemberPage slug={initialRoute.teamSlug} />
      </PageShell>
    );
  }

  if (initialRoute.view === "about-status") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <AboutStatusPage siteName={siteName} />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies-imprint") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <PoliciesDetailPage
          config={config}
          markdown={config?.imprint}
          title="Imprint"
        />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies-custom") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <PoliciesDetailPage
          config={config}
          markdown={config?.policies}
          title="Policies"
        />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <PoliciesHome config={config ?? {}} />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies-detail") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        {!arePoliciesVisible(config) || getExternalPoliciesUrl(config) ? (
          <PolicyGateCard config={config} />
        ) : (
          <ExactPolicyPageShell slug={initialRoute.policySlug} />
        )}
      </PageShell>
    );
  }

  if (
    initialRoute.view === "news-detail" ||
    initialRoute.view === "news-history"
  ) {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <NewsDetailPage route={initialRoute} />
      </PageShell>
    );
  }

  if (initialRoute.view === "news") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <NewsListPage initialNews={initialNews} isAdmin={!!config?.is_admin} />
      </PageShell>
    );
  }

  if (initialRoute.view === "software-cocalc-plus") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <CocalcPlusPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "software-cocalc-launchpad") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <CocalcLaunchpadPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "software") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <SoftwareOverviewPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "pricing") {
    return (
      <PageShell config={config} route={initialRoute} title={title}>
        <PricingPage
          isAuthenticated={!!config?.is_authenticated}
          siteName={siteName}
          tiers={initialMembershipTiers}
        />
      </PageShell>
    );
  }

  return (
    <PageShell config={config} route={initialRoute} title={title}>
      <AboutHome helpEmail={config?.help_email} siteName={siteName} />
    </PageShell>
  );
}

export default function PublicApp({
  config,
  initialRequiresToken,
  initialMembershipTiers,
  initialNews,
  initialRoute,
  redirectToPath,
}: PublicAppProps) {
  if (initialRoute.section === "home") {
    return <PublicHomeApp config={config} initialNews={initialNews} />;
  }

  if (initialRoute.section === "features") {
    return (
      <PublicFeaturesApp config={config} initialRoute={initialRoute.route} />
    );
  }

  if (initialRoute.section === "support") {
    return <PublicSupportApp config={config} initialView={initialRoute.view} />;
  }

  if (initialRoute.section === "auth") {
    return (
      <PublicAuthApp
        initialRequiresToken={initialRequiresToken}
        initialRoute={initialRoute.route}
        isAuthenticated={!!config?.is_authenticated}
        redirectToPath={redirectToPath}
        showPolicies={!!config?.show_policies}
        siteName={config?.site_name ?? SITE_NAME}
      />
    );
  }

  if (initialRoute.section === "lang") {
    return <PublicLangApp config={config} initialRoute={initialRoute.route} />;
  }

  return (
    <PublicInfoApp
      config={config}
      initialMembershipTiers={initialMembershipTiers}
      initialNews={initialNews}
      initialRoute={initialRoute.route}
    />
  );
}
