/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Flex, Typography } from "antd";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  appPath,
  LinkButton,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { publicPath } from "../routes";
import { PublicGrid, PublicSection } from "../layout/shell";
import { CodeCommand, CopyCommandButton } from "./components";
import type { PublicProductsRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

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

function ProductsOverviewPage() {
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
      href: appPath(""),
      icon: "cloud",
      runs: "Hosted service operated by CoCalc",
      title: "CoCalc.ai",
    },
    {
      bestFit:
        "Individual users who want local control or a self-directed evaluation on Linux or Mac.",
      href: publicPath("products/cocalc-plus"),
      icon: "laptop",
      runs: "Local runtime operated by the user",
      title: "CoCalc Plus",
    },
    {
      bestFit:
        "Users or small teams that want a shared CoCalc instance on one public Ubuntu VM or local Lima VM.",
      href: publicPath("products/cocalc-star"),
      icon: "star",
      runs: "Single-VM appliance operated by the user or customer",
      title: "CoCalc Star",
    },
    {
      bestFit:
        "Pilots, labs, workshops, small teams, and departments that need a customer-operated private environment.",
      href: publicPath("products/cocalc-launchpad"),
      icon: "servers",
      runs: "Lightweight private deployment operated by the customer",
      title: "CoCalc Launchpad",
    },
    {
      bestFit:
        "Institutions and enterprises planning a broader customer-operated private-cloud deployment.",
      href: publicPath("products/cocalc-rocket"),
      icon: "rocket",
      runs: "Enterprise private-cloud path operated by the customer",
      title: "CoCalc Rocket",
    },
  ] satisfies {
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
          <LinkButton href={appPath("features")}>
            Explore shared features
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
          Most buyers can narrow the decision quickly by separating managed
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
          Use this as a buyer map. Pick the closest fit, then move to pricing,
          documentation, or a support conversation for buying and rollout
          details.
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
              <LinkButton href={path.href}>Open {path.title}</LinkButton>
            </div>
          ))}
        </div>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Site licensing wraps the product path.
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Use site licensing for procurement, governance, support, rollout, and
          broader deployment rights across the product family. It does not
          change who operates CoCalc by itself; it wraps the hosted, local,
          appliance, or private path your group chooses.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={appPath("pricing")}>
            See pricing and licensing
          </LinkButton>
        </Flex>
      </PublicSection>
    </Flex>
  );
}

function CocalcRocketPage() {
  return (
    <PublicGrid columns={3}>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Who CoCalc Rocket is for
        </Title>
        <Paragraph style={{ margin: 0 }}>
          CoCalc Rocket is for institutions and enterprises planning a broader
          customer-operated private-cloud deployment of CoCalc.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Use it when governance, private infrastructure, rollout planning, or
          custom commercial terms matter more than a self-service hosted or
          single-VM path.
        </Paragraph>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          How Rocket differs
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc Plus for a free local runtime. Choose CoCalc Star for a
          single public VM appliance. Choose Launchpad for a lightweight private
          deployment. Choose Rocket for the enterprise private-cloud path.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={publicPath("products/cocalc-star")}>
            Compare with Star
          </LinkButton>
          <LinkButton href={publicPath("products/cocalc-launchpad")}>
            Compare with Launchpad
          </LinkButton>
          <LinkButton href={publicPath("products/cocalc-plus")}>
            Compare with CoCalc Plus
          </LinkButton>
        </Flex>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Talk with us
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Rocket conversations usually include infrastructure, rollout,
          governance, support, and site-license options. Contact us before
          assuming a smaller self-operated path will fit an institutional
          deployment.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={appPath("support")}>Support</LinkButton>
          <LinkButton href={appPath("pricing")}>Pricing</LinkButton>
        </Flex>
      </PublicSection>
    </PublicGrid>
  );
}

