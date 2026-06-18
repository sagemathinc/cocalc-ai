/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, type MouseEvent, type ReactNode } from "react";

import { Button, Flex, theme, Typography } from "antd";
import {
  EmptySection,
  getSiteName,
  MarkdownSection,
  type PublicConfig,
  PublicNextStep,
  PublicSectionShell,
} from "../common";
import {
  arePublicPoliciesVisible,
  getExternalPoliciesUrl,
  getPublicMarketingConfig,
  publicPoliciesUseBuiltin,
  publicPoliciesUseCustom,
} from "@cocalc/frontend/public/config";
import { PUBLIC_COLORS, PUBLIC_RADIUS } from "@cocalc/frontend/public/theme";
import { publicPath } from "../routes";
import { PublicCard, PublicGrid, PublicSection } from "../layout/shell";
import {
  BUILTIN_POLICIES,
  getBuiltinPolicy,
  getBuiltinPolicyNavItems,
} from "./registry";
import {
  COCALC_TRUST_CENTER_URL,
  getPolicyNavLabel,
  PolicyDocument,
  preparePolicyContent,
  type PreparedPolicyContent,
  type PolicyTocItem,
  type PublicPolicy,
} from "./policy";
import type { PublicPoliciesRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

interface PolicyEvaluationLink {
  body: string;
  href: string;
  label: string;
  title: string;
}

const POLICY_EVALUATION_LINKS: PolicyEvaluationLink[] = [
  {
    body: "Hosted, local, single-VM, and customer-operated paths.",
    href: publicPath("products"),
    label: "Compare operating models",
    title: "Choose an operating model",
  },
  {
    body: "Hosted memberships, site licensing, and buying routes.",
    href: publicPath("pricing"),
    label: "Review pricing",
    title: "Plan pricing or licensing",
  },
  {
    body: "Security, privacy, procurement, and deployment-context questions.",
    href: publicPath(
      `support/new?${new URLSearchParams({
        body: "I am reviewing CoCalc policy, trust, privacy, or data-processing materials and want help understanding the right next step for my organization.",
        context: "policy-evidence-review",
        subject: "CoCalc policy and trust review",
        title: "Ask CoCalc about policy and trust review",
        type: "purchase",
      }).toString()}`,
    ),
    label: "Ask about policy review",
    title: "Ask about policy review",
  },
];

function policySupportHref(policy: PublicPolicy): string {
  return publicPath(
    `support/new?${new URLSearchParams({
      body: `I am reviewing ${policy.title} and want help understanding how it applies to my CoCalc evaluation.`,
      context: `policy-${policy.slug}`,
      subject: policy.title,
      title: `Ask CoCalc about ${policy.title}`,
      type: "purchase",
    }).toString()}`,
  );
}

function policyBuyerQuestion(policy: PublicPolicy): string {
  switch (policy.slug) {
    case "trust":
      return "Where should a security or compliance review start?";
    case "privacy":
      return "How does SageMath, Inc. describe privacy practices for CoCalc?";
    case "dpa":
      return "What data-processing terms apply when SageMath, Inc. processes personal data on a user's behalf?";
    case "terms":
      return "What terms govern use of CoCalc and related services?";
    case "ferpa":
      return "How should an educational institution evaluate FERPA-related questions?";
    case "accessibility":
      return "What accessibility material is available for CoCalc evaluation?";
    case "copyright":
      return "How does CoCalc handle copyright and DMCA requests?";
    default:
      return "What policy question does this page answer?";
  }
}

function policyBuyerSummary(policy: PublicPolicy): ReactNode {
  switch (policy.slug) {
    case "trust":
      return (
        <>
          Review CoCalc&apos;s published SOC 2, GDPR, and Trust Center
          references. Use the external Trust Center for the current trust status
          during evaluation.
        </>
      );
    case "privacy":
      return (
        <>
          Review the privacy policy that explains SageMath, Inc.&apos;s
          practices for collection, use, disclosure, revisions, and privacy
          questions related to CoCalc services.
        </>
      );
    case "dpa":
      return (
        <>
          Review the data-processing addendum covering processing scope,
          subprocessors, security-of-processing terms, data subject rights,
          transfers, deletion or return, audit, and liability terms.
        </>
      );
    default:
      return policy.description;
  }
}

function PolicyEvidenceSummary({ policy }: { policy: PublicPolicy }) {
  const showTrustCenter = policy.slug === "trust" || policy.slug === "dpa";

  return (
    <div
      style={{
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        marginBottom: 24,
        padding: 16,
      }}
    >
      <Flex vertical gap="small">
        <Text strong>{policyBuyerQuestion(policy)}</Text>
        <Paragraph style={{ margin: 0 }}>
          {policyBuyerSummary(policy)}
        </Paragraph>
        <Flex gap={8} role="group" aria-label="Policy next steps" wrap>
          {showTrustCenter ? (
            <Button
              href={COCALC_TRUST_CENTER_URL}
              rel="noreferrer"
              target="_blank"
              type={policy.slug === "trust" ? "primary" : "default"}
            >
              Open Trust Center
            </Button>
          ) : null}
          <Button href={publicPath("products")}>
            Compare operating models
          </Button>
          <Button href={publicPath("pricing")}>Review pricing</Button>
          <Button href={policySupportHref(policy)}>
            Ask about this policy
          </Button>
        </Flex>
      </Flex>
    </div>
  );
}

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
        <Title level={2} style={{ margin: 0 }}>
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
      <Title level={2} style={{ margin: 0 }}>
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
    <Flex vertical gap="large">
      <PublicSection
        intro="Use these pages when you need the formal terms, privacy, data-processing, trust, accessibility, copyright, or education-policy materials behind a CoCalc evaluation."
        title="Policy and trust resources"
      >
        <PublicGrid columns={3}>
          {items.map((item) => (
            <PublicCard href={item.href} key={item.href} title={item.title}>
              <Paragraph style={{ margin: 0 }}>{item.description}</Paragraph>
            </PublicCard>
          ))}
        </PublicGrid>
      </PublicSection>

      <PublicSection
        intro="After reviewing the policy material, continue with the product, pricing, or support path that matches the decision you are making."
        title="Continue the evaluation"
      >
        <PublicGrid columns={3}>
          {POLICY_EVALUATION_LINKS.map((item) => (
            <PublicCard href={item.href} key={item.href} title={item.title}>
              <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
            </PublicCard>
          ))}
        </PublicGrid>
      </PublicSection>

      <PublicNextStep authenticated={!!config?.is_authenticated} />
    </Flex>
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
        beforeContent={<PolicyEvidenceSummary policy={policy} />}
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
