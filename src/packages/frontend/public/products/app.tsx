/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { getPublicMarketingConfig } from "@cocalc/frontend/public/config";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { CANONICAL_PUBLIC_SITE_ORIGIN } from "@cocalc/util/public-site-policy";
import {
  appPath,
  builtinPolicyPath,
  LinkButton,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { publicPath } from "../routes";
import { PublicGrid, PublicSection } from "../layout/shell";
import { CodeBlock } from "../common";
import type { PublicProductsRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

const PRODUCT_OVERVIEW_CSS = `
.cocalc-products-overview-hero {
  background:
    radial-gradient(circle at 88% 12%, ${alpha(PUBLIC_COLORS.brand, 0.12)}, transparent 34%),
    linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 100%);
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  overflow: hidden;
  padding: clamp(24px, 4vw, 48px);
}

.cocalc-products-overview-title.ant-typography {
  font-size: clamp(38px, 5vw, 58px);
  letter-spacing: -0.045em;
  line-height: 1.04;
  margin: 0;
  max-width: 12ch;
}

.cocalc-products-overview-eyebrow {
  color: ${PUBLIC_COLORS.brand};
  font-size: ${PUBLIC_TYPE.eyebrow}px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.cocalc-products-decision-list {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.media}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  padding: 20px;
}

.cocalc-products-decision-row {
  align-items: flex-start;
  border-bottom: 1px solid ${PUBLIC_COLORS.border};
  display: grid;
  gap: 12px;
  grid-template-columns: 30px minmax(0, 1fr);
  padding: 14px 0;
}

.cocalc-products-decision-row:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.cocalc-products-decision-number {
  align-items: center;
  background: ${PUBLIC_COLORS.brandTint};
  border: 1px solid ${PUBLIC_COLORS.brandSubtle};
  border-radius: 50%;
  color: ${PUBLIC_COLORS.brand};
  display: flex;
  font-size: 12px;
  font-weight: 700;
  height: 30px;
  justify-content: center;
  width: 30px;
}

.cocalc-products-model-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.cocalc-products-model-card {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.card};
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 22px;
}

.cocalc-products-model-meta {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  padding: 12px 14px;
}

.cocalc-products-path-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
}

.cocalc-products-path-option {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  color: inherit;
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto;
  padding: 13px 14px;
  text-decoration: none;
}

.cocalc-products-path-option:hover {
  border-color: ${PUBLIC_COLORS.linkHover};
  color: inherit;
}

.cocalc-products-workflow-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.cocalc-products-workflow-card {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.card};
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
  padding: 20px;
}

@media (max-width: 900px) {
  .cocalc-products-model-grid,
  .cocalc-products-workflow-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .cocalc-products-overview-hero {
    padding: 22px 18px;
  }

  .cocalc-products-overview-title.ant-typography {
    font-size: clamp(34px, 12vw, 48px);
    max-width: 10.5ch;
  }

  .cocalc-products-overview-hero .ant-btn {
    width: 100%;
  }
}
`;

interface ProductAction {
  href: string;
  label: string;
  primary?: boolean;
}

function supportContactPath({
  body,
  context,
  subject,
  title,
}: {
  body: string;
  context: string;
  subject: string;
  title: string;
}): string {
  const params = new URLSearchParams({
    body,
    context,
    subject,
    title,
    type: "purchase",
  });
  return `${appPath("support/new")}?${params.toString()}`;
}

function supportProductPath(product: "Launchpad" | "Rocket"): string {
  if (product === "Launchpad") {
    return supportContactPath({
      body: "I want to talk with CoCalc about CoCalc Launchpad. Helpful context: expected users or projects, pilot/lab/workshop/department scope, operating environment, who will own infrastructure, recovery, and ongoing operations, timeline, support expectations, and whether pricing, site licensing, data-location, privacy, or security questions are part of the decision.",
      context: "product-cocalc-launchpad",
      subject: "CoCalc Launchpad",
      title: "Talk with CoCalc about Launchpad",
    });
  }
  return supportContactPath({
    body: "I want to talk with CoCalc about CoCalc Rocket. Helpful context: organization type, expected users or projects, private-cloud requirements, infrastructure constraints, and timeline.",
    context: "product-cocalc-rocket",
    subject: "CoCalc Rocket",
    title: "Talk with CoCalc about Rocket",
  });
}

interface ProductDetailPoint {
  body: ReactNode;
  icon: IconName;
  title: string;
}

function titleForRoute(route: PublicProductsRoute): string {
  switch (route.view) {
    case "products-cocalc-launchpad":
      return "CoCalc Launchpad";
    case "products-cocalc-plus":
      return "CoCalc Plus";
    case "products-cocalc-rocket":
      return "CoCalc Rocket";
    case "products-cocalc-star":
      return "CoCalc Star";
    case "products":
    default:
      return "Ways to Run CoCalc";
  }
}

function ProductsOverviewPage({ config }: { config?: PublicConfig }) {
  const privacyHref = builtinPolicyPath(config, "privacy");
  const trustHref = builtinPolicyPath(config, "trust");
  const hostedPricingHref = `${CANONICAL_PUBLIC_SITE_ORIGIN}/pricing`;
  const canEvaluateResearchCompute =
    getPublicFeaturePage("research-compute", {
      cocalc_product: config?.cocalc_product,
    }) != null;
  const models = [
    {
      fit: "Individuals and teams that want managed hosted projects without operating CoCalc infrastructure.",
      icon: "cloud",
      operator: "CoCalc operates the service and its platform infrastructure.",
      paths: [
        {
          detail: "Managed hosted projects for individuals and teams.",
          href: hostedPricingHref,
          title: "CoCalc.ai",
        },
      ],
      startHere: true,
      title: "Hosted by CoCalc",
    },
    {
      fit: "Local individual work or a small shared site when you accept responsibility for the runtime, updates, and recovery.",
      icon: "laptop",
      operator: "You or your team operate the machine and the CoCalc runtime.",
      paths: [
        {
          detail: "A local, one-user runtime on Linux or macOS.",
          href: publicPath("products/cocalc-plus"),
          title: "CoCalc Plus",
        },
        {
          detail: "A shared CoCalc site on one public Ubuntu VM.",
          href: publicPath("products/cocalc-star"),
          title: "CoCalc Star",
        },
      ],
      startHere: false,
      title: "Run it yourself",
    },
    {
      fit: "Pilots through institutional deployments that need private infrastructure, explicit operating ownership, and commercial planning.",
      icon: "servers",
      operator:
        "Your organization operates the infrastructure, recovery, and ongoing service.",
      paths: [
        {
          detail:
            "A bounded private deployment for a pilot, lab, workshop, team, or department.",
          href: publicPath("products/cocalc-launchpad"),
          title: "CoCalc Launchpad",
        },
        {
          detail:
            "Broader customer-operated private-cloud planning for an institution or enterprise.",
          href: publicPath("products/cocalc-rocket"),
          title: "CoCalc Rocket",
        },
      ],
      startHere: false,
      title: "Customer-operated private deployment",
    },
  ] satisfies {
    fit: string;
    icon: IconName;
    operator: string;
    paths: { detail: string; href: string; title: string }[];
    startHere: boolean;
    title: string;
  }[];

  const workflowLinks = [
    {
      body: "See how people and agents use the same project files, notebooks, terminals, services, and review context.",
      href: publicPath("features/ai"),
      icon: "robot",
      label: "Explore AI agent workflows",
      title: "Agents and collaboration",
    },
    ...(canEvaluateResearchCompute
      ? [
          {
            body: "Compare whole-project hosts, remote Jupyter kernels, and optional managed VMs before choosing capacity.",
            href: publicPath("features/research-compute"),
            icon: "server" as IconName,
            label: "Plan research compute",
            title: "Compute capacity",
          },
        ]
      : []),
    {
      body: "Decide whether the work needs a persistent shared workspace or an API-managed execution environment.",
      href: publicPath("features/compare"),
      icon: "exchange",
      label: "Compare with agent sandboxes",
      title: "Execution model",
    },
  ] satisfies {
    body: string;
    href: string;
    icon: IconName;
    label: string;
    title: string;
  }[];

  return (
    <Flex vertical gap={48}>
      <style>{PRODUCT_OVERVIEW_CSS}</style>
      <section
        aria-labelledby="cocalc-products-overview-title"
        className="cocalc-products-overview-hero"
      >
        <Row align="middle" gutter={[40, 36]}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={22}>
              <Text className="cocalc-products-overview-eyebrow">
                Operating models
              </Text>
              <Title
                className="cocalc-products-overview-title"
                id="cocalc-products-overview-title"
                level={2}
              >
                Choose who operates CoCalc and where it runs.
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  fontSize: PUBLIC_TYPE.lead,
                  lineHeight: 1.6,
                  margin: 0,
                  maxWidth: 680,
                }}
              >
                Start with the operating boundary, then choose the product.
                Every path keeps files, notebooks, terminals, and services in a
                project workspace that persists across sessions. Collaboration,
                history, recovery, compute, and agent features depend on the
                product and deployment.
              </Paragraph>
              <Flex gap={12} wrap>
                <Button href={hostedPricingHref} size="large" type="primary">
                  Start on CoCalc.ai
                </Button>
                <Button href={publicPath("features/compare")} size="large">
                  Compare execution models
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <div className="cocalc-products-decision-list">
              <Text strong>Answer these first</Text>
              {[
                {
                  body: "CoCalc, an individual user, or your organization",
                  title: "Who operates the service?",
                },
                {
                  body: "CoCalc-hosted, one machine, or private infrastructure",
                  title: "Where should it run?",
                },
                {
                  body: "Individual work, a small shared site, or an organizational rollout",
                  title: "Who needs to use it?",
                },
              ].map((item, index) => (
                <div className="cocalc-products-decision-row" key={item.title}>
                  <span className="cocalc-products-decision-number">
                    {index + 1}
                  </span>
                  <div>
                    <Text strong style={{ display: "block" }}>
                      {item.title}
                    </Text>
                    <Text style={{ color: PUBLIC_COLORS.mutedText }}>
                      {item.body}
                    </Text>
                  </div>
                </div>
              ))}
            </div>
          </Col>
        </Row>
      </section>

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Three operating models, five product paths.
        </Title>
        <Paragraph
          style={{
            color: PUBLIC_COLORS.mutedText,
            fontSize: PUBLIC_TYPE.lead,
            margin: 0,
            maxWidth: 780,
          }}
        >
          Pick the model that matches operational ownership. The product links
          then show the narrower installation, deployment, and commercial
          boundary.
        </Paragraph>
        <div
          aria-label="CoCalc operating model chooser"
          className="cocalc-products-model-grid"
          role="list"
        >
          {models.map((model) => (
            <article
              className="cocalc-products-model-card"
              key={model.title}
              role="listitem"
            >
              <Flex align="center" gap={12}>
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background: PUBLIC_COLORS.brandTint,
                    border: `1px solid ${PUBLIC_COLORS.brandSubtle}`,
                    borderRadius: PUBLIC_RADIUS.panel,
                    color: PUBLIC_COLORS.brand,
                    display: "flex",
                    flex: "0 0 42px",
                    fontSize: 20,
                    height: 42,
                    justifyContent: "center",
                    width: 42,
                  }}
                >
                  <Icon name={model.icon} />
                </span>
                <div style={{ minWidth: 0 }}>
                  {model.startHere ? (
                    <Text
                      strong
                      style={{
                        color: PUBLIC_COLORS.brand,
                        display: "block",
                        fontSize: PUBLIC_TYPE.caption,
                        textTransform: "uppercase",
                      }}
                    >
                      Fastest path to start
                    </Text>
                  ) : null}
                  <Title level={3} style={{ margin: 0 }}>
                    {model.title}
                  </Title>
                </div>
              </Flex>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
                {model.fit}
              </Paragraph>
              <div className="cocalc-products-model-meta">
                <Text
                  strong
                  style={{
                    display: "block",
                    fontSize: PUBLIC_TYPE.caption,
                    marginBottom: 4,
                    textTransform: "uppercase",
                  }}
                >
                  Operating owner
                </Text>
                <Text>{model.operator}</Text>
              </div>
              <div className="cocalc-products-path-list">
                {model.paths.map((path) => (
                  <a
                    className="cocalc-products-path-option"
                    href={path.href}
                    key={path.title}
                  >
                    <span>
                      <Text strong style={{ display: "block" }}>
                        {path.title}
                      </Text>
                      <Text style={{ color: PUBLIC_COLORS.mutedText }}>
                        {path.detail}
                      </Text>
                    </span>
                    <span
                      aria-hidden="true"
                      style={{
                        color: PUBLIC_COLORS.brand,
                        paddingTop: 2,
                      }}
                    >
                      <Icon name="arrow-right" />
                    </span>
                  </a>
                ))}
              </div>
            </article>
          ))}
        </div>
      </PublicSection>

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Plan the workflow after the operating model.
        </Title>
        <Paragraph
          style={{
            color: PUBLIC_COLORS.mutedText,
            fontSize: PUBLIC_TYPE.lead,
            margin: 0,
            maxWidth: 780,
          }}
        >
          The product choice tells you who runs CoCalc. The next decision is how
          people, agents, and compute should use the project within that
          deployment.
        </Paragraph>
        <div className="cocalc-products-workflow-grid">
          {workflowLinks.map((item) => (
            <div className="cocalc-products-workflow-card" key={item.title}>
              <span
                aria-hidden="true"
                style={{ color: PUBLIC_COLORS.brand, fontSize: 22 }}
              >
                <Icon name={item.icon} />
              </span>
              <Title level={3} style={{ margin: 0 }}>
                {item.title}
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  flex: 1,
                  margin: 0,
                }}
              >
                {item.body}
              </Paragraph>
              <LinkButton href={item.href}>{item.label}</LinkButton>
            </div>
          ))}
        </div>
      </PublicSection>

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Add procurement, governance, and support to the chosen path.
        </Title>
        <Paragraph
          style={{
            color: PUBLIC_COLORS.mutedText,
            fontSize: PUBLIC_TYPE.lead,
            margin: 0,
            maxWidth: 780,
          }}
        >
          Use site licensing for procurement, governance, support expectations,
          rollout, data-location, privacy, or security questions. Licensing does
          not decide where CoCalc runs or who operates it; apply it to the
          hosted, local, single-VM, or private path you selected.
        </Paragraph>
        <Flex gap={12} wrap>
          <Button
            href={supportContactPath({
              body: "I want to talk with CoCalc about operating model, site licensing, or an organizational buying route. Helpful context: where you want CoCalc to run, who will operate it, expected users or projects, procurement needs, data-location, privacy, or security questions, and support expectations.",
              context: "products-site-licensing",
              subject: "Operating model and site licensing",
              title: "Talk with CoCalc about operating models",
            })}
            size="large"
            type="primary"
          >
            Discuss an organizational path
          </Button>
          <Button href={appPath("pricing")} size="large">
            Review pricing and licensing
          </Button>
        </Flex>
        {trustHref || privacyHref ? (
          <Flex aria-label="Product trust materials" gap={14} role="group" wrap>
            {trustHref ? (
              <LinkButton href={trustHref}>
                Review trust and compliance
              </LinkButton>
            ) : null}
            {privacyHref ? (
              <LinkButton href={privacyHref}>Review privacy policy</LinkButton>
            ) : null}
          </Flex>
        ) : null}
      </PublicSection>
    </Flex>
  );
}

