/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, type MouseEvent } from "react";

import { Button, Flex, theme, Typography } from "antd";
import {
  EmptySection,
  getSiteName,
  MarkdownSection,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import {
  arePublicPoliciesVisible,
  getExternalPoliciesUrl,
  getPublicMarketingConfig,
  publicPoliciesUseBuiltin,
  publicPoliciesUseCustom,
} from "@cocalc/frontend/public/config";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { publicPath } from "../routes";
import { PublicCard, PublicGrid, PublicSection } from "../layout/shell";
import {
  BUILTIN_POLICIES,
  getBuiltinPolicy,
  getBuiltinPolicyNavItems,
} from "./registry";
import {
  getPolicyNavLabel,
  PolicyDocument,
  preparePolicyContent,
  type PreparedPolicyContent,
  type PolicyTocItem,
  type PublicPolicy,
} from "./policy";
import type { PublicPoliciesRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

const POLICY_RAIL_CSS = `
  .cocalc-public-policy-rail-list {
    display: grid;
    gap: 0.15rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .cocalc-public-policy-rail-list a {
    border-left: 2px solid transparent;
    color: ${PUBLIC_COLORS.text};
    display: block;
    padding: 0.15rem 0 0.15rem 0.75rem;
    text-decoration: none;
  }

  .cocalc-public-policy-rail-list a:hover {
    color: ${PUBLIC_COLORS.linkHover};
  }

  .cocalc-public-policy-rail-list a[aria-current="page"] {
    border-left-color: ${PUBLIC_COLORS.brandSubtle};
    color: ${PUBLIC_COLORS.brandActive};
    font-weight: 700;
  }
`;

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

  if (!arePublicPoliciesVisible(config)) {
    return (
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Public policy pages are not configured
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
  if (!arePublicPoliciesVisible(config) || externalUrl) {
    return <PolicyGateCard config={config} />;
  }

  const items = [
    ...(publicPoliciesUseBuiltin(config)
      ? BUILTIN_POLICIES.map((policy) => ({
          description: policy.description,
          href: publicPath(`policies/${policy.slug}`),
          title: policy.title,
        }))
      : []),
    ...(publicPoliciesUseCustom(config) && config.imprint
      ? [
          {
            description: "Site-specific legal imprint information.",
            href: publicPath("policies/imprint"),
            title: "Imprint",
          },
        ]
      : []),
    ...(publicPoliciesUseCustom(config) && config.policies
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

  if (items.length === 0) {
    return <EmptySection label="No public policy content is configured." />;
  }

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
  if (!arePublicPoliciesVisible(config) || getExternalPoliciesUrl(config)) {
    return <PolicyGateCard config={config} />;
  }
  if (!publicPoliciesUseCustom(config)) {
    return (
      <EmptySection label={`No ${title.toLowerCase()} content configured.`} />
    );
  }
  if (!markdown) {
    return (
      <EmptySection label={`No ${title.toLowerCase()} content configured.`} />
    );
  }
  return <MarkdownSection value={markdown} />;
}

interface PolicyRailLink {
  current?: boolean;
  href: string;
  key: string;
  label: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

function PolicyRailLinkList({ items }: { items: readonly PolicyRailLink[] }) {
  return (
    <ul className="cocalc-public-policy-rail-list">
      {items.map((item) => (
        <li key={item.key}>
          <a
            aria-current={item.current ? "page" : undefined}
            href={item.href}
            onClick={item.onClick}
          >
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function getPolicyRailLinks(currentSlug: string): PolicyRailLink[] {
  return getBuiltinPolicyNavItems().map((item) => ({
    current: item.key === currentSlug,
    href: item.href,
    key: item.key,
    label: item.label,
  }));
}

function scrollToPolicySection(
  event: MouseEvent<HTMLAnchorElement>,
  id: string,
) {
  const element = document.getElementById(id);
  if (element == null) return;

  event.preventDefault();
  window.history.pushState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#${id}`,
  );
  element.scrollIntoView({ block: "start" });
}

function getPolicyTocRailLinks(
  items: readonly PolicyTocItem[],
): PolicyRailLink[] {
  return items.map((item) => ({
    href: `#${item.id}`,
    key: item.id,
    label: getPolicyNavLabel(item),
    onClick: (event) => scrollToPolicySection(event, item.id),
  }));
}

function PolicySideNav({
  currentSlug,
  tocItems,
}: {
  currentSlug: string;
  tocItems: readonly PolicyTocItem[];
}) {
  const { token } = theme.useToken();

  return (
    <>
      <style>{POLICY_RAIL_CSS}</style>
      <Flex
        vertical
        gap="large"
        style={{
          paddingBlockEnd: token.paddingSM,
          paddingBlockStart: token.paddingXS,
        }}
      >
        <nav aria-label="Policies">
          <Flex vertical gap="small">
            <Text strong type="secondary">
              Policies
            </Text>
            <PolicyRailLinkList items={getPolicyRailLinks(currentSlug)} />
          </Flex>
        </nav>
        {tocItems.length > 0 ? (
          <nav aria-label="On this page">
            <Flex vertical gap="small">
              <Text strong type="secondary">
                On this page
              </Text>
              <PolicyRailLinkList items={getPolicyTocRailLinks(tocItems)} />
            </Flex>
          </nav>
        ) : null}
      </Flex>
    </>
  );
}

function BuiltinPolicyPageShell({
  policy,
  preparedPolicy,
  siteName,
}: {
  policy?: PublicPolicy;
  preparedPolicy?: PreparedPolicyContent;
  siteName: string;
}) {
  if (policy == null || preparedPolicy == null) {
    return <EmptySection label="This policy page was not found." />;
  }

  return (
    <PublicSection>
      <PolicyDocument
        content={preparedPolicy.content}
        policy={policy}
        siteName={siteName}
      />
    </PublicSection>
  );
}

export default function PublicPoliciesApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicPoliciesRoute;
}) {
  const marketingConfig = getPublicMarketingConfig(config);
  const siteName = getSiteName(marketingConfig);
  const title = titleForRoute(initialRoute, siteName);
  const builtinPolicy =
    initialRoute.view === "policies-detail" &&
    arePublicPoliciesVisible(marketingConfig) &&
    !getExternalPoliciesUrl(marketingConfig) &&
    publicPoliciesUseBuiltin(marketingConfig)
      ? getBuiltinPolicy(initialRoute.policySlug)
      : undefined;
  const preparedPolicy =
    builtinPolicy == null
      ? undefined
      : preparePolicyContent(builtinPolicy.content);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell
      active="policies"
      config={marketingConfig}
      sider={
        builtinPolicy != null && preparedPolicy != null ? (
          <PolicySideNav
            currentSlug={builtinPolicy.slug}
            tocItems={preparedPolicy.tocItems}
          />
        ) : undefined
      }
      siderLabel="Policy navigation"
      title={
        initialRoute.view === "policies" ? `${siteName} Policies` : undefined
      }
    >
      {initialRoute.view === "policies-imprint" ? (
        <PoliciesDetailPage
          config={marketingConfig}
          markdown={marketingConfig?.imprint}
          title="Imprint"
        />
      ) : initialRoute.view === "policies-custom" ? (
        <PoliciesDetailPage
          config={marketingConfig}
          markdown={marketingConfig?.policies}
          title="Policies"
        />
      ) : initialRoute.view === "policies-detail" ? (
        !arePublicPoliciesVisible(marketingConfig) ||
        getExternalPoliciesUrl(marketingConfig) ? (
          <PolicyGateCard config={marketingConfig} />
        ) : !publicPoliciesUseBuiltin(marketingConfig) ? (
          <EmptySection label="This policy page was not found." />
        ) : (
          <BuiltinPolicyPageShell
            policy={builtinPolicy}
            preparedPolicy={preparedPolicy}
            siteName={siteName}
          />
        )
      ) : (
        <PoliciesHome config={marketingConfig ?? {}} />
      )}
    </PublicSectionShell>
  );
}
