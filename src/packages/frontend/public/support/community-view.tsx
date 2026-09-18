/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Typography } from "antd";

import { appPath, PublicNextStep } from "@cocalc/frontend/public/common";
import { PublicCard, PublicGrid } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  PUBLIC_COMMUNITY_INTRO,
  PUBLIC_COMMUNITY_LINKS,
} from "@cocalc/util/public-support-content";

const { Paragraph } = Typography;

interface CommunityViewConfig {
  help_email?: string;
  zendesk?: boolean;
}

export default function CommunityView({
  config = {},
}: {
  config?: CommunityViewConfig;
}) {
  const helpEmail = config.help_email ?? "help@cocalc.com";
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Paragraph style={{ margin: 0, fontSize: PUBLIC_TYPE.body }}>
        {PUBLIC_COMMUNITY_INTRO} For account, billing, or project-specific help,{" "}
        {config.zendesk ? (
          <a href={appPath("support/new")}>open a direct support ticket</a>
        ) : (
          <a href={`mailto:${helpEmail}`}>contact {helpEmail}</a>
        )}
        .
      </Paragraph>
      <PublicGrid columns={4}>
        {PUBLIC_COMMUNITY_LINKS.map((item) => (
          <PublicCard
            href={item.href}
            key={item.href}
            rel="noreferrer"
            target="_blank"
            title={item.title}
          >
            <Paragraph style={{ margin: 0 }}>{item.description}</Paragraph>
          </PublicCard>
        ))}
      </PublicGrid>
      <PublicNextStep heading="Ready to get started, or need direct help?" />
    </div>
  );
}