function ProductActions({ actions }: { actions: ProductAction[] }) {
  return (
    <Flex gap={12} wrap>
      {actions.map((action) => (
        <Button
          href={action.href}
          key={`${action.label}-${action.href}`}
          type={action.primary ? "primary" : "default"}
        >
          {action.label}
        </Button>
      ))}
    </Flex>
  );
}

function ProductLeadSection({
  actions,
  body,
  title,
}: {
  actions: ProductAction[];
  body: ReactNode;
  title: string;
}) {
  return (
    <PublicSection>
      <Title
        level={2}
        style={{ fontSize: PUBLIC_TYPE.title, lineHeight: 1.3, margin: 0 }}
      >
        {title}
      </Title>
      <Paragraph
        style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: "72ch" }}
      >
        {body}
      </Paragraph>
      <ProductActions actions={actions} />
    </PublicSection>
  );
}

function ProductSharedProjectNote() {
  return (
    <div
      aria-label="Shared CoCalc project context"
      role="note"
      style={{
        borderLeft: `3px solid ${PUBLIC_COLORS.brandSubtle}`,
        color: PUBLIC_COLORS.mutedText,
        fontSize: PUBLIC_TYPE.body,
        lineHeight: 1.55,
        maxWidth: "76ch",
        padding: "2px 0 2px 14px",
      }}
    >
      <Text strong>One project model, different operating paths.</Text>{" "}
      <Text style={{ color: PUBLIC_COLORS.mutedText }}>
        The product path changes where CoCalc runs and who operates it. Files,
        notebooks, and terminals stay organized around a project; collaboration,
        history, recovery, and agent features depend on the product and
        deployment configuration.
      </Text>
    </div>
  );
}

