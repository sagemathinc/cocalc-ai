/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Typography } from "antd";

import { appPath, PublicNextStep } from "@cocalc/frontend/public/common";
import { PublicCard, PublicGrid } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";

const { Paragraph } = Typography;

const COMMUNITY_LINKS = [
  {
    title: "GitHub source code",
    description:
      "Browse the source, track issues, report bugs, and send pull requests.",
    href: "https://github.com/sagemathinc/cocalc-ai",
  },
  {
    title: "LinkedIn",
    description: "Follow company news and updates from SageMath, Inc.",
    href: "https://www.linkedin.com/company/sagemath-inc./",
  },
  {
    title: "Twitter/X",
    description:
      "Follow public announcements and updates, or tag the team publicly.",
    href: "https://twitter.com/cocalc_com",
  },
] as const;

export default function CommunityView() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Paragraph style={{ margin: 0, fontSize: PUBLIC_TYPE.body }}>
        Use these public channels to follow CoCalc updates and inspect the
        source code. For account, billing, or project-specific help,{" "}
        <a href={appPath("support/new")}>open a direct support ticket</a>.
      </Paragraph>
      <PublicGrid columns={3}>
        {COMMUNITY_LINKS.map((item) => (
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
