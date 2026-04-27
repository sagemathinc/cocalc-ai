/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import { Button, Col, Empty, Flex, Row, Typography } from "antd";

import HTML from "@cocalc/frontend/components/html-ssr";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { FeatureImage } from "@cocalc/frontend/public/features/page-components";
import {
  PublicHero,
  PublicSiteShell,
  PublicSectionCard,
} from "@cocalc/frontend/public/layout/shell";
import { LOCALE, LOCALIZATIONS, type Locale } from "@cocalc/util/i18n";
import { SITE_NAME } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import { loadLangMessages, type LangMessages } from "./messages";
import { langPath, type PublicLangRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

interface LangConfig {
  is_authenticated?: boolean;
  show_policies?: boolean;
  site_name?: string;
}

interface PublicLangAppProps {
  config?: LangConfig;
  initialMessages?: LangMessages;
  initialMessagesLocale?: Locale;
  initialRoute: PublicLangRoute;
}

const TRANSLATED_FEATURES: Array<{
  bodyKey: string;
  image: string;
  links?: Record<string, string>;
  titleKey: string;
}> = [
  {
    bodyKey: "realtime-collaboration-text",
    image: "/public/features/cocalc-real-time-jupyter.png",
    titleKey: "realtime-collaboration",
  },
  {
    bodyKey: "jupyter-notebook-text",
    image: "/public/features/cocalc-jupyter2-20170508.png",
    links: {
      a: appPath("features/jupyter-notebook"),
      A2: appPath("features/teaching"),
      AI: appPath("features/ai"),
    },
    titleKey: "jupyter-notebook-title",
  },
  {
    bodyKey: "latex-editor-text",
    image: "/public/features/latex-editor-main-20251003.png",
    links: {
      a: appPath("features/latex-editor"),
      AI: appPath("features/ai"),
    },
    titleKey: "latex-editor-title",
  },
  {
    bodyKey: "linux-text",
    image: "/public/features/terminal.png",
    links: {
      A: appPath("features/terminal"),
      A2: appPath("features/linux"),
    },
    titleKey: "linux-title",
  },
  {
    bodyKey: "teaching-text",
    image: "/public/features/cocalc-course-assignments-2019.png",
    links: {
      A: appPath("features/teaching"),
    },
    titleKey: "teaching-title",
  },
  {
    bodyKey: "chat-text",
    image: "/public/features/chatroom.png",
    links: {
      A: "https://doc.cocalc.com/chat.html",
    },
    titleKey: "chat-title",
  },
];

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function applyMessageLinks(
  value?: string,
  links?: Record<string, string>,
): string {
  let html = `${value ?? ""}`;
  for (const [tag, href] of Object.entries(links ?? {})) {
    html = html.replace(new RegExp(`<${tag}>`, "g"), `<a href="${href}">`);
    html = html.replace(new RegExp(`</${tag}>`, "g"), "</a>");
  }
  return html;
}

function sortedLocales(): Locale[] {
  return [...LOCALE].sort((a, b) =>
    LOCALIZATIONS[a].name.localeCompare(LOCALIZATIONS[b].name),
  );
}

function LocaleSwitcher({ current }: { current?: Locale }) {
  return (
    <PublicSectionCard>
      <Text strong type="secondary">
        LANGUAGES
      </Text>
      <Flex wrap gap={8}>
        {sortedLocales().map((locale) => {
          const localization = LOCALIZATIONS[locale];
          return (
            <Button
              key={locale}
              href={langPath(locale)}
              type={locale === current ? "primary" : "default"}
            >
              {localization.flag} {localization.native}
            </Button>
          );
        })}
      </Flex>
    </PublicSectionCard>
  );
}

function LangIndex({ siteName }: { siteName: string }) {
  return (
    <>
      <PublicHero
        eyebrow="TRANSLATED LANDING PAGES"
        title={`Translations for ${siteName}`}
        subtitle={`Open a language-specific overview of ${siteName}. These pages are intentionally minimal public landing pages for discovery and SEO.`}
      />
      <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
        <LocaleSwitcher />
        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            Available languages
          </Title>
          <Paragraph style={{ margin: 0 }}>
            The localized landing pages summarize the same core product in other
            languages, while the broader public site and main application
            continue to evolve in English first.
          </Paragraph>
        </PublicSectionCard>
      </div>
    </>
  );
}

function LocaleLanding({
  config,
  locale,
  messages,
  siteName,
}: {
  config?: LangConfig;
  locale: Locale;
  messages: LangMessages;
  siteName: string;
}) {
  const localization = LOCALIZATIONS[locale];

  return (
    <>
      <PublicHero
        eyebrow={`${localization.flag} ${localization.native}`}
        title={messages.tagline ?? siteName}
        subtitle={messages["site-description"] ?? siteName}
        actions={
          <Flex wrap gap={12}>
            {config?.is_authenticated ? (
              <>
                <Button href={appPath("projects")} type="primary">
                  Projects
                </Button>
                <Button href={appPath("settings")}>Settings</Button>
              </>
            ) : (
              <Button href={appPath("auth/sign-up")} type="primary">
                {messages["sign-up"] ?? "Sign up"}
              </Button>
            )}
            <Button href={appPath("")}>
              {messages["home-page"] ?? "Home"}
            </Button>
            <Button href={langPath()}>Languages</Button>
          </Flex>
        }
      />
      <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
        <PublicSectionCard>
          <Text strong type="secondary">
            {messages.intro ?? "Overview"}
          </Text>
          <Title level={2} style={{ margin: 0 }}>
            {messages.intro ?? "What is CoCalc?"}
          </Title>
          <FeatureImage
            alt={`${siteName} screenshot`}
            src="/public/cocalc-screenshot-20200128-nq8.png"
          />
          <HTML value={messages["intro-1"] ?? ""} />
        </PublicSectionCard>
        <LocaleSwitcher current={locale} />
        <section>
          <Title level={2} style={{ margin: 0 }}>
            {messages["many-languages"] ?? "Core workflows"}
          </Title>
          <Paragraph style={{ margin: "8px 0 0" }}>
            {messages["many-languages-text"] ??
              "These translated pages focus on the most important capabilities of the platform."}
          </Paragraph>
          <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
            {TRANSLATED_FEATURES.map((feature) => (
              <Col key={feature.titleKey} xs={24} lg={12}>
                <PublicSectionCard>
                  <FeatureImage
                    alt={messages[feature.titleKey] ?? feature.titleKey}
                    src={feature.image}
                  />
                  <Title level={3} style={{ margin: 0 }}>
                    {messages[feature.titleKey] ?? feature.titleKey}
                  </Title>
                  <HTML
                    value={applyMessageLinks(
                      messages[feature.bodyKey],
                      feature.links,
                    )}
                  />
                </PublicSectionCard>
              </Col>
            ))}
          </Row>
        </section>
      </div>
    </>
  );
}

export default function PublicLangApp({
  config,
  initialMessages,
  initialMessagesLocale,
  initialRoute,
}: PublicLangAppProps) {
  const [messages, setMessages] = useState<LangMessages | undefined>(
    initialRoute.view === "locale" &&
      initialMessagesLocale === initialRoute.locale
      ? initialMessages
      : undefined,
  );
  const siteName = config?.site_name ?? SITE_NAME;
  const title =
    initialRoute.view === "locale"
      ? `${siteName} – ${LOCALIZATIONS[initialRoute.locale].native}`
      : `Translations – ${siteName}`;

  useEffect(() => {
    if (initialRoute.view !== "locale") {
      setMessages(undefined);
      return;
    }
    if (
      initialMessages != null &&
      initialMessagesLocale === initialRoute.locale
    ) {
      setMessages(initialMessages);
      return;
    }
    let cancelled = false;
    void loadLangMessages(initialRoute.locale).then((nextMessages) => {
      if (!cancelled) {
        setMessages(nextMessages);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialMessages, initialMessagesLocale, initialRoute]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = title;
  }, [title]);

  const content = useMemo(() => {
    if (initialRoute.view === "index") {
      return <LangIndex siteName={siteName} />;
    }
    if (!messages) {
      return (
        <PublicSectionCard>
          <Empty description="Loading translation…" />
        </PublicSectionCard>
      );
    }
    return (
      <LocaleLanding
        config={config}
        locale={initialRoute.locale}
        messages={messages}
        siteName={siteName}
      />
    );
  }, [config, initialRoute, messages, siteName]);

  return (
    <PublicSiteShell
      isAuthenticated={!!config?.is_authenticated}
      showPolicies={!!config?.show_policies}
      siteName={siteName}
      title={title}
    >
      {content}
    </PublicSiteShell>
  );
}
