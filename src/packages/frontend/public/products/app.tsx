/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { Button, Flex, Typography } from "antd";
import {
  appPath,
  LinkButton,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { publicPath } from "../routes";
import { PublicCard, PublicGrid, PublicSection } from "../layout/shell";
import { CodeCommand, CopyCommandButton } from "./components";
import type { PublicProductsRoute } from "./routes";

const { Paragraph, Title } = Typography;

function titleForRoute(route: PublicProductsRoute): string {
  switch (route.view) {
    case "products-cocalc-launchpad":
      return "CoCalc Launchpad";
    case "products-cocalc-plus":
      return "CoCalc Plus";
    case "products-cocalc-rocket":
      return "CoCalc Rocket";
    case "products":
    default:
      return "Ways to Run CoCalc";
  }
}

function ProductsOverviewPage() {
  return (
    <PublicGrid columns={2}>
      <PublicCard href={appPath("")} title="Hosted CoCalc">
        <Paragraph>
          Use the full hosted service when you want managed infrastructure,
          multi-user collaboration, shared projects, and the broadest set of
          public pages and support workflows.
        </Paragraph>
      </PublicCard>
      <PublicCard href={publicPath("products/cocalc-plus")} title="CoCalc Plus">
        <Paragraph style={{ margin: 0 }}>
          The local single-user CoCalc experience for your own machine. It is
          the simplest path when you want the CoCalc workspace model without
          standing up a shared service.
        </Paragraph>
      </PublicCard>
      <PublicCard
        href={publicPath("products/cocalc-launchpad")}
        title="CoCalc Launchpad"
      >
        <Paragraph style={{ margin: 0 }}>
          The lightweight control-plane bundle for small teams and self-hosted
          deployments that want the CoCalc user model without the old Next.js
          stack.
        </Paragraph>
      </PublicCard>
      <PublicCard
        href={publicPath("products/cocalc-rocket")}
        title="CoCalc Rocket"
      >
        <Paragraph style={{ margin: 0 }}>
          The full self-hosted multi-user CoCalc deployment when you want the
          hosted experience on infrastructure you control, whether directly or
          as a managed service run for you.
        </Paragraph>
      </PublicCard>
    </PublicGrid>
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
          CoCalc Rocket is the full self-hosted multi-user deployment of CoCalc.
          It is the closest match to the hosted service when you want
          collaborative projects, managed compute, and the broader CoCalc user
          model on infrastructure you control.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          It is also the right mental model for the hosted service itself:
          hosted CoCalc is essentially Rocket run and managed by us instead of
          by your own team.
        </Paragraph>
      </PublicSection>
      <PublicSection>
        <Title level={3} style={{ margin: 0 }}>
          Choose Rocket, Launchpad, or Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc Plus for a local single-user install. Choose Launchpad
          when you want a lighter operator-focused shared deployment. Choose
          Rocket when you want the full multi-user CoCalc service model on your
          own infrastructure.
        </Paragraph>
        <Flex gap={12} wrap>
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
          Rocket is the right path when you want a more complete deployment
          story than Plus or Launchpad. For now, use our support and sales
          channels to discuss deployment requirements, infrastructure, and
          managed-service options.
        </Paragraph>
        <Flex gap={12} wrap>
          <LinkButton href={appPath("support")}>Support</LinkButton>
          <LinkButton href={appPath("pricing")}>Pricing</LinkButton>
        </Flex>
      </PublicSection>
    </PublicGrid>
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
            CoCalc Launchpad is the lightweight control-plane bundle for small
            teams and self-hosted deployments. It is the clearest path when you
            want a shared CoCalc environment that you operate yourself.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            It is aimed at rapid iteration, small deployments, and productized
            use of the same collaborative workspace model that powers the hosted
            service.
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
          Choose Launchpad or CoCalc Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc Plus for a local single-user install. Choose Launchpad
          when you want a shared deployment for a small team or an operator-run
          instance with the same overall workspace model.
        </Paragraph>
        <Flex gap={12} wrap>
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
          CoCalc Plus is the local single-user version of CoCalc. It is meant to
          feel more like installing VS Code or JupyterLab on your own machine
          than signing up for a hosted multi-user service.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          It brings notebooks, terminals, files, and the broader CoCalc
          workspace model into a local single-user install.
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
          Hosted CoCalc is the right fit when you want multi-user collaboration,
          shared projects, and managed infrastructure. CoCalc Plus is the right
          fit when you want the same style of environment on your own machine.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Both options matter for notebook-heavy technical work, and they share
          the same overall approach to projects, files, terminals, and
          computational workflows.
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
      ) : initialRoute.view === "products-cocalc-launchpad" ? (
        <CocalcLaunchpadPage />
      ) : (
        <ProductsOverviewPage />
      )}
    </PublicSectionShell>
  );
}
