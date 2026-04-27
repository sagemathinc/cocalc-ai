/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/layout/shell";

const { Paragraph, Text, Title } = Typography;

const COMMUNITY_LINKS = [
  {
    title: "Discord",
    description:
      "Chat with other CoCalc users, ask questions, and get quick feedback from the community.",
    href: "https://discord.gg/EugdaJZ8",
  },
  {
    title: "GitHub source code",
    description:
      "Browse the source, track issues, report bugs, and send pull requests.",
    href: "https://github.com/sagemathinc/cocalc",
  },
  {
    title: "GitHub discussions",
    description:
      "Search or ask questions and start discussions about CoCalc with other users and developers.",
    href: "https://github.com/sagemathinc/cocalc/discussions",
  },
  {
    title: "Google Groups mailing list",
    description:
      "Get announcements in your inbox and participate in longer-form email discussions.",
    href: "https://groups.google.com/forum/?fromgroups#!forum/cocalc",
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
        There are several good ways to connect with the broader CoCalc community
        beyond direct support tickets.
      </Paragraph>
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        {COMMUNITY_LINKS.map((item) => (
          <PublicSectionCard key={item.href}>
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
          </PublicSectionCard>
        ))}
      </div>
    </div>
  );
}
