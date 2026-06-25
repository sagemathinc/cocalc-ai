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
import { PUBLIC_COLORS } from "../theme";
import { PublicCard, PublicGrid, PublicSection } from "../layout/shell";
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

function ProductSharedProjectNote() {
  return (
    <div
      aria-label="Shared CoCalc project context"
      role="note"
      style={{
        borderLeft: `3px solid ${PUBLIC_COLORS.brandSubtle}`,
        color: PUBLIC_COLORS.mutedText,
        lineHeight: 1.55,
        maxWidth: "76ch",
        padding: "2px 0 2px 14px",
      }}
    >
      <Text strong>Same project, different operating path.</Text>{" "}
      <Text style={{ color: PUBLIC_COLORS.mutedText }}>
        The product path changes where CoCalc runs and who operates it; the
        project remains the durable, reviewable working context for files,
        notebooks, terminals, chats, TimeTravel recovery, real-time
        collaboration, and AI/agent context.
      </Text>
    </div>
  );
}

function ProductsOverviewPage() {
  return (
    <PublicGrid columns={3}>
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
      <PublicCard href={publicPath("products/cocalc-star")} title="CoCalc Star">
        <Paragraph style={{ margin: 0 }}>
          The zero-config public VM appliance. Paste one command on a fresh
          Ubuntu server, get HTTPS with Caddy and Let's Encrypt, then create
          collaborative projects with notebooks, terminals, LaTeX, and agents.
        </Paragraph>
      </PublicCard>
      <PublicCard
        href={publicPath("products/cocalc-launchpad")}
        title="CoCalc Launchpad"
      >
        <Paragraph style={{ margin: 0 }}>
          The lightweight control-plane bundle for operator-controlled
          deployments, custom project-host work, and product development around
          the same CoCalc user and project model.
        </Paragraph>
      </PublicCard>
      <PublicCard
        href={publicPath("products/cocalc-rocket")}
        title="CoCalc Rocket"
      >
        <Paragraph style={{ margin: 0 }}>
          The full production deployment path when you need multi-bay
          architecture, larger operations, and the hosted CoCalc service model
          on infrastructure you control.
        </Paragraph>
      </PublicCard>
    </PublicGrid>
  );
}

function CocalcRocketPage() {
  return (
    <>
      <PublicGrid columns={3}>
        <PublicSection>
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
            What CoCalc Rocket is
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Rocket is the full self-hosted multi-user deployment of
            CoCalc. It is the closest match to the hosted service when you want
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
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
            Choose Rocket, Launchpad, or Plus
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Choose CoCalc Plus for a local single-user install. Choose CoCalc
            Star when you want a one-command public VM appliance. Choose
            Launchpad for lighter operator-controlled deployments. Choose Rocket
            when you want the full multi-user CoCalc service model on your own
            infrastructure.
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
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
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
      <ProductSharedProjectNote />
    </>
  );
}

function CocalcStarPage() {
  const installCommand =
    "curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/download/cocalc-star-stable/install-cocalc-star.sh | sudo bash";

  return (
    <>
      <PublicGrid columns={3}>
        <PublicSection>
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
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
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
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
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
            When to choose Star
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Choose Star for a lab, course, GPU box, agent sandbox, or small team
            where the operator owns the VM and wants collaborators using the
            same browser-based CoCalc workspace.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            It is not the high-availability or multi-bay product. For that, move
            up to Rocket; for lower-level operator and development flows, use
            Launchpad.
          </Paragraph>
        </PublicSection>
      </PublicGrid>
      <PublicSection>
        <Title
          level={2}
          style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
        >
          Star, Launchpad, and Rocket
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Star is the default public VM appliance. Launchpad is the lighter
          control-plane bundle for operators and product development. Rocket is
          the production deployment architecture for larger or managed
          installations.
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
      <ProductSharedProjectNote />
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
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
            What CoCalc Launchpad is
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Launchpad is the lightweight control-plane bundle for
            operator-controlled self-hosted deployments. It is the right layer
            when you are working on host connectivity, deployment automation,
            custom product profiles, or the control-plane side of CoCalc.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            If your goal is a one-command public VM that people can use through
            HTTPS immediately, start with CoCalc Star instead.
          </Paragraph>
        </PublicSection>
        <PublicSection>
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
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
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
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
        <Title
          level={2}
          style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
        >
          Choose Star, Launchpad, or Plus
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Choose CoCalc Plus for a local single-user install. Choose CoCalc Star
          for a single public VM appliance. Choose Launchpad when you need the
          lighter control-plane and host-operator layer rather than the packaged
          appliance.
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
      <ProductSharedProjectNote />
    </>
  );
}

function CocalcPlusPage() {
  const installCommand =
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash";

  return (
    <>
      <PublicGrid columns={3}>
        <PublicSection>
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
            What CoCalc Plus is
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc Plus is the local single-user version of CoCalc. It is meant
            to feel more like installing VS Code or JupyterLab on your own
            machine than signing up for a hosted multi-user service.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            It brings notebooks, terminals, files, and the broader CoCalc
            workspace model into a local single-user install.
          </Paragraph>
        </PublicSection>
        <PublicSection>
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
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
            Current target platforms are Linux and macOS. The installer places
            the runtime in a user-owned location and adds a launcher if needed.
          </Paragraph>
        </PublicSection>
        <PublicSection>
          <Title
            level={2}
            style={{ margin: 0, fontSize: 24, lineHeight: "32px" }}
          >
            Choose hosted CoCalc or CoCalc Plus
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Hosted CoCalc is the right fit when you want multi-user
            collaboration, shared projects, and managed infrastructure. CoCalc
            Plus is the right fit when you want the same style of environment on
            your own machine.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            Both options matter for notebook-heavy technical work, and they
            share the same overall approach to projects, files, terminals, and
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
      <ProductSharedProjectNote />
    </>
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
