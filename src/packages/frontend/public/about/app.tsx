/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, lazy, useEffect, useState } from "react";

import { Flex, Tag, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import type { NewsItem } from "@cocalc/util/types/news";
import { COLORS } from "@cocalc/util/theme";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  EmptySection,
  fetchJson,
  getSiteName,
  LinkButton,
  LoadingSection,
  MUTED_STYLE,
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
      return "Meet the People Behind CoCalc";
  }
}

function AboutOverview() {
  return <AboutTeamPage />;
}

function AboutTeamPage() {
  return (
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
                gridTemplateColumns: "minmax(180px, 240px) minmax(0, 1fr)",
              }}
            >
              <Paragraph>{member.cardText}</Paragraph>
              <img
                alt={member.imageAlt}
                src={member.imageSrc}
                style={{
                  borderRadius: 14,
                  objectFit: "cover",
                  width: "100%",
                }}
              />
            </div>
          </div>
        </PublicCard>
      ))}
    </PublicGrid>
  );
}

function ExperienceList({ member }: { member: TeamMemberProfile }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {member.experience.map((item) => (
        <div key={`${item.position}-${item.institution}-${item.timeframe}`}>
          <div style={{ fontWeight: 700 }}>
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
            style={{ color: COLORS.GRAY_M, fontSize: 22, lineHeight: 1 }}
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
            gridTemplateColumns: "minmax(220px, 320px) minmax(0, 1fr)",
          }}
        >
          <img
            alt={member.imageAlt}
            src={member.imageSrc}
            style={{
              alignSelf: "start",
              borderRadius: 16,
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
              style={{ marginTop: "auto" }}
              wrap
            >
              <a href={`mailto:${member.email}`}>{member.email}</a>
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
        <Title level={3} style={{ margin: 0 }}>
          Background
        </Title>
        {member.background.map((paragraph) => (
          <Paragraph key={paragraph} style={{ margin: 0 }}>
            {paragraph}
          </Paragraph>
        ))}
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
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
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
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
    void fetchJson<EventsPayload>(`${appBasePath}/api/v2/news/events`)
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

export default function PublicAboutApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicAboutRoute;
}) {
  const siteName = getSiteName(config);
  const title = titleForRoute(initialRoute, siteName);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell active="about" config={config} title={title}>
      {initialRoute.view === "about-events" ? (
        <AboutEventsPage />
      ) : initialRoute.view === "about-team" ? (
        <AboutTeamPage />
      ) : initialRoute.view === "about-team-member" ? (
        <AboutTeamMemberPage slug={initialRoute.teamSlug} />
      ) : (
        <>
          <AboutOverview />
          <AboutEventsPage />
        </>
      )}
    </PublicSectionShell>
  );
}