function ProductDetailCard({
  children,
  icon,
  role,
  title,
}: {
  children: ReactNode;
  icon: IconName;
  role?: "listitem";
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="cocalc-public-products-detail-card"
      role={role}
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        height: "100%",
        minHeight: 188,
        padding: 18,
      }}
    >
      <Flex align="center" gap={10}>
        <span
          aria-hidden="true"
          style={{
            alignItems: "center",
            background: PUBLIC_COLORS.surfaceMuted,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: 8,
            color: PUBLIC_COLORS.brand,
            display: "flex",
            flex: "0 0 38px",
            height: 38,
            justifyContent: "center",
            width: 38,
          }}
        >
          <Icon name={icon} />
        </span>
        <Title
          level={3}
          style={{ fontSize: PUBLIC_TYPE.title, lineHeight: 1.3, margin: 0 }}
        >
          {title}
        </Title>
      </Flex>
      <div style={{ flex: 1 }}>{children}</div>
    </section>
  );
}

function ProductDetailGrid({
  items,
  label,
}: {
  items: ProductDetailPoint[];
  label: string;
}) {
  return (
    <div
      aria-label={label}
      role="list"
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
      }}
    >
      {items.map((item) => (
        <ProductDetailCard
          icon={item.icon}
          key={item.title}
          role="listitem"
          title={item.title}
        >
          <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
        </ProductDetailCard>
      ))}
    </div>
  );
}

