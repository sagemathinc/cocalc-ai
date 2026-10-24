/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { Button, Empty, Flex, Typography } from "antd";
import {
  docsPath,
  getDocsEntry,
  listDocsEntries,
  type DocsEntry,
} from "@cocalc/docs";
import {
  DocsDetailContent,
  DocsIndexContent,
  DocsPrintContent,
  getDocsLinearNavigation,
} from "@cocalc/frontend/docs/browser";
import { downloadStandaloneDocsHtml } from "@cocalc/frontend/docs/download-html";
import {
  appPath,
  getPublicDocsAccess,
  getPublicMarketingSiteName,
  PublicNextStep,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { PUBLIC_COLORS, PUBLIC_TYPE } from "../theme";
import { navigatePublic } from "../navigation";
import type { PublicDocsRoute } from "./routes";

// A link to a section of a docs page (e.g. from the homepage) lands with its
// heading below the sticky public header, not under it.
const DOCS_ANCHOR_CSS = `
  .cocalc-public-docs-detail .cocalc-docs-markdown [id] {
    scroll-margin-top: calc(var(--cocalc-public-anchor-offset, 64px) + 12px);
  }
`;

const { Paragraph, Text, Title } = Typography;

interface PublicDocsAppProps {
  config?: PublicConfig;
  initialRoute: PublicDocsRoute;
}

function DocsIndex({ config }: { config?: PublicConfig }) {
  const siteName = getPublicMarketingSiteName(config);
  const docsAccess = getPublicDocsAccess(config);
  const [downloadHtmlBusy, setDownloadHtmlBusy] = useState(false);

  useEffect(() => {
    document.title = `Documentation - ${siteName}`;
  }, [siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <Flex gap="large" vertical>
          <div>
            <Text
              strong
              style={{
                color: PUBLIC_COLORS.brandActive,
                textTransform: "uppercase",
                fontSize: PUBLIC_TYPE.eyebrow,
                letterSpacing: 0,
              }}
            >
              {siteName} documentation
            </Text>
            <Title style={{ marginBottom: 12, marginTop: 10 }}>
              Current docs for this {siteName} instance.
            </Title>
            <Paragraph
              style={{
                fontSize: PUBLIC_TYPE.lead,
                margin: 0,
                maxWidth: "72ch",
              }}
            >
              Served by the workspace itself, evolving with the product and
              matching your UI.
            </Paragraph>
          </div>
          <DocsIndexContent
            docsAccess={docsAccess}
            linkForEntry={(entry) => appPath(docsPath(entry.slug))}
            onDownloadHtml={async () => {
              setDownloadHtmlBusy(true);
              try {
                await downloadStandaloneDocsHtml({
                  docsAccess,
                  onBackHref: appPath(docsPath("")),
                });
              } finally {
                setDownloadHtmlBusy(false);
              }
            }}
            printHref={appPath(docsPath("print"))}
          />
          {downloadHtmlBusy ? (
            <Text type="secondary">Preparing HTML download...</Text>
          ) : null}
          <PublicNextStep authenticated={!!config?.is_authenticated} />
        </Flex>
      </section>
    </PublicSectionShell>
  );
}

function DocsPrint({ config }: { config?: PublicConfig }) {
  const siteName = getPublicMarketingSiteName(config);
  const docsAccess = getPublicDocsAccess(config);
  const [downloadHtmlBusy, setDownloadHtmlBusy] = useState(false);

  useEffect(() => {
    document.title = `Printable documentation - ${siteName}`;
  }, [siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <DocsPrintContent
          docsAccess={docsAccess}
          downloadHtmlBusy={downloadHtmlBusy}
          onBackHref={appPath(docsPath(""))}
          onDownloadHtml={async () => {
            setDownloadHtmlBusy(true);
            try {
              await downloadStandaloneDocsHtml({
                docsAccess,
                onBackHref: appPath(docsPath("")),
              });
            } finally {
              setDownloadHtmlBusy(false);
            }
          }}
        />
      </section>
    </PublicSectionShell>
  );
}

function DocsDetail({
  config,
  entry,
}: {
  config?: PublicConfig;
  entry: DocsEntry;
}) {
  const siteName = getPublicMarketingSiteName(config);
  const docsAccess = getPublicDocsAccess(config);
  const onSelectEntry = (nextEntry: DocsEntry, href?: string) => {
    let nextPath = appPath(docsPath(nextEntry.slug));
    if (href != null) {
      const url = new URL(href, window.location.href);
      nextPath += `${url.search}${url.hash}`;
    }
    const target = new URL(nextPath, window.location.href);
    if (
      target.hash &&
      target.pathname === window.location.pathname &&
      target.search === window.location.search
    ) {
      // A root-relative docs link may need the base path added before it
      // names this same page. Use native fragment scrolling in that case.
      window.location.hash = target.hash;
      return;
    }
    navigatePublic(nextPath);
  };
  const linearNavigation = getDocsLinearNavigation({
    entries: listDocsEntries(docsAccess),
    entry,
    hrefForEntry: (nextEntry) => appPath(docsPath(nextEntry.slug)),
    onSelectEntry,
  });

  useEffect(() => {
    document.title = `${entry.title} - Documentation - ${siteName}`;
  }, [entry.title, siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <style>{DOCS_ANCHOR_CSS}</style>
      <section className="cocalc-public-docs-detail">
        <DocsDetailContent
          docsAccess={docsAccess}
          entry={entry}
          linearNavigation={linearNavigation}
          onBackHref={appPath(docsPath())}
        />
      </section>
    </PublicSectionShell>
  );
}

function DocsNotFound({ config }: { config?: PublicConfig }) {
  const siteName = getPublicMarketingSiteName(config);

  useEffect(() => {
    document.title = `Documentation page not found - ${siteName}`;
  }, [siteName]);

  return (
    <PublicSectionShell
      active="docs"
      config={config}
      title="Docs page not found"
    >
      <Empty description="That documentation page does not exist yet." />
      <Button href={appPath("docs")} type="primary">
        Browse docs
      </Button>
    </PublicSectionShell>
  );
}

export default function PublicDocsApp({
  config,
  initialRoute,
}: PublicDocsAppProps) {
  if (initialRoute.view === "docs-index") {
    return <DocsIndex config={config} />;
  }
  if (initialRoute.view === "docs-print") {
    return <DocsPrint config={config} />;
  }

  const entry = getDocsEntry(initialRoute.slug, getPublicDocsAccess(config));
  if (entry == null) {
    return <DocsNotFound config={config} />;
  }
  return <DocsDetail config={config} entry={entry} />;
}
