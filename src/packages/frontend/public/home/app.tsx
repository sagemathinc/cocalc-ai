/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect, useState } from "react";

import { Button, Flex, Modal, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  getPublicMarketingConfig,
  getPublicMarketingSiteName,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import { PublicPage } from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  publicAccent,
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
  PUBLIC_WEIGHT,
} from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  getPublicHomeHighlights,
  PUBLIC_HOME_EYEBROW,
  PUBLIC_HOME_HEADLINE,
  PUBLIC_HOME_INTRO,
  PUBLIC_HOME_SECONDARY_CTA,
  PUBLIC_HOME_TRUST_LINE,
} from "@cocalc/util/public-home-content";
import { joinUrlPath } from "@cocalc/util/url-path";
import { builtinPolicyPath } from "../common";

const { Paragraph, Text, Title } = Typography;

interface HomeConfig extends PublicConfig {
  site_description?: string;
}

const HERO_IMAGE_URL = "/public/landing/project-notebook-20260916.jpg";
const PUBLIC_PAGE_GUTTER = "max(16px, calc((100vw - 1200px) / 2))";
const PANEL_RADIUS = 8;
const CARD_TITLE_STYLE = {
  fontSize: PUBLIC_TYPE.lead,
  lineHeight: 1.25,
  margin: "0 0 8px",
};
const DIFFERENCE_CARD_TITLE_STYLE = {
  ...CARD_TITLE_STYLE,
  margin: "8px 0",
};

const HOME_PAGE_CSS = `
  .cocalc-public-home {
    color: ${PUBLIC_COLORS.text};
  }

  .cocalc-public-home a {
    transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
  }

  .cocalc-public-home > section {
    scroll-margin-top: 76px;
  }

  .cocalc-public-home-card-link:hover {
    border-color: ${PUBLIC_COLORS.linkHover} !important;
    box-shadow: 0 18px 44px ${alpha(PUBLIC_COLORS.shadowInk, 0.1)} !important;
    transform: translateY(-1px);
  }

  .cocalc-public-home-hero-image {
    max-width: 100%;
  }

  @media (max-width: 920px) {
    .cocalc-public-home-hero,
    .cocalc-public-home-difference {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .cocalc-public-home-hero-title {
      font-size: 42px !important;
      line-height: 1.08 !important;
    }

    .cocalc-public-home-hero-visual {
      order: 2;
    }
  }

  @media (max-width: 1120px) {
    .cocalc-public-home-final-layout {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }

  @media (max-width: 620px) {
    .cocalc-public-home-final-actions {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .cocalc-public-home-final-actions .ant-btn {
      width: 100%;
    }
  }

  @media (max-width: 560px) {
    .cocalc-public-home {
      gap: 28px !important;
    }

    .cocalc-public-home-hero-title {
      font-size: 34px !important;
    }

    .cocalc-public-home-actions .ant-btn,
    .cocalc-public-home-final-actions .ant-btn {
      width: 100%;
    }

    .cocalc-public-home-codex-grid,
    .cocalc-public-home-difference-grid,
    .cocalc-public-home-modal-grid,
    .cocalc-public-home-final-actions {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }
`;

const PROJECT_FACTS = [
  {
    body: "Teammates continue from the same project state instead of reconstructing work from scattered tools.",
    title: "Context survives handoff",
  },
  {
    body: "The project record stays available when someone returns to inspect or extend the work.",
    title: "Review stays close",
  },
  {
    body: "Snapshots, backups, and project history make useful states easier to recover.",
    title: "Recovery remains practical",
  },
] as const;

const AGENT_DEFINITION_CARDS = [
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "Codex works in project chat, while terminal-based agents run beside the files, notebooks, terminals, and services they need.",
    icon: "robot",
    title: "Work with files and services",
  },
  {
    accent: COLORS.RUN,
    body: "Patches, notes, and run output stay visible in the project, so your team can inspect the work.",
    icon: "search",
    title: "Review agent changes",
  },
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Use the integrated Codex agent or Claude Code (experimental preview, where enabled), or run other command-line agents in a terminal, without moving the project somewhere else.",
    icon: "terminal",
    title: "Integrated chat or terminal",
  },
] satisfies Array<{
  accent: string;
  body: string;
  icon: IconName;
  title: string;
}>;

