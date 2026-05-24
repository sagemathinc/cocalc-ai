/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Empty, Flex, Typography } from "antd";
import { docsPath, getDocsEntry, type DocsEntry } from "@cocalc/docs";
import {
  DocsDetailContent,
  DocsFontSizeFrame,
  DocsIndexContent,
} from "@cocalc/frontend/docs/browser";
import {
  appPath,
  getSiteName,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { PUBLIC_COLORS } from "../theme";
import type { PublicDocsRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

interface PublicDocsAppProps {
  config?: PublicConfig;
  initialRoute: PublicDocsRoute;
}

function DocsIndex({ config }: { config?: PublicConfig }) {
  const siteName = getSiteName(config);

  useEffect(() => {
    document.title = `Documentation - ${siteName}`;
  }, [siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <DocsFontSizeFrame>
          <Flex gap="large" vertical>
            <div>
              <Text
                strong
                style={{
                  color: PUBLIC_COLORS.brand,
                  textTransform: "uppercase",
                }}
              >
                CoCalc-ai documentation
              </Text>
              <Title style={{ marginBottom: 12, marginTop: 10 }}>
                Current docs for this CoCalc instance.
              </Title>
              <Paragraph
                style={{ fontSize: "1.125em", margin: 0, maxWidth: "72ch" }}
              >
                These docs are served by CoCalc-ai itself, so they can evolve
                with the product, link to the current UI, and become source
                material for agents answering questions inside your workspace.
              </Paragraph>
            </div>
            <DocsIndexContent
              linkForEntry={(entry) => appPath(docsPath(entry.slug))}
            />
          </Flex>
        </DocsFontSizeFrame>
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
  const siteName = getSiteName(config);

  useEffect(() => {
    document.title = `${entry.title} - Documentation - ${siteName}`;
  }, [entry.title, siteName]);

  return (
    <PublicSectionShell active="docs" config={config}>
      <section>
        <DocsFontSizeFrame>
          <DocsDetailContent entry={entry} />
        </DocsFontSizeFrame>
      </section>
    </PublicSectionShell>
  );
}

function DocsNotFound({ config }: { config?: PublicConfig }) {
  const siteName = getSiteName(config);

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

  const entry = getDocsEntry(initialRoute.slug);
  if (entry == null) {
    return <DocsNotFound config={config} />;
  }
  return <DocsDetail config={config} entry={entry} />;
}
