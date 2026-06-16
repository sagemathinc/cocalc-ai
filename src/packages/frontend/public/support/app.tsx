/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";

import { Button, Flex, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  getPublicMarketingConfig,
  getPublicMarketingSiteName,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import { builtinPolicyPath } from "../common";
import {
  PublicGrid,
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { navigatePublic } from "../navigation";
import type { PublicSupportRoute, SupportView } from "./routes";
import { COLORS, HELP_EMAIL } from "@cocalc/util/theme";

const { Paragraph } = Typography;

const CommunityView = lazy(() => import("./community-view"));
const SupportNew = lazy(() => import("./new-view"));
const SupportTickets = lazy(() => import("./tickets-view"));

interface SupportConfig extends PublicConfig {
  support?: string;
  support_video_call?: string;
  zendesk?: boolean;
}

interface PublicSupportAppProps {
  config?: SupportConfig;
  initialRoute: PublicSupportRoute;
}

function appPath(path: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}${path}`;
}

function supportPath(view: SupportView): string {
  switch (view) {
    case "new":
      return appPath("/support/new");
    case "tickets":
      return appPath("/support/tickets");
    case "community":
      return appPath("/support/community");
    default:
      return appPath("/support");
  }
}

function titleForView(
  view: SupportView,
  siteName: string,
  zendesk: boolean,
): string {
  switch (view) {
    case "new":
      return zendesk
        ? `Create a ${siteName} Support Ticket`
        : `Contact ${siteName} Support`;
    case "tickets":
      return `${siteName} Support Tickets`;
    case "community":
      return `${siteName} Community Support`;
    default:
      return `${siteName} Support`;
  }
}

function SupportCard({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <PublicSection>
      <div style={{ fontWeight: 700, fontSize: "18px" }}>{title}</div>
      <div style={{ color: COLORS.GRAY }}>{description}</div>
      <div>{children}</div>
    </PublicSection>
  );
}

function SupportIndex({
  config,
  onNavigate,
}: {
  config: SupportConfig;
  onNavigate: (view: SupportView) => void;
}) {
  const helpEmail = config.help_email?.trim() || HELP_EMAIL;
  const hasZendesk = !!config.zendesk;
  const privacyHref = builtinPolicyPath(config, "privacy");
  const trustHref = builtinPolicyPath(config, "trust");

  if (!config.on_cocalc_com && config.support) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <div
          style={{
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 14,
            background: "#e6f4ff",
            border: "1px solid #91caff",
            color: "#0958d9",
          }}
        >
          {config.support}
        </div>
        <div>
          Need more help?{" "}
          <a href={`mailto:${helpEmail}`} style={{ color: COLORS.BLUE_D }}>
            Contact {helpEmail}
          </a>
          .
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Paragraph style={{ fontSize: "16px", margin: 0 }}>
        Use support when you need help choosing how CoCalc should run, planning
        licensing or deployment, clarifying support, privacy, security, or
        data-location questions, or resolving an existing account or project
        issue.
      </Paragraph>
      {trustHref || privacyHref ? (
        <Flex aria-label="Support trust materials" gap={12} role="group" wrap>
          {trustHref ? (
            <Button href={trustHref}>Review trust materials</Button>
          ) : null}
          {privacyHref ? (
            <Button href={privacyHref}>Review privacy policy</Button>
          ) : null}
        </Flex>
      ) : null}
      <PublicGrid columns={3}>
        <SupportCard
          description="Compare hosted, local, single-VM, and private deployment options before opening a conversation."
          title="Choose an operating model"
        >
          <Button href={appPath("/products")}>Compare operating models</Button>
        </SupportCard>
        <SupportCard
          description="Review hosted plans, site licensing, and organizational buying routes before asking for a quote."
          title="Pricing and licensing"
        >
          <Button href={appPath("/pricing")}>Review pricing</Button>
        </SupportCard>
        {hasZendesk ? (
          <SupportCard
            description="Start here when you are ready to ask about pricing, deployment boundaries, site licensing, support expectations, or an existing account or project issue."
            title="Talk with CoCalc"
          >
            <Button type="primary" onClick={() => onNavigate("new")}>
              Start support request
            </Button>
          </SupportCard>
        ) : null}
        {hasZendesk ? (
          <SupportCard
            description="Check the status of your recent support tickets."
            title="Ticket status"
          >
            <Button onClick={() => onNavigate("tickets")}>View tickets</Button>
          </SupportCard>
        ) : null}
        {config.support_video_call ? (
          <SupportCard
            description="Book a video call with the CoCalc team."
            title="Video chat"
          >
            <a
              href={config.support_video_call}
              style={{ color: COLORS.BLUE_D }}
            >
              Book a call
            </a>
          </SupportCard>
        ) : null}
        <SupportCard
          description="Join discussions and public community channels."
          title="Community"
        >
          <Button onClick={() => onNavigate("community")}>
            Open community
          </Button>
        </SupportCard>
        <SupportCard
          description="Browse user and admin documentation."
          title="Documentation"
        >
          <a href={appPath("/docs")} style={{ color: COLORS.BLUE_D }}>
            Read the docs
          </a>
        </SupportCard>
        <SupportCard
          description="Reach the team directly by email."
          title={hasZendesk ? "Email" : "Talk with CoCalc"}
        >
          <a href={`mailto:${helpEmail}`} style={{ color: COLORS.BLUE_D }}>
            {hasZendesk ? helpEmail : "Email CoCalc"}
          </a>
        </SupportCard>
      </PublicGrid>
    </div>
  );
}

export default function PublicSupportApp({
  config = {},
  initialRoute,
}: PublicSupportAppProps) {
  const [view, setView] = useState(initialRoute.view);
  const marketingConfig = getPublicMarketingConfig(config) as
    | SupportConfig
    | undefined;
  const siteName = getPublicMarketingSiteName(config);
  const hasZendesk = !!config.zendesk;
  const title = useMemo(
    () => titleForView(view, siteName, hasZendesk),
    [hasZendesk, siteName, view],
  );

  useEffect(() => {
    setView(initialRoute.view);
  }, [initialRoute]);

  useEffect(() => {
    document.title = title;
  }, [title]);

  function navigate(next: SupportView) {
    setView(next);
    navigatePublic(supportPath(next));
  }

  return (
    <PublicPage active="support" config={marketingConfig} title={title}>
      {view !== "index" ? (
        <Flex wrap gap={8}>
          <Button onClick={() => navigate("index")}>Support</Button>
          {config.zendesk ? (
            <Button
              type={view === "new" ? "primary" : "default"}
              onClick={() => navigate("new")}
            >
              New ticket
            </Button>
          ) : null}
          {config.zendesk ? (
            <Button
              type={view === "tickets" ? "primary" : "default"}
              onClick={() => navigate("tickets")}
            >
              My tickets
            </Button>
          ) : null}
          <Button
            type={view === "community" ? "primary" : "default"}
            onClick={() => navigate("community")}
          >
            Community
          </Button>
        </Flex>
      ) : null}
      <div style={{ marginTop: 24 }}>
        {view === "index" ? (
          <SupportIndex
            config={marketingConfig ?? config}
            onNavigate={navigate}
          />
        ) : null}
        {view === "new" ? (
          <Suspense
            fallback={<PublicSection>Loading support form…</PublicSection>}
          >
            <SupportNew
              config={marketingConfig ?? config}
              onNavigate={navigate}
            />
          </Suspense>
        ) : null}
        {view === "tickets" ? (
          <Suspense fallback={<PublicSection>Loading tickets…</PublicSection>}>
            <SupportTickets config={marketingConfig ?? config} />
          </Suspense>
        ) : null}
        {view === "community" ? (
          <Suspense
            fallback={<PublicSection>Loading community links…</PublicSection>}
          >
            <CommunityView />
          </Suspense>
        ) : null}
      </div>
    </PublicPage>
  );
}