const DIFFERENCE_SIGNALS = [
  { icon: "files", label: "Shared context" },
  { icon: "users", label: "Collaboration" },
  { icon: "history", label: "Review history" },
  { icon: "disk-snapshot", label: "Recovery paths" },
] satisfies Array<{ icon: IconName; label: string }>;

const DIFFERENTIATORS = [
  {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    body: "Keep the main artifacts of computational work near the discussions, outputs, and decisions they produce.",
    ctaHref: "docs/projects/project-list",
    ctaLabel: "Read project docs",
    details: PROJECT_FACTS,
    eyebrow: "Project continuity",
    icon: "project-outlined",
    modalBody:
      "CoCalc projects keep notebooks, files, outputs, documents, terminals, and agent-assisted work in one durable workspace, so the work remains understandable over time.",
    title: "Project-centered workflow",
  },
  {
    accent: COLORS.RUN,
    body: "Review live collaboration and AI-assisted changes in the project before teammates build on them.",
    ctaHref: "docs/collaboration/chat",
    ctaLabel: "Read chat docs",
    details: [
      {
        body: "Realtime editing, chat, and shared outputs help collaborators compare results and decide how to move forward.",
        title: "Review together",
      },
      {
        body: "Codex edits, patches, test output, screenshots, and review notes stay beside affected files.",
        title: "Inspect exact changes",
      },
      {
        body: "Reasoning, commands, outputs, and follow-up questions stay with the project.",
        title: "Keep evidence together",
      },
    ],
    eyebrow: "Review together",
    icon: "search",
    modalBody:
      "CoCalc keeps collaboration, AI-assisted edits, notebooks, terminals, outputs, screenshots, and discussion in the project, so people can review the work before relying on it.",
    title: "Inspection before handoff",
  },
  {
    accent: COLORS.AI_ASSISTANT_FONT,
    body: "History, TimeTravel, snapshots, and backups help teams understand changes and return to useful states.",
    ctaHref: "docs/files/timetravel",
    ctaLabel: "Read TimeTravel docs",
    details: [
      {
        body: "Project history shows how notebooks, files, documents, and outputs changed.",
        title: "Trace what changed",
      },
      {
        body: "Snapshots and backups let teams resume from a known project state.",
        title: "Recover useful states",
      },
      {
        body: "Files, notes, outputs, and discussion keep recovery tied to the project record.",
        title: "Resume with context",
      },
    ],
    eyebrow: "Keep moving",
    icon: "history",
    modalBody:
      "CoCalc keeps history, TimeTravel, snapshots, backups, and project context together so teams can return to useful states and continue with less guesswork.",
    title: "Practical recovery",
  },
  {
    accent: COLORS.GRAY_M,
    body: "Review different product paths when infrastructure, governance, or support needs shape the decision.",
    ctaHref: "products",
    ctaLabel: "Review product paths",
    details: [
      {
        body: "Choose hosted, local, single-VM, or organization-operated deployment.",
        title: "Match where it runs",
      },
      {
        body: "Compare upgrades, data boundaries, licensing, governance, and support.",
        title: "Keep ownership clear",
      },
      {
        body: "Use the product comparison for procurement, security, platform, and support questions.",
        title: "Route the next conversation",
      },
    ],
    eyebrow: "Choose where it runs",
    icon: "cloud",
    modalBody:
      "CoCalc product paths are choices about where the workspace runs and who operates it, from hosted CoCalc.ai through local, single-VM, private, and enterprise deployments.",
    title: "Operating model choice",
  },
] satisfies Array<{
  accent: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
  details: ReadonlyArray<{
    body: string;
    title: string;
  }>;
  eyebrow: string;
  icon: IconName;
  modalBody: string;
  title: string;
}>;

function accessibleAccentTextColor(accent: string): string {
  if (accent === COLORS.RUN) return publicAccent(COLORS.ANTD_GREEN_D);
  if (accent === COLORS.AI_ASSISTANT_FONT) return publicAccent(COLORS.BRWN);
  if (accent === PUBLIC_COLORS.link) return PUBLIC_COLORS.linkHover;
  return publicAccent(accent);
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text
      strong
      style={{
        color: PUBLIC_COLORS.linkHover,
        display: "block",
        fontSize: 12,
        letterSpacing: 0,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

function IconTile({
  accent,
  icon,
  size = 42,
}: {
  accent: string;
  icon: IconName;
  size?: number;
}) {
  accent = publicAccent(accent);
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: alpha(accent, 0.1),
        border: `1px solid ${alpha(accent, 0.22)}`,
        borderRadius: PANEL_RADIUS,
        color: accent,
        display: "inline-flex",
        flex: `0 0 ${size}px`,
        fontSize: Math.max(16, Math.round(size * 0.45)),
        height: size,
        justifyContent: "center",
        width: size,
      }}
    >
      <Icon name={icon} />
    </span>
  );
}

function DecorativeButtonIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <Icon name={name} />
    </span>
  );
}

function SectionIntro({
  eyebrow,
  title,
  body,
}: {
  body?: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
}) {
  return (
    <Flex align="end" justify="space-between" wrap gap={16}>
      <div style={{ maxWidth: 760 }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Title level={2} style={{ margin: "8px 0 10px" }}>
          {title}
        </Title>
        {body == null ? null : (
          <Paragraph style={{ fontSize: 18, margin: 0 }}>{body}</Paragraph>
        )}
      </div>
    </Flex>
  );
}

function Hero({
  authenticated,
  highlights,
  siteName,
}: {
  authenticated: boolean;
  highlights: readonly string[];
  siteName: string;
}) {
  return (
    <section
      aria-label={`${siteName} hero`}
      className="cocalc-public-home-hero"
      style={{
        alignItems: "center",
        display: "grid",
        gap: 42,
        gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 1fr)",
        padding: "32px 0 12px",
      }}
    >
      <Flex vertical gap={20}>
        <Eyebrow>{PUBLIC_HOME_EYEBROW}</Eyebrow>
        <div>
          <Title
            className="cocalc-public-home-hero-title"
            level={1}
            style={{
              color: PUBLIC_COLORS.heading,
              fontSize: 58,
              letterSpacing: 0,
              lineHeight: 1.02,
              margin: 0,
              maxWidth: 620,
            }}
          >
            {PUBLIC_HOME_HEADLINE}
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              fontSize: 19,
              lineHeight: 1.5,
              margin: "20px 0 0",
              maxWidth: 590,
            }}
          >
            {PUBLIC_HOME_INTRO}
          </Paragraph>
        </div>
        <Flex className="cocalc-public-home-actions" gap={12} wrap>
          <Button
            href={appPath(authenticated ? "projects" : "auth/sign-up")}
            icon={
              <DecorativeButtonIcon
                name={authenticated ? "project-outlined" : "rocket"}
              />
            }
            size="large"
            type="primary"
          >
            {authenticated ? "Open projects" : "Start on CoCalc.ai"}
          </Button>
          <Button href={appPath(PUBLIC_HOME_SECONDARY_CTA.href)} size="large">
            {PUBLIC_HOME_SECONDARY_CTA.label}
          </Button>
        </Flex>
        <ul
          className="cocalc-public-home-highlights"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          {highlights.map((highlight) => (
            <li
              key={highlight}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.pill,
                color: PUBLIC_COLORS.heading,
                fontSize: PUBLIC_TYPE.caption,
                fontWeight: PUBLIC_WEIGHT.medium,
                lineHeight: 1.4,
                padding: "5px 12px",
              }}
            >
              {highlight}
            </li>
          ))}
        </ul>
        <Paragraph
          className="cocalc-public-home-trust-line"
          style={{
            color: PUBLIC_COLORS.mutedText,
            fontSize: PUBLIC_TYPE.caption,
            margin: 0,
          }}
        >
          {PUBLIC_HOME_TRUST_LINE}
        </Paragraph>
      </Flex>
      <figure className="cocalc-public-home-hero-visual" style={{ margin: 0 }}>
        <img
          alt="A saved CoCalc Jupyter notebook with synthetic runtime results and TimeTravel and Agent controls"
          className="cocalc-public-home-hero-image"
          decoding="async"
          src={HERO_IMAGE_URL}
          style={{
            aspectRatio: "1050 / 650",
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PANEL_RADIUS,
            boxShadow: `0 18px 44px ${alpha(PUBLIC_COLORS.shadowInk, 0.08)}`,
            display: "block",
            objectFit: "contain",
            width: "100%",
          }}
        />
      </figure>
    </section>
  );
}

