/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";

import { Button, Flex, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PublicGrid,
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { navigatePublic } from "../navigation";
import type { PublicSupportRoute, SupportView } from "./routes";
import { COLORS, HELP_EMAIL, SITE_NAME } from "@cocalc/util/theme";

const { Paragraph } = Typography;

const CommunityView = lazy(() => import("./community-view"));
const SupportNew = lazy(() => import("./new-view"));
const SupportTickets = lazy(() => import("./tickets-view"));

interface SupportConfig {
  help_email?: string;
  is_authenticated?: boolean;
  logo_square?: string;
  on_cocalc_com?: boolean;
  site_name?: string;
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

function titleForView(view: SupportView, siteName: string): string {
  switch (view) {
    case "new":
      return `Create a ${siteName} Support Ticket`;
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
  const helpEmail = config.help_email ?? HELP_EMAIL;
  const hasZendesk = !!config.zendesk;

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
        We provide direct support, documentation, and contact options. Use the
        links below to open a ticket, review ticket status, or contact us.
      </Paragraph>
      <PublicGrid columns={3}>
        {hasZendesk ? (
          <SupportCard
            description="Create a new support ticket."
            title="New support ticket"
          >
            <Button type="primary" onClick={() => onNavigate("new")}>
              Open ticket form
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
          title="Email"
        >
          <a href={`mailto:${helpEmail}`} style={{ color: COLORS.BLUE_D }}>
            {helpEmail}
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
  const title = useMemo(
    () => titleForView(view, config.site_name ?? SITE_NAME),
    [config.site_name, view],
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
    <PublicPage active="support" config={config} title={title}>
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
          <SupportIndex config={config} onNavigate={navigate} />
        ) : null}
        {view === "new" ? (
          <Suspense
            fallback={<PublicSection>Loading support form…</PublicSection>}
          >
            <SupportNew config={config} onNavigate={navigate} />
          </Suspense>
        ) : null}
        {view === "tickets" ? (
          <Suspense fallback={<PublicSection>Loading tickets…</PublicSection>}>
            <SupportTickets config={config} />
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
