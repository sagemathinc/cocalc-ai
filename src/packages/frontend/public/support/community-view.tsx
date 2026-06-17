/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Typography } from "antd";

import { PublicNextStep } from "@cocalc/frontend/public/common";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";

const { Paragraph, Text, Title } = Typography;

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
      <Paragraph style={{ margin: 0, fontSize: 16 }}>
        Use these public channels to follow CoCalc updates and inspect the
        source code. For account, billing, or project-specific help, open a
        direct support ticket.
      </Paragraph>
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        {COMMUNITY_LINKS.map((item) => (
          <PublicSection key={item.href}>
            <Text strong type="secondary">
              COMMUNITY
            </Text>
            <Title level={3} style={{ margin: 0 }}>
              {item.title}
            </Title>
            <Paragraph style={{ margin: 0 }}>{item.description}</Paragraph>
            <Flex wrap gap={8}>
              <Button type="primary" href={item.href}>
                Open
              </Button>
            </Flex>
          </PublicSection>
        ))}
      </div>
      <PublicNextStep heading="Ready to get started, or need direct help?" />
    </div>
  );
}
