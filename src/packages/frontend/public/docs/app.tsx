/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { Button, Empty, Flex, Typography } from "antd";
import { docsPath, getDocsEntry, type DocsEntry } from "@cocalc/docs";
import {
  DocsDetailContent,
  DocsIndexContent,
  DocsPrintContent,
} from "@cocalc/frontend/docs/browser";
import { downloadStandaloneDocsHtml } from "@cocalc/frontend/docs/download-html";
import {
  appPath,
  getPublicMarketingSiteName,
  PublicNextStep,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { PUBLIC_COLORS, PUBLIC_TYPE } from "../theme";
import type { PublicDocsRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

interface PublicDocsAppProps {
  config?: PublicConfig;
  initialRoute: PublicDocsRoute;
}

function DocsIndex({ config }: { config?: PublicConfig }) {
  const siteName = getPublicMarketingSiteName(config);
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
                color: PUBLIC_COLORS.brand,
                textTransform: "uppercase",
                fontSize: PUBLIC_TYPE.eyebrow,
                letterSpacing: 0,
              }}
            >
              {siteName} documentation
            </Text>
            <Title style={{ marginBottom: 12, marginTop: 10 }}>
              Current docs for this CoCalc instance.
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
            linkForEntry={(entry) => appPath(docsPath(entry.slug))}
            onDownloadHtml={async () => {
              setDownloadHtmlBusy(true);
              try {
                await downloadStandaloneDocsHtml({
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
  const [downloadHtmlBusy, setDownloadHtmlBusy] = useState(false);

  useEffect(() => {
    document.title = `Printable documentation - ${siteName}`;
  }, [siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <DocsPrintContent
          downloadHtmlBusy={downloadHtmlBusy}
          onBackHref={appPath(docsPath(""))}
          onDownloadHtml={async () => {
            setDownloadHtmlBusy(true);
            try {
              await downloadStandaloneDocsHtml({
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

  useEffect(() => {
    document.title = `${entry.title} - Documentation - ${siteName}`;
  }, [entry.title, siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <DocsDetailContent entry={entry} />
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

  const entry = getDocsEntry(initialRoute.slug);
  if (entry == null) {
    return <DocsNotFound config={config} />;
  }
  return <DocsDetail config={config} entry={entry} />;
}
