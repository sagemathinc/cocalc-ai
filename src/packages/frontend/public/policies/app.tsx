/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Flex, Menu, Typography } from "antd";
import { theme } from "antd";
import {
  EmptySection,
  getSiteName,
  MarkdownSection,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { publicPath } from "../routes";
import { PublicCard, PublicGrid, PublicSection } from "../layout/shell";
import {
  BuiltinPolicyPage,
  BUILTIN_POLICIES,
  getBuiltinPolicy,
  getBuiltinPolicyNavItems,
} from "./registry";
import type { PublicPoliciesRoute } from "./routes";

const { Paragraph, Title } = Typography;

function arePoliciesVisible(config?: PublicConfig): boolean {
  return !!config?.show_policies;
}

function getExternalPoliciesUrl(config?: PublicConfig): string | undefined {
  const url = config?.terms_of_service_url?.trim();
  return url ? url : undefined;
}

function titleForRoute(route: PublicPoliciesRoute, siteName: string): string {
  switch (route.view) {
    case "policies-imprint":
      return `${siteName} Imprint`;
    case "policies-custom":
      return `${siteName} Policies`;
    case "policies-detail":
      return `${getBuiltinPolicy(route.policySlug)?.title ?? "Policies"} - ${siteName}`;
    case "policies":
    default:
      return `${siteName} Policies`;
  }
}

function PolicyGateCard({ config }: { config?: PublicConfig }) {
  const externalUrl = getExternalPoliciesUrl(config);

  if (!arePoliciesVisible(config)) {
    return (
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Public policy pages are disabled
        </Title>
        <Paragraph style={{ margin: 0 }}>
          This deployment is not exposing a public policy section.
        </Paragraph>
      </PublicSection>
    );
  }

  if (!externalUrl) {
    return null;
  }

  return (
    <PublicSection>
      <Title level={3} style={{ margin: 0 }}>
        Public policy information
      </Title>
      <Paragraph style={{ margin: 0 }}>
        This deployment uses an external policy page instead of the built-in
        legal documents.
      </Paragraph>
      <div>
        <Button
          href={externalUrl}
          rel="noreferrer"
          target="_blank"
          type="primary"
        >
          Open policy page
        </Button>
      </div>
    </PublicSection>
  );
}

function PoliciesHome({ config }: { config: PublicConfig }) {
  const externalUrl = getExternalPoliciesUrl(config);
  if (!arePoliciesVisible(config) || externalUrl) {
    return <PolicyGateCard config={config} />;
  }

  const items = [
    ...BUILTIN_POLICIES.map((policy) => ({
      description: policy.description,
      href: publicPath(`policies/${policy.slug}`),
      title: policy.title,
    })),
    ...(config.imprint
      ? [
          {
            description: "Site-specific legal imprint information.",
            href: publicPath("policies/imprint"),
            title: "Imprint",
          },
        ]
      : []),
    ...(config.policies
      ? [
          {
            description:
              "Site-specific policy information configured by admins.",
            href: publicPath("policies/policies"),
            title: "Policies",
          },
        ]
      : []),
  ];

  return (
    <PublicGrid columns={3}>
      {items.map((item) => (
        <PublicCard href={item.href} key={item.href} title={item.title}>
          <Paragraph style={{ margin: 0 }}>{item.description}</Paragraph>
        </PublicCard>
      ))}
    </PublicGrid>
  );
}

function PoliciesDetailPage({
  config,
  markdown,
  title,
}: {
  config?: PublicConfig;
  markdown?: string;
  title: string;
}) {
  if (!arePoliciesVisible(config) || getExternalPoliciesUrl(config)) {
    return <PolicyGateCard config={config} />;
  }
  if (!markdown) {
    return (
      <EmptySection label={`No ${title.toLowerCase()} content configured.`} />
    );
  }
  return <MarkdownSection value={markdown} />;
}

function PolicySubNav({ slug }: { slug?: string }) {
  const { token } = theme.useToken();
  const items = getBuiltinPolicyNavItems().map((item) => ({
    key: item.key,
    label: <a href={item.href}>{item.label}</a>,
  }));
  return (
    <Flex
      justify="center"
      style={{ minWidth: 0, paddingBlock: token.paddingXS }}
    >
      <Menu
        aria-label="Policy pages"
        disabledOverflow
        items={items}
        mode="horizontal"
        selectedKeys={slug == null ? [] : [slug]}
        style={{
          background: "transparent",
          borderBottom: 0,
          flex: "0 1 auto",
          lineHeight: "normal",
        }}
      />
    </Flex>
  );
}

function BuiltinPolicyPageShell({ slug }: { slug?: string }) {
  if (getBuiltinPolicy(slug) == null) {
    return <EmptySection label="This policy page was not found." />;
  }

  return (
    <div style={{ display: "grid" }}>
      <PolicySubNav slug={slug} />
      <PublicSection>
        <BuiltinPolicyPage slug={slug} />
      </PublicSection>
    </div>
  );
}

export default function PublicPoliciesApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicPoliciesRoute;
}) {
  const siteName = getSiteName(config);
  const title = titleForRoute(initialRoute, siteName);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell
      active="policies"
      config={config}
      title={
        initialRoute.view === "policies" ? `${siteName} Policies` : undefined
      }
    >
      {initialRoute.view === "policies-imprint" ? (
        <PoliciesDetailPage
          config={config}
          markdown={config?.imprint}
          title="Imprint"
        />
      ) : initialRoute.view === "policies-custom" ? (
        <PoliciesDetailPage
          config={config}
          markdown={config?.policies}
          title="Policies"
        />
      ) : initialRoute.view === "policies-detail" ? (
        !arePoliciesVisible(config) || getExternalPoliciesUrl(config) ? (
          <PolicyGateCard config={config} />
        ) : (
          <BuiltinPolicyPageShell slug={initialRoute.policySlug} />
        )
      ) : (
        <PoliciesHome config={config ?? {}} />
      )}
    </PublicSectionShell>
  );
}