function ProductNotesList({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {items.map((item, index) => (
        <li
          key={index}
          style={{ marginBottom: index === items.length - 1 ? 0 : 8 }}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function CocalcRocketPage() {
  const detailItems = [
    {
      body: "Industry R&D organizations, research and national labs, enterprises, and government teams planning a broader customer-operated CoCalc deployment with governance, procurement, support, and rollout requirements.",
      icon: "rocket",
      title: "Who it fits",
    },
    {
      body: "Runs on customer-operated infrastructure. The repository provides a systemd/VM bay runtime bundle and a minimal Kubernetes Helm chart to adapt to the chosen environment. Project compute runs on project hosts.",
      icon: "servers",
      title: "How it runs",
    },
    {
      body: "Use Rocket when the deployment decision includes private infrastructure, capacity planning, operational ownership, support expectations, and commercial terms.",
      icon: "cloud",
      title: "When to choose it",
    },
  ] satisfies ProductDetailPoint[];

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection
        actions={[
          {
            href: supportProductPath("Rocket"),
            label: "Talk with CoCalc about Rocket",
            primary: true,
          },
          { href: appPath("pricing"), label: "Pricing and licensing" },
        ]}
        title="Planning an institutional private CoCalc deployment?"
        body="Run durable projects inside infrastructure you control and govern."
      />
      <ProductSharedProjectNote />
      <ProductDetailGrid
        items={detailItems}
        label="CoCalc Rocket positioning"
      />
      <PublicGrid columns={2}>
        <ProductDetailCard
          icon="rocket"
          title="Boundary: planned private cloud"
        >
          <ProductNotesList
            items={[
              "Rocket starts with a deployment and commercial conversation, not a self-service installer.",
              "It is for customer-operated private-cloud planning with infrastructure, governance, support requirements, and clear ownership of ongoing operations.",
              "Use Launchpad when the immediate need is a smaller bounded private deployment.",
            ]}
          />
        </ProductDetailCard>
        <ProductDetailCard icon="servers" title="Plan Rocket with CoCalc">
          <Paragraph style={{ marginTop: 0 }}>
            Start with support when the decision includes infrastructure,
            rollout, governance, site licensing, or deployment-planning
            expectations.
          </Paragraph>
          <ProductActions
            actions={[
              {
                href: publicPath("products/cocalc-launchpad"),
                label: "View CoCalc Launchpad",
              },
              {
                href: publicPath("products"),
                label: "All product paths",
              },
            ]}
          />
        </ProductDetailCard>
      </PublicGrid>
    </Flex>
  );
}

function CocalcStarPage() {
  const installCommand =
    "curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/download/cocalc-star-stable/install-cocalc-star.sh | sudo bash";
  const detailItems = [
    {
      body: "Small groups that want collaborators in one browser-based CoCalc instance on a public VM.",
      icon: "star",
      title: "Who it fits",
    },
    {
      body: "Runs on one fresh public Ubuntu VM with ports 80 and 443 open. The installer sets up the CoCalc instance, HTTPS, onboarding, and the first admin flow.",
      icon: "servers",
      title: "How it runs",
    },
    {
      body: "Use Star when you want a shared CoCalc site on your own VM without manually assembling DNS, TLS, port forwarding, and cloud-provider-specific setup.",
      icon: "cloud",
      title: "When to choose it",
    },
  ] satisfies ProductDetailPoint[];

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection
        actions={[
          {
            href: "#install-cocalc-star",
            label: "Install CoCalc Star",
            primary: true,
          },
          {
            href: publicPath("products/cocalc-launchpad"),
            label: "View CoCalc Launchpad",
          },
          {
            href: publicPath("products/cocalc-rocket"),
            label: "View CoCalc Rocket",
          },
        ]}
        title="Run a shared CoCalc site on one Ubuntu VM."
        body="The installer sets up HTTPS and onboarding, so collaborators can start together."
      />
      <ProductSharedProjectNote />
      <ProductDetailGrid items={detailItems} label="CoCalc Star positioning" />
      <PublicGrid columns={2}>
        <ProductDetailCard icon="star" title="Install CoCalc Star">
          <div id="install-cocalc-star" />
          <Paragraph style={{ margin: 0 }}>
            On a fresh Ubuntu 24.04 VM with ports 80 and 443 open, run:
          </Paragraph>
          <CodeBlock ariaLabel="Install command" code={installCommand} />
          <Flex gap={12} wrap>
            <Button href="https://github.com/sagemathinc/cocalc-ai/releases/download/cocalc-star-stable/install-cocalc-star.sh">
              Open install script
            </Button>
            <Button href="https://github.com/sagemathinc/cocalc-ai/releases/tag/cocalc-star-stable">
              Stable channel
            </Button>
            <Button href={appPath("docs/self-hosting/cocalc-star")}>
              Read Star setup guide
            </Button>
          </Flex>
          <Paragraph style={{ margin: 0 }}>
            The installer automatically detects the VM's public IP address, sets
            up a secure HTTPS certificate, and shows a web onboarding page
            before continuing.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            The setup guide covers the firewall, onboarding, first admin,
            project-start, and invite-user checks.
          </Paragraph>
        </ProductDetailCard>
        <ProductDetailCard icon="servers" title="Boundary: one public VM">
          <ProductNotesList
            items={[
              "Use Star for one public VM, one local compute host, and a small shared site.",
              "Star is not a high-availability or scale-out private-cloud deployment.",
              "Use Launchpad or Rocket when private deployment or institutional rollout is the real decision.",
            ]}
          />
        </ProductDetailCard>
      </PublicGrid>
    </Flex>
  );
}

function CocalcLaunchpadPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-launchpad/install.sh | bash";
  const detailItems = [
    {
      body: "Workshops and departments that need a customer-operated CoCalc environment for a bounded group, run by their own IT or operations team.",
      icon: "servers",
      title: "Who it fits",
    },
    {
      body: "Runs as a lightweight private deployment operated by the customer. It gives operators more control over the environment than Star.",
      icon: "cloud",
      title: "How it runs",
    },
    {
      body: "Use Launchpad when a hosted account is not the right fit and a single public-VM appliance is too constrained for the pilot or department.",
      icon: "star",
      title: "When to choose it",
    },
  ] satisfies ProductDetailPoint[];

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection
        actions={[
          {
            href: supportProductPath("Launchpad"),
            label: "Talk with CoCalc about Launchpad",
            primary: true,
          },
          {
            href: "#install-cocalc-launchpad",
            label: "Review Launchpad installer",
          },
          { href: appPath("pricing"), label: "Pricing and licensing" },
          {
            href: publicPath("products/cocalc-star"),
            label: "View CoCalc Star",
          },
        ]}
        title="Need a bounded private CoCalc deployment?"
        body="A lightweight private environment you operate — more control than a hosted account."
      />
      <ProductSharedProjectNote />
      <ProductDetailGrid
        items={detailItems}
        label="CoCalc Launchpad positioning"
      />
      <PublicGrid columns={2}>
        <ProductDetailCard icon="servers" title="Install CoCalc Launchpad">
          <div id="install-cocalc-launchpad" />
          <Paragraph style={{ margin: 0 }}>
            For evaluation or operator setup, copy and run this in your
            terminal:
          </Paragraph>
          <CodeBlock ariaLabel="Install command" code={installCommand} />
          <Flex gap={12} wrap>
            <Button href="https://software.cocalc.ai/software/cocalc-launchpad/install.sh">
              Open install script
            </Button>
            <Button href="https://software.cocalc.ai/software/cocalc-launchpad/index.html">
              Open software page
            </Button>
          </Flex>
          <Paragraph style={{ margin: 0 }}>
            Current supported targets are Linux on x64 or arm64, and macOS on
            arm64.
          </Paragraph>
        </ProductDetailCard>
        <ProductDetailCard
          icon="cloud"
          title="Boundary: bounded private deployment"
        >
          <ProductNotesList
            items={[
              "Launchpad is customer-operated and sized for a pilot, lab, workshop, department, or platform team.",
              "The customer or administrator owns infrastructure, recovery, and ongoing operations.",
              "Use Star if one public Ubuntu VM is enough.",
              "Use Rocket when governance, support, and broader private-cloud planning are the main decision.",
            ]}
          />
        </ProductDetailCard>
      </PublicGrid>
    </Flex>
  );
}

function CocalcPlusPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash";
  const detailItems = [
    {
      body: "Individual users who want a local CoCalc project environment before choosing hosted collaboration or a shared deployment.",
      icon: "laptop",
      title: "Who it fits",
    },
    {
      body: "Runs on one Linux or macOS machine and is operated by the user. It is the local, one-user runtime in the product family.",
      icon: "cloud",
      title: "How it runs",
    },
    {
      body: "Use Plus for local evaluation, demos, personal projects, and learning the CoCalc project model without creating a hosted account.",
      icon: "star",
      title: "When to choose it",
    },
  ] satisfies ProductDetailPoint[];

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection
        actions={[
          {
            href: "#install-cocalc-plus",
            label: "Install CoCalc Plus",
            primary: true,
          },
          { href: appPath("pricing"), label: "Pricing and licensing" },
          {
            href: publicPath("products/cocalc-star"),
            label: "View CoCalc Star",
          },
        ]}
        title="Need local CoCalc before choosing a shared path?"
        body="Use the same project-centered workflow on your own machine, with the runtime and local data under your control."
      />
      <ProductSharedProjectNote />
      <ProductDetailGrid items={detailItems} label="CoCalc Plus positioning" />
      <PublicGrid columns={2}>
        <ProductDetailCard icon="laptop" title="Install CoCalc Plus locally">
          <div id="install-cocalc-plus" />
          <Paragraph style={{ margin: 0 }}>
            The current install flow uses the hosted software distribution:
          </Paragraph>
          <CodeBlock ariaLabel="Install command" code={installCommand} />
          <Flex gap={12} wrap>
            <Button href="https://software.cocalc.ai/software/cocalc-plus/install.sh">
              Open install script
            </Button>
          </Flex>
          <Paragraph style={{ margin: 0 }}>
            Current target platforms are Linux and macOS. The installer places
            the runtime in a user-owned location and adds a launcher if needed.
          </Paragraph>
        </ProductDetailCard>
        <ProductDetailCard
          icon="cloud"
          title="Boundary: local, one-user runtime"
        >
          <ProductNotesList
            items={[
              "Plus is for local evaluation or individual work on one machine.",
              "It is self-serve local software; the user operates the runtime and local data.",
              "Use hosted CoCalc.ai when collaborators need shared projects operated by CoCalc.",
              "Use Star, Launchpad, or Rocket when the group needs a shared deployment.",
            ]}
          />
        </ProductDetailCard>
      </PublicGrid>
    </Flex>
  );
}

export default function PublicProductsApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicProductsRoute;
}) {
  const title = titleForRoute(initialRoute);
  const marketingConfig = getPublicMarketingConfig(config);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell
      active="products"
      config={marketingConfig}
      title={title}
    >
      {initialRoute.view === "products-cocalc-plus" ? (
        <CocalcPlusPage />
      ) : initialRoute.view === "products-cocalc-rocket" ? (
        <CocalcRocketPage />
      ) : initialRoute.view === "products-cocalc-star" ? (
        <CocalcStarPage />
      ) : initialRoute.view === "products-cocalc-launchpad" ? (
        <CocalcLaunchpadPage />
      ) : (
        <ProductsOverviewPage config={marketingConfig} />
      )}
    </PublicSectionShell>
  );
}
