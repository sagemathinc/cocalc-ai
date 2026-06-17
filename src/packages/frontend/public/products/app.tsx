/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect } from "react";

import { Button, Flex, Typography } from "antd";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { getPublicMarketingConfig } from "@cocalc/frontend/public/config";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  appPath,
  builtinPolicyPath,
  LinkButton,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { publicPath } from "../routes";
import { PublicGrid, PublicSection } from "../layout/shell";
import { CodeCommand, CopyCommandButton } from "./components";
import type { PublicProductsRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

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
      body: "I want to talk with CoCalc about CoCalc Launchpad. Helpful context: expected users or projects, pilot/lab/workshop/department scope, operating environment, timeline, support expectations, and whether pricing, site licensing, data-location, privacy, or security questions are part of the decision.",
      context: "product-cocalc-launchpad",
      subject: "CoCalc Launchpad",
      title: "Talk with CoCalc about Launchpad",
    });
  }
  return supportContactPath({
    body: "I want to talk with CoCalc about CoCalc Rocket. Helpful context: organization type, expected users or projects, private-cloud requirements, governance, security, privacy, or data-ownership questions, procurement needs, timeline, and support or deployment-planning questions.",
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
  const routeFamilies = [
    {
      detail: "CoCalc operates the hosted service for you.",
      icon: "cloud",
      label: "Hosted by CoCalc",
      products: "CoCalc.ai",
    },
    {
      detail: "You run CoCalc on a laptop, desktop, or one VM.",
      icon: "laptop",
      label: "Run it yourself",
      products: "CoCalc Plus or Star",
    },
    {
      detail: "Your organization operates the private environment.",
      icon: "servers",
      label: "Private deployment",
      products: "CoCalc Launchpad or Rocket",
    },
  ] satisfies {
    detail: string;
    icon: IconName;
    label: string;
    products: string;
  }[];
  const paths = [
    {
      bestFit:
        "Individuals and teams that want managed hosted projects without running infrastructure.",
      actionLabel: "Review hosted plans",
      href: appPath("pricing"),
      icon: "cloud",
      runs: "Hosted service operated by CoCalc",
      title: "CoCalc.ai",
    },
    {
      bestFit:
        "Individual users who want local control or a self-directed evaluation on Linux or Mac.",
      actionLabel: "View CoCalc Plus",
      href: publicPath("products/cocalc-plus"),
      icon: "laptop",
      runs: "Local runtime operated by the user",
      title: "CoCalc Plus",
    },
    {
      bestFit:
        "Users or small teams that want a shared CoCalc instance on one public Ubuntu VM.",
      actionLabel: "View CoCalc Star",
      href: publicPath("products/cocalc-star"),
      icon: "star",
      runs: "Single-VM appliance operated by the user or customer",
      title: "CoCalc Star",
    },
    {
      bestFit:
        "Pilots, labs, workshops, small teams, and departments that need a customer-operated private environment.",
      actionLabel: "View CoCalc Launchpad",
      href: publicPath("products/cocalc-launchpad"),
      icon: "servers",
      runs: "Lightweight private deployment operated by the customer",
      title: "CoCalc Launchpad",
    },
    {
      bestFit:
        "Institutions and enterprises planning a broader customer-operated private-cloud deployment.",
      actionLabel: "View CoCalc Rocket",
      href: publicPath("products/cocalc-rocket"),
      icon: "rocket",
      runs: "Enterprise private-cloud path operated by the customer",
      title: "CoCalc Rocket",
    },
  ] satisfies {
    actionLabel: string;
    bestFit: string;
    href: string;
    icon: IconName;
    runs: string;
    title: string;
  }[];

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Choose how CoCalc should run for your team.
        </Title>
        <Paragraph style={{ fontSize: 18, margin: 0 }}>
          CoCalc has one project workspace model across hosted, local, single-VM
          appliance, and private deployment options. The first decision is where
          it should run and who will operate it.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={appPath("features/compare")}>
            Compare CoCalc fit
          </LinkButton>
          <LinkButton href={appPath("pricing")}>
            Pricing and licensing
          </LinkButton>
        </Flex>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Start with who operates CoCalc
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Most groups can narrow the decision quickly by separating managed
          hosted use, self-operated use, and customer-operated private
          deployment.
        </Paragraph>
        <div
          aria-label="CoCalc product route families"
          role="group"
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          }}
        >
          {routeFamilies.map((family) => (
            <div
              key={family.label}
              style={{
                background: PUBLIC_COLORS.surfaceMuted,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 8,
                display: "grid",
                gap: 10,
                gridTemplateColumns: "42px minmax(0, 1fr)",
                minHeight: 116,
                padding: 16,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  alignItems: "center",
                  background: PUBLIC_COLORS.surface,
                  border: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: 8,
                  color: PUBLIC_COLORS.brand,
                  display: "flex",
                  fontSize: 20,
                  height: 42,
                  justifyContent: "center",
                  width: 42,
                }}
              >
                <Icon name={family.icon} />
              </span>
              <span style={{ minWidth: 0 }}>
                <Text strong style={{ display: "block" }}>
                  {family.label}
                </Text>
                <Text style={{ display: "block" }}>{family.products}</Text>
                <Text type="secondary">{family.detail}</Text>
              </span>
            </div>
          ))}
        </div>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Which path fits?
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Use this as a decision guide. The cards separate who operates CoCalc,
          where it runs, and when to move into pricing, documentation, or a
          support conversation for rollout details.
        </Paragraph>
        <div
          aria-label="CoCalc product path chooser"
          role="group"
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {paths.map((path, index) => (
            <div
              className="cocalc-public-products-path-card"
              key={path.title}
              style={{
                background: PUBLIC_COLORS.surface,
                border: `1px solid ${PUBLIC_COLORS.border}`,
                borderRadius: 8,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                minHeight: 300,
                padding: 16,
              }}
            >
              <Flex align="center" gap={10}>
                <span
                  aria-hidden="true"
                  style={{
                    alignItems: "center",
                    background:
                      index === 2
                        ? PUBLIC_COLORS.warningTint
                        : PUBLIC_COLORS.surfaceMuted,
                    border: `1px solid ${
                      index === 2
                        ? PUBLIC_COLORS.warningBorder
                        : PUBLIC_COLORS.border
                    }`,
                    borderRadius: 8,
                    color:
                      index === 2 ? PUBLIC_COLORS.warning : PUBLIC_COLORS.brand,
                    display: "flex",
                    flex: "0 0 38px",
                    height: 38,
                    justifyContent: "center",
                    width: 38,
                  }}
                >
                  <Icon name={path.icon} />
                </span>
                <Text strong>{path.title}</Text>
              </Flex>
              <div>
                <Text
                  style={{
                    color: PUBLIC_COLORS.brand,
                    display: "block",
                    fontSize: 13,
                    fontWeight: 700,
                    marginBottom: 4,
                  }}
                >
                  Where it runs
                </Text>
                <Text>{path.runs}</Text>
              </div>
              <div style={{ flex: 1 }}>
                <Text
                  style={{
                    color: PUBLIC_COLORS.brand,
                    display: "block",
                    fontSize: 13,
                    fontWeight: 700,
                    marginBottom: 4,
                  }}
                >
                  Best fit
                </Text>
                <Text>{path.bestFit}</Text>
              </div>
              <LinkButton href={path.href}>{path.actionLabel}</LinkButton>
            </div>
          ))}
        </div>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Site licensing wraps the product path.
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Use site licensing for procurement, governance, support expectations,
          rollout, data-location, privacy, or security questions, and broader
          deployment rights across the product family. It does not change who
          operates CoCalc by itself; it gives the hosted, local, appliance, or
          private path a commercial and support wrapper.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={appPath("pricing")}>
            See pricing and licensing
          </LinkButton>
          <LinkButton
            href={supportContactPath({
              body: "I want to talk with CoCalc about operating model, site licensing, or an organizational buying route. Helpful context: where you want CoCalc to run, who will operate it, expected users or projects, procurement needs, data-location, privacy, or security questions, and support expectations.",
              context: "products-site-licensing",
              subject: "Operating model and site licensing",
              title: "Talk with CoCalc about operating models",
            })}
          >
            Talk with CoCalc
          </LinkButton>
        </Flex>
        {trustHref || privacyHref ? (
          <Flex aria-label="Product trust materials" gap={14} role="group" wrap>
            {trustHref ? (
              <LinkButton href={trustHref}>Review trust materials</LinkButton>
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
      <Title level={2} style={{ margin: 0 }}>
        {title}
      </Title>
      <Paragraph style={{ fontSize: 18, margin: 0, maxWidth: "72ch" }}>
        {body}
      </Paragraph>
      <ProductActions actions={actions} />
    </PublicSection>
  );
}

function ProductDetailCard({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: IconName;
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="cocalc-public-products-detail-card"
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
        <Title level={3} style={{ margin: 0 }}>
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
      role="group"
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
      }}
    >
      {items.map((item) => (
        <ProductDetailCard icon={item.icon} key={item.title} title={item.title}>
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
      body: "Institutions, enterprises, and platform teams planning a broader customer-operated CoCalc deployment with governance, procurement, support, and rollout requirements.",
      icon: "rocket",
      title: "Audience",
    },
    {
      body: "Runs as a customer-operated private-cloud path. The preferred packaging is VM-first, with Kubernetes available for organizations that already operate that way.",
      icon: "servers",
      title: "Deployment model",
    },
    {
      body: "Use Rocket when the deployment decision includes private infrastructure, capacity planning, operational ownership, support expectations, and commercial terms.",
      icon: "cloud",
      title: "Why choose it",
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
        title="Private-cloud path for institutional deployment"
        body="CoCalc Rocket is the broader customer-operated private-cloud path for organizations that need CoCalc to fit infrastructure, governance, procurement, and support requirements."
      />
      <ProductDetailGrid
        items={detailItems}
        label="CoCalc Rocket positioning"
      />
      <PublicGrid columns={2}>
        <ProductDetailCard icon="rocket" title="Operational boundary">
          <ProductNotesList
            items={[
              "Rocket is not a self-service installer page; it starts with a deployment and commercial conversation.",
              "Choose Launchpad for a smaller customer-operated private deployment.",
              "Choose Star for one public Ubuntu VM, or Plus for a local one-user runtime.",
            ]}
          />
        </ProductDetailCard>
        <ProductDetailCard icon="servers" title="Plan Rocket with CoCalc">
          <Paragraph style={{ marginTop: 0 }}>
            Start with support when the conversation includes infrastructure,
            rollout, governance, support coverage, or site licensing.
          </Paragraph>
          <ProductActions
            actions={[
              {
                href: supportProductPath("Rocket"),
                label: "Talk with CoCalc about Rocket",
                primary: true,
              },
              {
                href: publicPath("products/cocalc-launchpad"),
                label: "Compare with Launchpad",
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
      body: "Users, instructors, labs, and small teams that want collaborators in one browser-based CoCalc instance on a public VM.",
      icon: "star",
      title: "Audience",
    },
    {
      body: "Runs on one fresh public Ubuntu VM with ports 80 and 443 open. The installer sets up the CoCalc instance, HTTPS, onboarding, and the first admin flow.",
      icon: "servers",
      title: "Deployment model",
    },
    {
      body: "Use Star when you want a shared CoCalc site on your own VM without manually assembling DNS, TLS, port forwarding, and cloud-provider-specific setup.",
      icon: "cloud",
      title: "Why choose it",
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
            label: "Compare with Launchpad",
          },
          {
            href: publicPath("products/cocalc-rocket"),
            label: "Compare with Rocket",
          },
        ]}
        title="Shared CoCalc on a single VM"
        body="CoCalc Star is the path for a small shared CoCalc instance on a single public Ubuntu VM. It sits between local CoCalc Plus and customer-operated private deployment."
      />
      <ProductDetailGrid items={detailItems} label="CoCalc Star positioning" />
      <PublicGrid columns={2}>
        <ProductDetailCard icon="star" title="Install CoCalc Star">
          <div id="install-cocalc-star" />
          <Paragraph style={{ margin: 0 }}>
            On a fresh Ubuntu 24.04 VM with ports 80 and 443 open, run:
          </Paragraph>
          <CodeCommand value={installCommand} />
          <Flex gap={12} wrap>
            <CopyCommandButton value={installCommand} />
            <Button href="https://github.com/sagemathinc/cocalc-ai/releases/download/cocalc-star-stable/install-cocalc-star.sh">
              Open install script
            </Button>
            <Button href="https://github.com/sagemathinc/cocalc-ai/releases/tag/cocalc-star-stable">
              Stable channel
            </Button>
          </Flex>
          <Paragraph style={{ margin: 0 }}>
            The default flow detects the public IPv4 address, uses sslip.io for
            DNS, obtains a Let's Encrypt certificate through Caddy, and shows a
            web onboarding page before continuing.
          </Paragraph>
        </ProductDetailCard>
        <ProductDetailCard icon="servers" title="Operational boundary">
          <ProductNotesList
            items={[
              "Use Star for one public VM, one local project host, and a small shared site.",
              "Star is not a high-availability or scale-out private-cloud deployment.",
              "Move to Launchpad for a lightweight private deployment, or Rocket for institutional private cloud.",
            ]}
          />
        </ProductDetailCard>
      </PublicGrid>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Install Star when one VM is enough
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Install Star when you already have a fresh public Ubuntu VM. Compare
          deployment paths first if the organization needs a private environment
          or broader operational planning.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href="#install-cocalc-star">
            Install CoCalc Star
          </LinkButton>
          <LinkButton href={publicPath("products/cocalc-launchpad")}>
            Compare with Launchpad
          </LinkButton>
          <LinkButton href={publicPath("products/cocalc-rocket")}>
            Compare with Rocket
          </LinkButton>
        </Flex>
      </PublicSection>
    </Flex>
  );
}

function CocalcLaunchpadPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-launchpad/install.sh | bash";
  const detailItems = [
    {
      body: "Academic IT, lab operators, platform teams, workshops, and departments that need a customer-operated CoCalc environment for a bounded group.",
      icon: "servers",
      title: "Audience",
    },
    {
      body: "Runs as a lightweight private deployment operated by the customer. It gives operators more control over the environment than Star.",
      icon: "cloud",
      title: "Deployment model",
    },
    {
      body: "Use Launchpad when a hosted account is not the right fit and a single public-VM appliance is too constrained for the pilot or department.",
      icon: "star",
      title: "Why choose it",
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
          { href: appPath("pricing"), label: "Pricing and licensing" },
          {
            href: publicPath("products/cocalc-star"),
            label: "Compare with Star",
          },
        ]}
        title="Lightweight private deployment for teams that operate CoCalc"
        body="CoCalc Launchpad is the customer-operated private deployment path for pilots, labs, workshops, departments, and platform teams that need more control than hosted CoCalc.ai or a single-VM Star appliance."
      />
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
          <CodeCommand value={installCommand} />
          <Flex gap={12} wrap>
            <CopyCommandButton value={installCommand} />
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
        <ProductDetailCard icon="cloud" title="Operational boundary">
          <ProductNotesList
            items={[
              "Choose Star when the need is simply one shared public Ubuntu VM.",
              "Choose Launchpad when the team needs a customer-operated private environment for a bounded deployment.",
              "Choose Rocket when institutional rollout, governance, support, and broader private-cloud planning become the main decision.",
            ]}
          />
        </ProductDetailCard>
      </PublicGrid>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Plan a bounded private deployment
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Start with Launchpad when your team is ready to operate a private
          CoCalc environment. Use pricing and support when procurement,
          deployment rights, or rollout planning are part of the decision.
        </Paragraph>
        <ProductActions
          actions={[
            {
              href: supportProductPath("Launchpad"),
              label: "Discuss Launchpad requirements",
              primary: true,
            },
            { href: appPath("pricing"), label: "Pricing and licensing" },
            {
              href: publicPath("products/cocalc-star"),
              label: "Compare with Star",
            },
            {
              href: publicPath("products/cocalc-rocket"),
              label: "Compare with Rocket",
            },
          ]}
        />
      </PublicSection>
    </Flex>
  );
}

function CocalcPlusPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash";
  const detailItems = [
    {
      body: "Researchers, developers, instructors, and IT evaluators who want a local CoCalc workspace before choosing hosted collaboration or a shared deployment.",
      icon: "laptop",
      title: "Audience",
    },
    {
      body: "Runs on one Linux or macOS machine and is operated by the user. It is the local, one-user runtime in the product family.",
      icon: "cloud",
      title: "Deployment model",
    },
    {
      body: "Use Plus for local evaluation, demos, personal projects, and learning the CoCalc workspace model without creating a hosted account.",
      icon: "star",
      title: "Why choose it",
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
          { href: appPath("pricing"), label: "Review hosted plans" },
          {
            href: publicPath("products/cocalc-star"),
            label: "Compare with Star",
          },
        ]}
        title="Local CoCalc for evaluation and individual work"
        body="CoCalc Plus is the local source-available runtime for one user on Linux or macOS. It is the right starting point when you want to evaluate CoCalc or work on your own machine before choosing a shared path."
      />
      <ProductDetailGrid items={detailItems} label="CoCalc Plus positioning" />
      <PublicGrid columns={2}>
        <ProductDetailCard icon="laptop" title="Install CoCalc Plus locally">
          <div id="install-cocalc-plus" />
          <Paragraph style={{ margin: 0 }}>
            The current install flow uses the hosted software distribution:
          </Paragraph>
          <CodeCommand value={installCommand} />
          <Flex gap={12} wrap>
            <CopyCommandButton value={installCommand} />
            <Button href="https://software.cocalc.ai/software/cocalc-plus/install.sh">
              Open install script
            </Button>
          </Flex>
          <Paragraph style={{ margin: 0 }}>
            Current target platforms are Linux and macOS. The installer places
            the runtime in a user-owned location and adds a launcher if needed.
          </Paragraph>
        </ProductDetailCard>
        <ProductDetailCard icon="cloud" title="Operational boundary">
          <ProductNotesList
            items={[
              "Choose CoCalc.ai when you want managed hosted collaboration and shared projects.",
              "Choose CoCalc Star when a small group needs one shared VM.",
              "Choose Launchpad or Rocket when the organization needs a customer-operated environment.",
            ]}
          />
        </ProductDetailCard>
      </PublicGrid>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Choose a shared path after local evaluation
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Install Plus to evaluate the workspace model locally. Move to hosted
          plans when CoCalc should be operated by us, or compare operating
          models when the group needs one VM or a customer-operated path.
        </Paragraph>
        <ProductActions
          actions={[
            {
              href: "#install-cocalc-plus",
              label: "Install CoCalc Plus",
              primary: true,
            },
            { href: appPath("pricing"), label: "Review hosted plans" },
            {
              href: publicPath("products"),
              label: "Compare operating models",
            },
          ]}
        />
      </PublicSection>
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
