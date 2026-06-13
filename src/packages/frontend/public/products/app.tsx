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
  const paths = [
    {
      chooseIf: "You want managed hosted projects and accounts run by CoCalc.",
      href: appPath(""),
      icon: "cloud",
      operator: "Vendor-operated hosted service",
      title: "CoCalc.ai",
    },
    {
      chooseIf: "You want a one-user local workspace on Linux or Mac.",
      href: publicPath("products/cocalc-plus"),
      icon: "laptop",
      operator: "Individual-operated local runtime",
      title: "CoCalc Plus",
    },
    {
      chooseIf: "You want one public Ubuntu VM that you operate directly.",
      href: publicPath("products/cocalc-star"),
      icon: "star",
      operator: "Operator-owned public VM",
      title: "CoCalc Star",
    },
    {
      chooseIf: "You need a lightweight customer-operated private deployment.",
      href: publicPath("products/cocalc-launchpad"),
      icon: "servers",
      operator: "Customer-operated private deployment",
      title: "CoCalc Launchpad",
    },
    {
      chooseIf:
        "You are planning a customer-operated private-cloud deployment.",
      href: publicPath("products/cocalc-rocket"),
      icon: "rocket",
      operator: "Customer-operated private cloud",
      title: "CoCalc Rocket",
    },
  ] satisfies {
    chooseIf: string;
    href: string;
    icon: IconName;
    operator: string;
    title: string;
  }[];

  return (
    <Flex vertical gap={18}>
      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Choose the product path first.
        </Title>
        <Paragraph style={{ fontSize: 18, margin: 0 }}>
          Each path answers where CoCalc runs and who operates it. The project
          workspace stays familiar across hosted, local, public-VM, and private
          deployment options.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={appPath("features")}>
            Explore shared features
          </LinkButton>
          <LinkButton href={appPath("pricing")}>
            Compare CoCalc.ai pricing
          </LinkButton>
        </Flex>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Product path chooser
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Use this as a decision table: pick who operates CoCalc, then use
          pricing or support for buying details. The workspace model stays
          project-centered; the product path changes the operating boundary.
        </Paragraph>
        <div style={{ overflowX: "auto" }}>
          <table
            aria-label="CoCalc product path chooser"
            style={{
              borderCollapse: "separate",
              borderSpacing: 0,
              minWidth: 760,
              width: "100%",
            }}
          >
            <thead>
              <tr>
                {[
                  "Path",
                  "Operator model",
                  "Choose this if...",
                  "Next step",
                ].map((label) => (
                  <th
                    key={label}
                    scope="col"
                    style={{
                      borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
                      color: PUBLIC_COLORS.brand,
                      padding: "0 14px 12px",
                      textAlign: "left",
                    }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paths.map((path, index) => (
                <tr key={path.title}>
                  <th
                    scope="row"
                    style={{
                      borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
                      padding: "14px",
                      textAlign: "left",
                      verticalAlign: "top",
                    }}
                  >
                    <Flex align="center" gap={10}>
                      <span
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
                            index === 2
                              ? PUBLIC_COLORS.warning
                              : PUBLIC_COLORS.brand,
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
                  </th>
                  <td
                    style={{
                      borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
                      padding: "14px",
                      verticalAlign: "top",
                    }}
                  >
                    {path.operator}
                  </td>
                  <td
                    style={{
                      borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
                      padding: "14px",
                      verticalAlign: "top",
                    }}
                  >
                    {path.chooseIf}
                  </td>
                  <td
                    style={{
                      borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
                      padding: "14px",
                      verticalAlign: "top",
                    }}
                  >
                    <LinkButton href={path.href}>Open {path.title}</LinkButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Site licensing is an organizational wrapper.
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Use site licensing for procurement, governance, support, rollout, and
          broader deployment rights across the product ladder. It does not
          replace the runtime choice; it wraps the path your group chooses.
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
          What CoCalc Rocket is
        </Title>
        <Paragraph style={{ margin: 0 }}>
          CoCalc Rocket is the private cloud deployment path for teams that need
          private multi-user CoCalc on infrastructure they control.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Use it when a private deployment needs more planning, operating
          boundaries, and CoCalc guidance than Star or Launchpad.
        </Paragraph>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Choose Rocket, Launchpad, or Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc Plus for a free local runtime. Choose CoCalc Star for a
          single public VM appliance. Choose Launchpad for a lightweight private
          deployment. Choose Rocket for private cloud CoCalc.
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
          Rocket is the right path when private infrastructure, governance, or
          operational planning matter. Contact us to discuss infrastructure,
          rollout, support, and site license options.
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
            What CoCalc Star is
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Star is the single-VM CoCalc appliance. It is designed for a
            fresh public Ubuntu server where port 443 is reachable from the
            internet.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            The installer sets up the local control plane, project host,
            Postgres, Caddy HTTPS, a default Jupyter/LaTeX root filesystem, and
            a first-admin bootstrap URL.
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
            What CoCalc Launchpad is
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Launchpad is the lightweight private deployment path. It fits
            teams that need private deployment control, custom hosts, or
            deployment automation without the full Rocket architecture.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            If your goal is one public Ubuntu VM that you operate directly,
            start with CoCalc Star instead.
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
          deployment. Choose Rocket when private cloud operations are required.
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
          What CoCalc Plus is
        </Title>
        <Paragraph style={{ margin: 0 }}>
          CoCalc Plus is the free source-available local runtime for one user.
          It is meant to feel more like installing VS Code or JupyterLab on your
          own machine than signing up for a hosted multi-user service.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          It brings notebooks, terminals, files, and the CoCalc workspace model
          to Linux or Mac without requiring a hosted account or shared
          deployment.
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