function CocalcStarPage() {
  const installCommand =
    "curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/download/cocalc-star-stable/install-cocalc-star.sh | sudo bash";

  return (
    <>
      <PublicGrid columns={3}>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            Who CoCalc Star is for
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Star is for technically self-directed users or small teams
            that want a shared CoCalc instance on one VM.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            It is the bridge between the single-user local runtime and broader
            private-deployment planning: one public Ubuntu VM or local Lima VM,
            not high availability or enterprise private cloud.
          </Paragraph>
        </PublicSection>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            Install CoCalc Star
          </Title>
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
        </PublicSection>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            When to choose Star
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Choose Star for a lab, course, GPU box, agent sandbox, or small team
            where the operator owns the VM and wants collaborators using the
            same browser-based CoCalc workspace.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            Star is not HA and not multi-bay. Use it for a single public VM;
            move to Launchpad for lightweight private deployment or Rocket for
            private cloud deployments.
          </Paragraph>
        </PublicSection>
      </PublicGrid>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Star, Launchpad, and Rocket
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Star is the single-VM public appliance. Launchpad is the lightweight
          private deployment. Rocket is the private cloud deployment path.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={publicPath("products/cocalc-launchpad")}>
            Compare with Launchpad
          </LinkButton>
          <LinkButton href={publicPath("products/cocalc-rocket")}>
            Compare with Rocket
          </LinkButton>
        </Flex>
      </PublicSection>
    </>
  );
}

function CocalcLaunchpadPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-launchpad/install.sh | bash";

  return (
    <>
      <PublicGrid columns={3}>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            Who CoCalc Launchpad is for
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Launchpad is the lightweight private deployment path for
            pilots, labs, workshops, small teams, and departments that need a
            customer-operated environment.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            If your goal is a shared instance on one public Ubuntu VM, start
            with CoCalc Star. If the organization needs a broader private-cloud
            path, talk with us about Rocket.
          </Paragraph>
        </PublicSection>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            Install CoCalc Launchpad
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Copy and run this in your terminal:
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
        </PublicSection>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            What the installer does
          </Title>
          <Paragraph style={{ margin: 0 }}>
            The installer downloads the platform-specific manifest, verifies the
            corresponding Launchpad artifact, installs it into a user-owned
            directory, and adds a launcher to your PATH if needed.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            On Linux this lives under
            <code> ~/.local/share/cocalc-launchpad</code>, and on macOS under
            <code> ~/Library/Application Support/cocalc-launchpad</code>.
          </Paragraph>
        </PublicSection>
      </PublicGrid>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Choose Star, Launchpad, or Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc Plus for a free local runtime. Choose CoCalc Star for a
          single public VM appliance. Choose Launchpad for a lightweight private
          deployment. Choose Rocket when enterprise private-cloud planning is
          required.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={publicPath("products/cocalc-star")}>
            Compare with Star
          </LinkButton>
          <LinkButton href={publicPath("products/cocalc-plus")}>
            Compare with CoCalc Plus
          </LinkButton>
          <LinkButton href={appPath("features/api")}>HTTP API</LinkButton>
        </Flex>
      </PublicSection>
    </>
  );
}

function CocalcPlusPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash";

  return (
    <PublicGrid columns={3}>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Who CoCalc Plus is for
        </Title>
        <Paragraph style={{ margin: 0 }}>
          CoCalc Plus is the free source-available local runtime for one user.
          Choose it when you want to evaluate CoCalc locally or work on your own
          machine without a hosted account.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          It brings notebooks, terminals, files, and the CoCalc workspace model
          to Linux or Mac. Choose CoCalc.ai, Star, Launchpad, or Rocket when the
          work needs a shared or organizational environment.
        </Paragraph>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Install CoCalc Plus
        </Title>
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
          Current target platforms are Linux and macOS. The installer places the
          runtime in a user-owned location and adds a launcher if needed.
        </Paragraph>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Choose hosted CoCalc or CoCalc Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc.ai when you want managed hosted collaboration and shared
          projects. Choose CoCalc Plus when you want a free local runtime.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Both options share the same overall approach to projects, files,
          terminals, notebooks, and computational workflows.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={appPath("features/jupyter-notebook")}>
            Jupyter notebooks
          </LinkButton>
          <LinkButton href={appPath("features/linux")}>
            Linux workflow
          </LinkButton>
        </Flex>
      </PublicSection>
    </PublicGrid>
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

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell active="products" config={config} title={title}>
      {initialRoute.view === "products-cocalc-plus" ? (
        <CocalcPlusPage />
      ) : initialRoute.view === "products-cocalc-rocket" ? (
        <CocalcRocketPage />
      ) : initialRoute.view === "products-cocalc-star" ? (
        <CocalcStarPage />
      ) : initialRoute.view === "products-cocalc-launchpad" ? (
        <CocalcLaunchpadPage />
      ) : (
        <ProductsOverviewPage />
      )}
    </PublicSectionShell>
  );
}
