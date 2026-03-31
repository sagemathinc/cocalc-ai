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
import type { HistoricCounts, Stats } from "@cocalc/util/db-schema/stats";
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
import PublicTopNav from "@cocalc/frontend/public/ui/top-nav";
import { ExactPolicyPage, getExactPolicyPage } from "./legal-pages";
import { getPolicyPage } from "./policy-data";
import PricingPage, { type PublicMembershipTier } from "./pricing-page";
import { contentPath, type PublicContentRoute, topLevelView } from "./routes";
import {
  getTeamMember,
  TEAM_MEMBERS,
  type TeamMemberProfile,
} from "./team-data";

const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));
const StaticMarkdown = lazy(
  () => import("@cocalc/frontend/editors/slate/static-markdown-public"),
);
const { Paragraph, Text, Title } = Typography;

interface ContentConfig {
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

interface PublicContentAppProps {
  config?: ContentConfig;
  initialMembershipTiers?: PublicMembershipTier[];
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
    case "about-status":
      return `${siteName} status`;
    case "about-team":
      return `${siteName} team`;
    case "about-team-member":
      return `${getTeamMember(route.teamSlug)?.name ?? "Team"} - ${siteName}`;
    case "pricing":
      return `${siteName} pricing`;
    case "policies":
      return `${siteName} policies`;
    case "policies-imprint":
      return `${siteName} imprint`;
    case "policies-custom":
      return `${siteName} policies`;
    case "policies-detail":
      return `${getExactPolicyPage(route.policySlug)?.title ?? getPolicyPage(route.policySlug)?.title ?? "Policies"} - ${siteName}`;
    case "news":
      return `${siteName} news`;
    case "news-detail":
    case "news-history":
      return `${siteName} news`;
    case "software":
      return `${siteName} software`;
    case "software-cocalc-launchpad":
      return "CoCalc Launchpad";
    case "software-cocalc-plus":
      return "CoCalc Plus";
    case "about":
    default:
      return `About ${siteName}`;
  }
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

function formatDateTime(value?: number | Date): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleString();
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

function arePoliciesVisible(config?: ContentConfig): boolean {
  return !!config?.show_policies;
}

function getExternalPoliciesUrl(config?: ContentConfig): string | undefined {
  const url = config?.terms_of_service_url?.trim();
  return url ? url : undefined;
}

function PolicyGateCard({ config }: { config?: ContentConfig }) {
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
  config,
  route,
  subtitle,
  title,
}: {
  children: ReactNode;
  config?: ContentConfig;
  route: PublicContentRoute;
  subtitle: string;
  title: string;
}) {
  const currentTop = topLevelView(route);
  const navActive =
    currentTop === "about" ||
    currentTop === "pricing" ||
    currentTop === "policies" ||
    currentTop === "news"
      ? currentTop
      : undefined;
  return (
    <PublicPageRoot>
      <PublicTopNav
        active={navActive}
        isAuthenticated={!!config?.is_authenticated}
        showPolicies={arePoliciesVisible(config)}
        siteName={config?.site_name ?? SITE_NAME}
      />
      <PublicHero
        eyebrow="PUBLIC CONTENT"
        title={title}
        subtitle={subtitle}
        actions={
          <Flex wrap gap={8}>
            {[
              { href: "about", key: "about", label: "About" },
              { href: "pricing", key: "pricing", label: "Pricing" },
              ...(arePoliciesVisible(config)
                ? [{ href: "policies", key: "policies", label: "Policies" }]
                : []),
              { href: "news", key: "news", label: "News" },
              { href: "software", key: "software", label: "Software" },
            ].map((item) => (
              <Button
                key={item.href}
                type={currentTop === item.key ? "primary" : "default"}
                href={contentPath(item.href)}
              >
                {item.label}
              </Button>
            ))}
          </Flex>
        }
      />
      <div style={{ marginTop: "24px" }}>{children}</div>
    </PublicPageRoot>
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
          <LinkButton href={contentPath("software/cocalc-plus")}>
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
          <LinkButton href={contentPath("software/cocalc-launchpad")}>
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
          <LinkButton href={contentPath("software/cocalc-plus")}>
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
            <LinkButton href={contentPath("about/status")}>
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
            <LinkButton href={contentPath("software")}>
              Open software
            </LinkButton>
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
            <LinkButton href={contentPath(`about/team/${member.slug}`)}>
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
        <LinkButton href={contentPath("about/team")}>Back to team</LinkButton>
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

function PoliciesHome({ config }: { config: ContentConfig }) {
  const externalUrl = getExternalPoliciesUrl(config);
  if (!arePoliciesVisible(config) || externalUrl) {
    return <PolicyGateCard config={config} />;
  }

  const items = [
    {
      description: "The Terms of Service govern use of CoCalc.",
      href: contentPath("policies/terms"),
      title: "Terms of service",
    },
    {
      description:
        "The Trust page highlights our compliance with laws and frameworks, such as GDPR and SOC 2. We adhere to rigorous standards to protect your data and maintain transparency and accountability in all our operations.",
      href: contentPath("policies/trust"),
      title: "Trust",
    },
    {
      description:
        "The Copyright Policy explains how SageMath, Inc. respects copyright policies, and provides a site that does not infringe on others' copyright.",
      href: contentPath("policies/copyright"),
      title: "Copyright policies",
    },
    {
      description:
        "The Privacy Policy describes how SageMath, Inc. respects the privacy of its users.",
      href: contentPath("policies/privacy"),
      title: "Privacy",
    },
    {
      description:
        "Our List of third parties enumerates what is used to provide CoCalc.",
      href: contentPath("policies/thirdparties"),
      title: "Third parties",
    },
    {
      description:
        "CoCalc's FERPA Compliance statement explains how we address FERPA requirements at US educational instituations.",
      href: contentPath("policies/ferpa"),
      title: "FERPA compliance statement",
    },
    {
      description:
        "CoCalc's Voluntary Product Accessibility Template (VPAT) describes how we address accessibility issues.",
      href: contentPath("policies/accessibility"),
      title: "Accessibility",
    },
    {
      description: "Enterprise and institutional agreement overview.",
      href: contentPath("policies/enterprise-terms"),
      title: "Enterprise terms",
    },
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
  config?: ContentConfig;
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
  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <div>
        <LinkButton href={contentPath("policies")}>Back to policies</LinkButton>
      </div>
      <MarkdownCard value={markdown} />
    </div>
  );
}

function StructuredPolicyPage({ slug }: { slug?: string }) {
  if (getExactPolicyPage(slug) != null) {
    return <ExactPolicyPage slug={slug} />;
  }

  const page = getPolicyPage(slug);
  if (page == null) {
    return <EmptyCard label="This policy page was not found." />;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <LinkButton href={contentPath("policies")}>Back to policies</LinkButton>
      </div>
      <PublicSectionCard>
        <Text strong type="secondary">
          POLICY
        </Text>
        <Title level={2} style={{ margin: 0 }}>
          {page.title}
        </Title>
        {page.updated ? (
          <Text type="secondary">Last updated: {page.updated}</Text>
        ) : null}
        <Paragraph style={{ margin: 0 }}>{page.summary}</Paragraph>
      </PublicSectionCard>
      {page.sections.map((section) => (
        <PublicSectionCard key={section.title}>
          <Title level={3} style={{ margin: 0 }}>
            {section.title}
          </Title>
          {section.paragraphs?.map((paragraph) => (
            <Paragraph key={paragraph} style={{ margin: 0 }}>
              {paragraph}
            </Paragraph>
          ))}
          {section.bullets?.length ? (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {section.bullets.map((bullet) => (
                <li key={bullet} style={{ marginBottom: 8 }}>
                  {bullet}
                </li>
              ))}
            </ul>
          ) : null}
          {section.links?.length ? (
            <Flex wrap gap={12}>
              {section.links.map((link) => (
                <LinkButton
                  key={`${section.title}-${link.href}`}
                  href={link.href}
                >
                  {link.label}
                </LinkButton>
              ))}
            </Flex>
          ) : null}
        </PublicSectionCard>
      ))}
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
        <LinkButton href={contentPath("news/rss.xml")}>RSS</LinkButton> or{" "}
        <LinkButton href={contentPath("news/feed.json")}>JSON Feed</LinkButton>.
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

export default function PublicContentApp({
  config,
  initialMembershipTiers,
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
        config={config}
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
        config={config}
        route={initialRoute}
        subtitle={`Meet the people behind ${siteName}.`}
        title={title}
      >
        <AboutTeamPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "about-team-member") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle={`Meet the people behind ${siteName}.`}
        title={title}
      >
        <AboutTeamMemberPage slug={initialRoute.teamSlug} />
      </PageShell>
    );
  }

  if (initialRoute.view === "about-status") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle={`Live activity and current usage metrics for ${siteName}.`}
        title={title}
      >
        <AboutStatusPage siteName={siteName} />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies-imprint") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle="Deployment-specific imprint information."
        title={title}
      >
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
      <PageShell
        config={config}
        route={initialRoute}
        subtitle="Deployment-specific policy information configured by admins."
        title={title}
      >
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
      <PageShell
        config={config}
        route={initialRoute}
        subtitle="Public legal and compliance information for this deployment."
        title={title}
      >
        <PoliciesHome config={config ?? {}} />
      </PageShell>
    );
  }

  if (initialRoute.view === "policies-detail") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle="Public legal and compliance information for this deployment."
        title={title}
      >
        {!arePoliciesVisible(config) || getExternalPoliciesUrl(config) ? (
          <PolicyGateCard config={config} />
        ) : (
          <StructuredPolicyPage slug={initialRoute.policySlug} />
        )}
      </PageShell>
    );
  }

  if (
    initialRoute.view === "news-detail" ||
    initialRoute.view === "news-history"
  ) {
    return (
      <PageShell
        config={config}
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
        config={config}
        route={initialRoute}
        subtitle={`News and release notes for ${siteName}.`}
        title={title}
      >
        <NewsListPage initialNews={initialNews} isAdmin={!!config?.is_admin} />
      </PageShell>
    );
  }

  if (initialRoute.view === "software-cocalc-plus") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle="The local single-user CoCalc experience for your own machine."
        title={title}
      >
        <CocalcPlusPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "software-cocalc-launchpad") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle="The lightweight self-hosted control-plane bundle for small teams."
        title={title}
      >
        <CocalcLaunchpadPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "software") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle="Hosted, local, and self-hosted ways to run CoCalc."
        title={title}
      >
        <SoftwareOverviewPage />
      </PageShell>
    );
  }

  if (initialRoute.view === "pricing") {
    return (
      <PageShell
        config={config}
        route={initialRoute}
        subtitle={`Memberships, vouchers, course purchasing, and self-hosted deployment options for ${siteName}.`}
        title={title}
      >
        <PricingPage
          isAuthenticated={!!config?.is_authenticated}
          siteName={siteName}
          tiers={initialMembershipTiers}
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      config={config}
      route={initialRoute}
      subtitle={`Background information and public resources for ${siteName}.`}
      title={title}
    >
      <AboutHome helpEmail={config?.help_email} siteName={siteName} />
    </PageShell>
  );
}
