/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Fragment, Suspense, lazy, useEffect, useState } from "react";

import { Button, Flex, Tag, Typography } from "antd";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import {
  getPublicAboutIntro,
  PUBLIC_ABOUT_AUDIENCES,
  PUBLIC_ABOUT_HEADLINE,
  PUBLIC_ABOUT_PRINCIPLES,
  PUBLIC_ABOUT_PRINCIPLES_HEADLINE,
  PUBLIC_ABOUT_REASON,
  PUBLIC_TEAM_BILLING_CONTACT,
  type PublicAboutTextPart,
} from "@cocalc/util/public-about-content";
import { isPublicCocalcAiSite } from "@cocalc/util/public-home-content";
import type { NewsItem } from "@cocalc/util/types/news";

import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
  PUBLIC_WEIGHT,
} from "../theme";
import {
  appPath,
  EmptySection,
  fetchJson,
  getPublicMarketingSiteName,
  LinkButton,
  LoadingSection,
  MUTED_STYLE,
  PublicNextStep,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { PublicCard, PublicGrid, PublicSection } from "../layout/shell";
import { publicPath } from "../routes";
import {
  getTeamMember,
  TEAM_MEMBERS,
  type TeamMemberProfile,
} from "./team-data";
import type { PublicAboutRoute } from "./routes";
import { formatNewsDate } from "../news/utils";

const { Paragraph, Title } = Typography;
const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));

interface EventsPayload {
  past?: NewsItem[];
  upcoming?: NewsItem[];
}

function titleForRoute(route: PublicAboutRoute, siteName: string): string {
  switch (route.view) {
    case "about-events":
      return `${siteName} Events`;
    case "about-team":
      return "Meet the People Behind CoCalc";
    case "about-team-member":
      return (() => {
        const member = getTeamMember(route.teamSlug);
        return member ? `${member.name}, ${member.title}` : "Team";
      })();
    case "about":
    default:
      return "About CoCalc";
  }
}

const ABOUT_PAGE_CSS = `
  .cocalc-about-index {
    display: grid;
    gap: 56px;
    padding-bottom: 20px;
  }

  .cocalc-about-index > section {
    scroll-margin-top: var(--cocalc-public-anchor-offset);
  }

  .cocalc-about-hero {
    background:
      radial-gradient(circle at 88% 18%, ${alpha(PUBLIC_COLORS.accent, 0.22)}, transparent 28%),
      radial-gradient(circle at 72% 90%, ${alpha(PUBLIC_COLORS.brand, 0.3)}, transparent 38%),
      linear-gradient(135deg, ${PUBLIC_COLORS.brandDark} 0%, ${PUBLIC_COLORS.heroBackground} 100%);
    border-radius: ${PUBLIC_RADIUS.media}px;
    box-shadow: ${PUBLIC_ELEVATION.lg};
    color: ${PUBLIC_COLORS.footerText};
    overflow: hidden;
    padding: clamp(28px, 5vw, 58px);
    position: relative;
  }

  /* The hero stays dark in both themes, so its text links are white. The
     public page CSS underlines them. */
  .cocalc-about-hero .ant-typography a:not(.ant-btn) {
    color: ${PUBLIC_COLORS.onPrimary};
  }

  .cocalc-about-hero .ant-typography a:not(.ant-btn):focus-visible {
    outline: 2px solid ${PUBLIC_COLORS.accent};
    outline-offset: 2px;
  }

  .cocalc-about-founder {
    display: grid;
    gap: 32px;
    grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
  }

  .cocalc-about-principles,
  .cocalc-about-audiences,
  .cocalc-about-facts,
  .cocalc-about-timeline,
  .cocalc-about-team-preview {
    display: grid;
    gap: 16px;
  }

  .cocalc-about-principles,
  .cocalc-about-facts,
  .cocalc-about-timeline {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .cocalc-about-audiences {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .cocalc-about-team-preview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .cocalc-about-founder-photo {
    aspect-ratio: 4 / 3;
    border-radius: ${PUBLIC_RADIUS.media}px;
    box-shadow: ${PUBLIC_ELEVATION.media};
    height: 100%;
    max-height: 410px;
    object-fit: cover;
    width: 100%;
  }

  /* The principle cards hold a few sentences each, too long for three narrow
     columns on tablets or at 200% zoom, so they stack here. */
  @media (max-width: 900px) {
    .cocalc-about-founder,
    .cocalc-about-principles {
      grid-template-columns: 1fr;
    }

    .cocalc-about-audiences,
    .cocalc-about-team-preview {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 620px) {
    .cocalc-about-index {
      gap: 38px;
    }

    .cocalc-about-audiences,
    .cocalc-about-facts,
    .cocalc-about-timeline,
    .cocalc-about-team-preview {
      grid-template-columns: 1fr;
    }
  }
`;