function AgentDefinitionSection() {
  return (
    <section
      aria-label="AI agents in CoCalc"
      style={{ padding: "22px 0 24px" }}
    >
      <SectionIntro
        body="Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals, all with the files, tools, and running services your collaborators already use. Claude Code is an experimental preview on sites that enable it and works with your personal Claude Pro or Max subscription."
        eyebrow="Agent-ready by design"
        title="Give AI agents the files and tools they need."
      />
      <Flex gap={12} style={{ marginTop: 18 }} wrap>
        <Button href={appPath("features/ai")}>See agent workflows</Button>
        <Button href={appPath("features/compare")}>
          Compare with agent sandboxes
        </Button>
      </Flex>
      <div
        className="cocalc-public-home-codex-grid"
        style={{
          display: "grid",
          gap: 18,
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          marginTop: 22,
        }}
      >
        {AGENT_DEFINITION_CARDS.map((card) => (
          <div
            key={card.title}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${alpha(card.accent, 0.18)}`,
              borderRadius: PANEL_RADIUS,
              boxShadow: `0 10px 30px ${alpha(PUBLIC_COLORS.shadowInk, 0.05)}`,
              minHeight: 190,
              padding: 18,
            }}
          >
            <Flex vertical gap={14}>
              <IconTile accent={card.accent} icon={card.icon} />
              <div>
                <Title level={3} style={CARD_TITLE_STYLE}>
                  {card.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>{card.body}</Paragraph>
              </div>
            </Flex>
          </div>
        ))}
      </div>
    </section>
  );
}

function DifferenceSection() {
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const activeItem =
    DIFFERENTIATORS.find((item) => item.title === activeTitle) ?? null;

  return (
    <>
      <section
        aria-label="Why CoCalc is different"
        className="cocalc-public-home-difference"
        style={{
          background: `linear-gradient(135deg, ${PUBLIC_COLORS.surfaceMuted} 0%, ${PUBLIC_COLORS.surface} 100%)`,
          border: `1px solid ${PUBLIC_COLORS.border}`,
          borderRadius: PANEL_RADIUS,
          display: "grid",
          gap: 34,
          gridTemplateColumns: "minmax(0, 0.7fr) minmax(0, 1.3fr)",
          margin: "16px 0",
          padding: 36,
        }}
      >
        <Flex vertical gap={18}>
          <div>
            <Eyebrow>Why CoCalc is different</Eyebrow>
            <Title level={2} style={{ margin: "8px 0 10px" }}>
              The project is the computer.
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Every CoCalc project is a persistent Linux environment for files,
              computation, services, collaboration, history, and recovery. The
              people and agents working there share the same state.
            </Paragraph>
          </div>
          <div
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PANEL_RADIUS,
              display: "grid",
              gap: 10,
              padding: 14,
            }}
          >
            {DIFFERENCE_SIGNALS.map((signal) => (
              <Flex align="center" gap={10} key={signal.label}>
                <IconTile
                  accent={PUBLIC_COLORS.link}
                  icon={signal.icon}
                  size={28}
                />
                <Text strong>{signal.label}</Text>
              </Flex>
            ))}
          </div>
        </Flex>
        <div
          className="cocalc-public-home-difference-grid"
          style={{
            display: "grid",
            gap: 18,
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          }}
        >
          {DIFFERENTIATORS.map((item) => (
            <button
              aria-haspopup="dialog"
              className="cocalc-public-home-card-link cocalc-public-home-difference-card"
              key={item.title}
              onClick={() => setActiveTitle(item.title)}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PANEL_RADIUS,
                color: "inherit",
                cursor: "pointer",
                minHeight: 240,
                padding: 22,
                textAlign: "left",
              }}
              type="button"
            >
              <Flex vertical gap={14}>
                <IconTile accent={item.accent} icon={item.icon} />
                <div>
                  <Text
                    strong
                    style={{
                      color: accessibleAccentTextColor(item.accent),
                      display: "block",
                      fontSize: 12,
                      textTransform: "uppercase",
                    }}
                  >
                    {item.eyebrow}
                  </Text>
                  <Title level={3} style={DIFFERENCE_CARD_TITLE_STYLE}>
                    {item.title}
                  </Title>
                  <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
                </div>
                <Text strong style={{ color: PUBLIC_COLORS.link }}>
                  View details
                </Text>
              </Flex>
            </button>
          ))}
        </div>
      </section>
      <Modal
        footer={null}
        onCancel={() => setActiveTitle(null)}
        open={activeItem != null}
        title={activeItem?.title}
        width={720}
      >
        {activeItem == null ? null : (
          <Flex vertical gap={18}>
            <Paragraph style={{ fontSize: 16, margin: 0 }}>
              {activeItem.modalBody}
            </Paragraph>
            <div
              className="cocalc-public-home-modal-grid"
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              }}
            >
              {activeItem.details.map((detail) => (
                <div
                  key={detail.title}
                  style={{
                    background: PUBLIC_COLORS.surfaceMuted,
                    border: `1px solid ${PUBLIC_COLORS.border}`,
                    borderRadius: PANEL_RADIUS,
                    padding: 14,
                  }}
                >
                  <Text strong>{detail.title}</Text>
                  <Paragraph style={{ margin: "8px 0 0" }}>
                    {detail.body}
                  </Paragraph>
                </div>
              ))}
            </div>
            <Button href={appPath(activeItem.ctaHref)} type="primary">
              {activeItem.ctaLabel}
            </Button>
          </Flex>
        )}
      </Modal>
    </>
  );
}

function PathSection({
  authenticated,
  trustHref,
}: {
  authenticated: boolean;
  trustHref?: string;
}) {
  return (
    <section
      aria-label="Next step"
      style={{
        background: `linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.warningTint} 100%)`,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PANEL_RADIUS,
        margin: "16px 0 0",
        padding: 36,
      }}
    >
      <div
        className="cocalc-public-home-final-layout"
        style={{
          alignItems: "center",
          display: "grid",
          gap: 24,
          gridTemplateColumns: "minmax(0, 1fr) auto",
        }}
      >
        <div>
          <Eyebrow>Next step</Eyebrow>
          <Title level={2} style={{ margin: "8px 0 10px" }}>
            Ready to choose how CoCalc fits?
          </Title>
          <Paragraph style={{ fontSize: 17, margin: 0, maxWidth: 760 }}>
            Start with CoCalc.ai, review the product paths, or open support and
            sales options when licensing, procurement, support, or private
            deployment are part of the decision.
          </Paragraph>
          {trustHref ? (
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: 14,
                margin: "10px 0 0",
                maxWidth: 760,
              }}
            >
              <a href={trustHref}>Review trust and compliance</a>
            </Paragraph>
          ) : null}
        </div>
        <div
          className="cocalc-public-home-final-actions"
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(3, max-content)",
          }}
        >
          <Button
            href={authenticated ? appPath("projects") : appPath("auth/sign-up")}
            type="primary"
          >
            {authenticated ? "Open projects" : "Start on CoCalc.ai"}
          </Button>
          <Button href={appPath("products")}>Review product paths</Button>
          <Button href={appPath("support")}>Review support and sales</Button>
        </div>
      </div>
    </section>
  );
}

// Resolve a missing host only after branding has arrived. A canonical host
// alone does not establish that a deployment uses the default CoCalc brand.
function withSiteHost(config?: HomeConfig): HomeConfig | undefined {
  if (
    !config?.site_name?.trim() ||
    config.dns?.trim() ||
    typeof window === "undefined"
  ) {
    return config;
  }
  return { ...config, dns: window.location.host };
}

export default function PublicHomeApp({ config }: { config?: HomeConfig }) {
  const marketingConfig = getPublicMarketingConfig(config) as
    | HomeConfig
    | undefined;
  const siteName = getPublicMarketingSiteName(config);
  const authenticated = !!config?.is_authenticated;
  const trustHref = builtinPolicyPath(config, "trust");

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = siteName;
  }, [siteName]);

  return (
    <PublicPage active="home" config={marketingConfig}>
      <style>{HOME_PAGE_CSS}</style>
      <div
        className="cocalc-public-home"
        style={{
          display: "grid",
          gap: 34,
          marginInline: `calc(${PUBLIC_PAGE_GUTTER} * -1)`,
          paddingInline: PUBLIC_PAGE_GUTTER,
        }}
      >
        <Hero
          authenticated={authenticated}
          highlights={getPublicHomeHighlights(withSiteHost(config))}
          siteName={siteName}
        />
        <AgentDefinitionSection />
        <DifferenceSection />
        <PathSection authenticated={authenticated} trustHref={trustHref} />
      </div>
    </PublicPage>
  );
}