const COMPANY_FACTS = [
  {
    detail: "Independent security audit",
    href: publicPath("policies/trust"),
    value: "SOC 2",
  },
  {
    detail: "Verified privacy program",
    href: publicPath("policies/trust"),
    value: "GDPR",
  },
  { detail: "Hosted and customer-operated", value: "Flexible deployment" },
];

const COMPANY_TIMELINE = [
  {
    body: "SageMathCloud launches, bringing open technical software into a collaborative browser workspace.",
    year: "2013",
  },
  {
    body: "William leaves his full professorship to focus on SageMath, Inc. and CoCalc full-time.",
    year: "2019",
  },
  {
    body: "CoCalc is rebuilt with agents at its core: they work in the same persistent, shared projects as the people who direct them.",
    year: "Today",
  },
];

function Eyebrow({ children }: { children: string }) {
  return (
    <div
      style={{
        color: PUBLIC_COLORS.brandActive,
        fontSize: PUBLIC_TYPE.eyebrow,
        fontWeight: PUBLIC_WEIGHT.bold,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function IconTile({ icon }: { icon: IconName }) {
  return (
    <div
      style={{
        alignItems: "center",
        background: PUBLIC_COLORS.brandTint,
        border: `1px solid ${PUBLIC_COLORS.brandSubtle}`,
        borderRadius: PUBLIC_RADIUS.panel,
        color: PUBLIC_COLORS.brand,
        display: "flex",
        fontSize: 20,
        height: 42,
        justifyContent: "center",
        width: 42,
      }}
    >
      <Icon name={icon} />
    </div>
  );
}

// Shared About text, with its links resolved against the site's base path.
function AboutText({ parts }: { parts: readonly PublicAboutTextPart[] }) {
  return (
    <>
      {parts.map(({ path, text }, index) =>
        path == null ? (
          <Fragment key={index}>{text}</Fragment>
        ) : (
          <a href={publicPath(path)} key={index}>
            {text}
          </a>
        ),
      )}
    </>
  );
}

function AboutOverview({ config }: { config?: PublicConfig }) {
  const founder = getTeamMember("william-stein")!;

  return (
    <div className="cocalc-about-index">
      <style>{ABOUT_PAGE_CSS}</style>
      <section
        aria-label="SageMath, Inc. and CoCalc"
        className="cocalc-about-hero"
      >
        <Flex gap={24} justify="center" vertical>
          <div
            style={{
              color: PUBLIC_COLORS.accent,
              fontSize: PUBLIC_TYPE.eyebrow,
              fontWeight: PUBLIC_WEIGHT.bold,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            SageMath, Inc. · The company behind CoCalc
          </div>
          <div>
            <Title
              level={1}
              style={{
                color: PUBLIC_COLORS.onPrimary,
                fontSize: "clamp(36px, 5vw, 58px)",
                lineHeight: 1.04,
                margin: 0,
                maxWidth: 820,
              }}
            >
              {PUBLIC_ABOUT_HEADLINE}
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.footerText,
                fontSize: PUBLIC_TYPE.lead,
                lineHeight: 1.65,
                margin: "22px 0 0",
                maxWidth: 760,
              }}
            >
              <AboutText
                parts={getPublicAboutIntro(isPublicCocalcAiSite(config))}
              />
            </Paragraph>
          </div>
          <Flex gap={12} wrap>
            <Button href="#how-we-build" size="large" type="primary">
              How we build
            </Button>
            <Button ghost href={publicPath("about/team")} size="large">
              Meet the team
            </Button>
          </Flex>
        </Flex>
      </section>

      <section aria-label="How we build" id="how-we-build">
        <Flex gap={10} style={{ marginBottom: 22 }} vertical>
          <Eyebrow>How we build</Eyebrow>
          <Title level={2} style={{ margin: 0 }}>
            {PUBLIC_ABOUT_PRINCIPLES_HEADLINE}
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              fontSize: PUBLIC_TYPE.lead,
              margin: 0,
              maxWidth: "72ch",
            }}
          >
            {PUBLIC_ABOUT_REASON}
          </Paragraph>
        </Flex>
        <div className="cocalc-about-principles">
          {PUBLIC_ABOUT_PRINCIPLES.map((principle) => (
            <div
              key={principle.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                boxShadow: PUBLIC_ELEVATION.sm,
                padding: 22,
              }}
            >
              <IconTile icon={principle.icon} />
              <Title level={3} style={{ margin: "18px 0 8px" }}>
                {principle.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{principle.body}</Paragraph>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Company maturity and trust">
        <Flex gap={10} style={{ marginBottom: 22 }} vertical>
          <Eyebrow>Built for the long term</Eyebrow>
          <Title level={2} style={{ margin: 0 }}>
            A mature company behind your team and its agents.
          </Title>
          <Paragraph
            style={{
              color: PUBLIC_COLORS.mutedText,
              fontSize: PUBLIC_TYPE.lead,
              margin: 0,
              maxWidth: "72ch",
            }}
          >
            SageMath, Inc. develops and operates CoCalc with the security,
            privacy, deployment flexibility, and operational discipline expected
            by individuals and institutions.
          </Paragraph>
        </Flex>
        <div className="cocalc-about-facts">
          {COMPANY_FACTS.map((fact) => {
            const content = (
              <>
                <div
                  style={{
                    color: PUBLIC_COLORS.heading,
                    fontSize: PUBLIC_TYPE.subhead,
                    fontWeight: PUBLIC_WEIGHT.bold,
                    lineHeight: 1.15,
                  }}
                >
                  {fact.value}
                </div>
                <div
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    fontSize: PUBLIC_TYPE.caption,
                    lineHeight: 1.45,
                    marginTop: 8,
                  }}
                >
                  {fact.detail}
                </div>
              </>
            );
            const style = {
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PUBLIC_RADIUS.panel,
              color: "inherit",
              minHeight: 126,
              padding: 18,
              textDecoration: "none",
            } as const;
            return fact.href ? (
              <a href={fact.href} key={fact.value} style={style}>
                {content}
              </a>
            ) : (
              <div key={fact.value} style={style}>
                {content}
              </div>
            );
          })}
        </div>
        <div
          style={{
            alignItems: "center",
            background: PUBLIC_COLORS.successTint,
            border: `1px solid ${PUBLIC_COLORS.successBorder}`,
            borderRadius: PUBLIC_RADIUS.panel,
            display: "flex",
            flexWrap: "wrap",
            gap: 18,
            justifyContent: "space-between",
            marginTop: 16,
            padding: "18px 22px",
          }}
        >
          <Flex align="center" gap={14}>
            <Icon
              name="lock"
              style={{ color: PUBLIC_COLORS.success, fontSize: 22 }}
            />
            <div>
              <div style={{ fontWeight: PUBLIC_WEIGHT.bold }}>
                Security and privacy are operating requirements.
              </div>
              <div style={{ color: PUBLIC_COLORS.mutedText }}>
                Review independent assurance, privacy commitments, and data
                processing terms.
              </div>
            </div>
          </Flex>
          <Button href={publicPath("policies/trust")}>
            Trust and compliance
          </Button>
        </div>
      </section>

      <section aria-label="Who uses CoCalc">
        <Flex gap={10} style={{ marginBottom: 22 }} vertical>
          <Eyebrow>Who we serve</Eyebrow>
          <Title level={2} style={{ margin: 0 }}>
            From one researcher to an entire institution.
          </Title>
        </Flex>
        <div className="cocalc-about-audiences">
          {PUBLIC_ABOUT_AUDIENCES.map((audience) => (
            <div
              key={audience.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                padding: 20,
              }}
            >
              <IconTile icon={audience.icon} />
              <Title level={3} style={{ margin: "16px 0 8px" }}>
                {audience.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>{audience.body}</Paragraph>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="CoCalc company history">
        <Flex gap={10} style={{ marginBottom: 22 }} vertical>
          <Eyebrow>Our path</Eyebrow>
          <Title level={2} style={{ margin: 0 }}>
            Built from computational mathematics, for work far beyond it.
          </Title>
        </Flex>
        <div className="cocalc-about-timeline">
          {COMPANY_TIMELINE.map((item) => (
            <div
              key={item.year}
              style={{
                borderTop: `3px solid ${PUBLIC_COLORS.brand}`,
                padding: "16px 8px 0 0",
              }}
            >
              <div
                style={{
                  color: PUBLIC_COLORS.brand,
                  fontSize: PUBLIC_TYPE.subhead,
                  fontWeight: PUBLIC_WEIGHT.bold,
                }}
              >
                {item.year}
              </div>
              <Paragraph style={{ margin: "8px 0 0" }}>{item.body}</Paragraph>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="CoCalc founder" className="cocalc-about-founder">
        <img
          alt={founder.imageAlt}
          className="cocalc-about-founder-photo"
          src={founder.imageSrc}
        />
        <Flex gap={14} justify="center" vertical>
          <Eyebrow>Founder perspective</Eyebrow>
          <Title level={2} style={{ margin: 0 }}>
            From mathematics research to shared infrastructure.
          </Title>
          <Paragraph
            style={{
              fontSize: PUBLIC_TYPE.lead,
              lineHeight: 1.65,
              margin: 0,
            }}
          >
            William Stein created SageMath and CoCalc after years of
            computational number theory research. Before focusing full-time on
            SageMath, Inc., he was a tenured full professor of mathematics at
            the University of Washington.
          </Paragraph>
          <Paragraph style={{ lineHeight: 1.65, margin: 0 }}>
            That background continues to shape CoCalc: researchers should be
            able to understand and control their tools, collaborators should
            share the real computational environment, and important work should
            remain reproducible after the immediate session ends.
          </Paragraph>
          <Flex gap={10} wrap>
            <Button
              href={publicPath("about/team/william-stein")}
              type="primary"
            >
              About William Stein
            </Button>
            <Button
              href="https://wstein.org/cv/cv.pdf"
              rel="noreferrer noopener"
              target="_blank"
            >
              Academic CV
            </Button>
          </Flex>
        </Flex>
      </section>

      <section aria-label="Leadership and team">
        <Flex
          align="end"
          gap={16}
          justify="space-between"
          style={{ marginBottom: 22 }}
          wrap
        >
          <div>
            <Eyebrow>People behind the platform</Eyebrow>
            <Title level={2} style={{ margin: "10px 0 0" }}>
              Leadership and team
            </Title>
          </div>
          <Flex gap={8} wrap>
            <Button href={publicPath("about/team")}>Meet the team</Button>
            <Button href={publicPath("about/events")}>Events</Button>
          </Flex>
        </Flex>
        <div className="cocalc-about-team-preview">
          {TEAM_MEMBERS.map((member) => (
            <a
              href={publicPath(`about/team/${member.slug}`)}
              key={member.email}
              style={{
                alignItems: "center",
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: PUBLIC_RADIUS.panel,
                color: "inherit",
                display: "flex",
                gap: 14,
                minWidth: 0,
                padding: 14,
                textDecoration: "none",
              }}
            >
              <img
                alt=""
                aria-hidden="true"
                src={member.imageSrc}
                style={{
                  borderRadius: PUBLIC_RADIUS.pill,
                  height: 58,
                  objectFit: "cover",
                  width: 58,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    color: PUBLIC_COLORS.heading,
                    fontWeight: PUBLIC_WEIGHT.bold,
                  }}
                >
                  {member.name}
                </div>
                <div
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    fontSize: PUBLIC_TYPE.caption,
                  }}
                >
                  {member.title}
                </div>
              </div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function AboutTeamPage({ config }: { config?: PublicConfig }) {
  const billingHref = isPublicCocalcAiSite(config)
    ? publicPath(PUBLIC_TEAM_BILLING_CONTACT.path)
    : PUBLIC_TEAM_BILLING_CONTACT.url;
  return (
    <>
      <PublicGrid columns={2}>
        {TEAM_MEMBERS.map((member) => (
          <PublicCard
            href={publicPath(`about/team/${member.slug}`)}
            key={member.email}
            title={`${member.name}, ${member.title}`}
          >
            <div
              style={{
                alignContent: "start",
                display: "grid",
                gap: 12,
                height: "100%",
              }}
            >
              <div
                style={{
                  alignItems: "start",
                  display: "grid",
                  gap: 24,
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
                }}
              >
                <Paragraph>{member.cardText}</Paragraph>
                <img
                  alt={member.imageAlt}
                  src={member.imageSrc}
                  style={{
                    borderRadius: PUBLIC_RADIUS.media,
                    objectFit: "cover",
                    width: "100%",
                  }}
                />
              </div>
            </div>
          </PublicCard>
        ))}
      </PublicGrid>
      <Paragraph style={{ margin: 0, textAlign: "center" }}>
        {PUBLIC_TEAM_BILLING_CONTACT.text}{" "}
        <a href={billingHref}>{PUBLIC_TEAM_BILLING_CONTACT.label}</a>.
      </Paragraph>
    </>
  );
}

function ExperienceList({ member }: { member: TeamMemberProfile }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {member.experience.map((item) => (
        <div key={`${item.position}-${item.institution}-${item.timeframe}`}>
          <div style={{ fontWeight: PUBLIC_WEIGHT.bold }}>
            {item.institution}
            <span style={MUTED_STYLE}> · {item.timeframe}</span>
          </div>
          <div>
            <em>{item.position}</em>
          </div>
        </div>
      ))}
    </div>
  );
}

const SOCIAL_LINK_ORDER = [
  "facebook",
  "github",
  "instagram",
  "linkedin",
  "twitter",
  "youtube",
] as const;

const SOCIAL_LINK_LABELS = {
  facebook: "Facebook",
  github: "GitHub",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  twitter: "Twitter",
  youtube: "YouTube",
} as const;

function TeamSocialLinks({ member }: { member: TeamMemberProfile }) {
  if (!member.socialLinks) {
    return null;
  }

  return (
    <Flex gap={16} wrap>
      {SOCIAL_LINK_ORDER.flatMap((platform) => {
        const href = member.socialLinks?.[platform];
        if (!href) return [];
        return [
          <a
            aria-label={SOCIAL_LINK_LABELS[platform]}
            href={href}
            key={platform}
            rel="noreferrer noopener"
            style={{
              alignItems: "center",
              color: PUBLIC_COLORS.heading,
              display: "inline-flex",
              fontSize: 22,
              justifyContent: "center",
              lineHeight: 1,
              minHeight: 24,
              minWidth: 24,
            }}
            target="_blank"
          >
            <Icon name={platform} />
          </a>,
        ];
      })}
    </Flex>
  );
}

function AboutTeamMemberPage({ slug }: { slug?: string }) {
  const member = getTeamMember(slug);

  if (!member) {
    return <EmptySection label="This team profile was not found." />;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <PublicSection>
        <div
          style={{
            display: "grid",
            gap: 24,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
          }}
        >
          <img
            alt={member.imageAlt}
            src={member.imageSrc}
            style={{
              alignSelf: "start",
              borderRadius: PUBLIC_RADIUS.media,
              maxWidth: 320,
              objectFit: "cover",
              width: "100%",
            }}
          />
          <div
            style={{
              alignSelf: "stretch",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "grid", gap: 12 }}>
              {member.bioTopText.map((paragraph) => (
                <Paragraph key={paragraph} style={{ margin: 0 }}>
                  {paragraph}
                </Paragraph>
              ))}
            </div>
            <Flex
              align="center"
              justify="space-between"
              style={{ marginTop: "auto", minWidth: 0 }}
              wrap
            >
              <a
                href={`mailto:${member.email}`}
                style={{ overflowWrap: "anywhere" }}
              >
                {member.email}
              </a>
              <Flex align="center" gap={16} wrap>
                {member.website ? (
                  <a href={member.website.href}>{member.website.label}</a>
                ) : null}
                <TeamSocialLinks member={member} />
              </Flex>
            </Flex>
          </div>
        </div>
      </PublicSection>
      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Background
        </Title>
        {member.background.map((paragraph) => (
          <Paragraph key={paragraph} style={{ margin: 0 }}>
            {paragraph}
          </Paragraph>
        ))}
      </PublicSection>
      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Previous Experience
        </Title>
        <ExperienceList member={member} />
      </PublicSection>
    </div>
  );
}

function EventList({ items }: { items: NewsItem[] }) {
  if (items.length === 0) {
    return <EmptySection label="No events found." />;
  }
  return (
    <PublicGrid columns={2}>
      {items.map((item) => (
        <PublicSection key={`${item.id ?? item.title}-${item.date}`}>
          <div
            style={{
              ...MUTED_STYLE,
              fontSize: PUBLIC_TYPE.caption,
              fontWeight: PUBLIC_WEIGHT.bold,
            }}
          >
            {formatNewsDate(item.date)}
          </div>
          <Title level={3} style={{ margin: 0 }}>
            {item.title}
          </Title>
          {item.tags?.length ? (
            <Flex gap={8} wrap>
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
        </PublicSection>
      ))}
    </PublicGrid>
  );
}

function AboutEventsPage() {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<EventsPayload>({});

  useEffect(() => {
    let canceled = false;
    void fetchJson<EventsPayload>(appPath("api/v2/news/events"))
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
    return <LoadingSection label="Loading events…" />;
  }

  return (
    <div style={{ display: "grid", gap: "24px" }}>
      <div>
        <Title level={2} style={{ marginBottom: 10 }}>
          Upcoming events
        </Title>
        <EventList items={payload.upcoming ?? []} />
      </div>
      <div>
        <Title level={2} style={{ marginBottom: 10 }}>
          Past events
        </Title>
        <EventList items={payload.past ?? []} />
      </div>
    </div>
  );
}

export default function PublicAboutApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicAboutRoute;
}) {
  const siteName = getPublicMarketingSiteName(config);
  const title = titleForRoute(initialRoute, siteName);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell
      active="about"
      config={config}
      // The overview's hero carries the page's H1, as in the crawler fallback.
      title={initialRoute.view === "about" ? undefined : title}
    >
      {initialRoute.view === "about-events" ? (
        <AboutEventsPage />
      ) : initialRoute.view === "about-team" ? (
        <AboutTeamPage config={config} />
      ) : initialRoute.view === "about-team-member" ? (
        <AboutTeamMemberPage slug={initialRoute.teamSlug} />
      ) : (
        <>
          <AboutOverview config={config} />
          <PublicNextStep
            authenticated={!!config?.is_authenticated}
            heading="Start your next project with an agent."
          />
        </>
      )}
    </PublicSectionShell>
  );
}
