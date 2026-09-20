/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  LinkButton,
} from "./page-components";
import { FeatureFinalBand, IconBadge, TerminalMock } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const COMPUTE_ACCENT = COLORS.FEATURE_TEAL;
const COMPUTE_PAGE_CSS = `
.feature-compute-hero {
  background:
    radial-gradient(circle at 88% 12%, ${alpha(COMPUTE_ACCENT, 0.13)}, transparent 34%),
    linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 100%);
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  overflow: hidden;
  padding: clamp(24px, 4vw, 48px);
}

.feature-compute-hero-title.ant-typography {
  font-size: clamp(38px, 5vw, 58px);
  letter-spacing: -0.045em;
  line-height: 1.03;
  margin: 0;
  max-width: 12.5ch;
}

.feature-compute-eyebrow {
  color: ${COMPUTE_ACCENT};
  font-size: ${PUBLIC_TYPE.eyebrow}px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.feature-compute-proof-grid {
  border-top: 1px solid ${PUBLIC_COLORS.border};
  display: grid;
  gap: 12px 20px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 30px;
  padding-top: 22px;
}

.feature-compute-proof-item {
  align-items: center;
  color: ${PUBLIC_COLORS.heading};
  display: flex;
  font-weight: 600;
  gap: 10px;
  min-width: 0;
}

.feature-compute-map {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.media}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  overflow: hidden;
}

.feature-compute-map-header {
  align-items: center;
  background: ${PUBLIC_COLORS.surfaceMuted};
  border-bottom: 1px solid ${PUBLIC_COLORS.border};
  display: flex;
  justify-content: space-between;
  padding: 12px 16px;
}

.feature-compute-map-body {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 16px;
}

.feature-compute-boundary {
  background: ${PUBLIC_COLORS.surfaceMuted};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 230px;
  padding: 15px;
}

.feature-compute-node {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  color: ${PUBLIC_COLORS.heading};
  padding: 11px 12px;
}

.feature-compute-arrow {
  align-items: center;
  color: ${COMPUTE_ACCENT};
  display: flex;
  font-size: 12px;
  font-weight: 700;
  gap: 8px;
  justify-content: center;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.feature-compute-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.feature-compute-chip {
  background: ${alpha(COMPUTE_ACCENT, 0.08)};
  border: 1px solid ${alpha(COMPUTE_ACCENT, 0.22)};
  border-radius: ${PUBLIC_RADIUS.pill}px;
  color: ${PUBLIC_COLORS.heading};
  font-size: 12px;
  font-weight: 600;
  padding: 4px 8px;
}

.feature-compute-route-grid,
.feature-compute-capacity-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.feature-compute-route-card,
.feature-compute-capacity-card {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.card};
  height: 100%;
  padding: 22px;
}

.feature-compute-capacity-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.feature-compute-readiness {
  counter-reset: readiness;
  display: grid;
  gap: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.feature-compute-readiness-step {
  border-top: 3px solid ${alpha(COMPUTE_ACCENT, 0.28)};
  counter-increment: readiness;
  padding: 20px 24px 4px 0;
  position: relative;
}

.feature-compute-readiness-step::before {
  align-items: center;
  background: ${PUBLIC_COLORS.surface};
  border: 2px solid ${COMPUTE_ACCENT};
  border-radius: 50%;
  color: ${COMPUTE_ACCENT};
  content: counter(readiness);
  display: flex;
  font-size: 12px;
  font-weight: 700;
  height: 28px;
  justify-content: center;
  left: 0;
  position: absolute;
  top: -16px;
  width: 28px;
}

@media (max-width: 900px) {
  .feature-compute-proof-grid,
  .feature-compute-capacity-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .feature-compute-route-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .feature-compute-hero {
    padding: 22px 18px;
  }

  .feature-compute-hero-title.ant-typography {
    font-size: clamp(34px, 12vw, 48px);
    max-width: 10.5ch;
  }

  .feature-compute-hero .ant-btn {
    width: 100%;
  }

  .feature-compute-map-body,
  .feature-compute-proof-grid,
  .feature-compute-capacity-grid,
  .feature-compute-readiness {
    grid-template-columns: 1fr;
  }

  .feature-compute-readiness-step + .feature-compute-readiness-step {
    margin-top: 22px;
  }
}
`;

const ROUTES = [
  {
    body: (
      <>
        Put the project&apos;s notebooks, files, terminals, and services on a
        selected host. This keeps the working environment together when the
        whole project needs different CPU, RAM, storage, or compatible GPU
        hardware.
      </>
    ),
    href: () => appPath("docs/hosts/project-hosts"),
    icon: "server",
    label: "Understand project hosts",
    title: "Run the whole project on a project host",
  },
  {
    body: (
      <>
        Keep the notebook in CoCalc and run its code on an SSH-accessible
        machine that already has the software, datasets, or GPU. The two
        filesystems remain separate.
      </>
    ),
    href: () => appPath("docs/jupyter/remote-kernels"),
    icon: "jupyter",
    label: "Connect a remote Jupyter kernel",
    title: "Run one notebook on an existing machine",
  },
  {
    body: (
      <>
        Where managed VMs are enabled, use one for operating-system control or
        as a remote-kernel machine. Its lifecycle, storage, and files are
        separate from the CoCalc project.
      </>
    ),
    href: () => "https://cocalc.ai/docs/projects/virtual-machines",
    icon: "cloud",
    label: "Review the managed VM guide",
    title: "Control a conventional machine when available",
  },
] satisfies {
  body: React.ReactNode;
  href: () => string;
  icon: IconName;
  label: string;
  title: string;
}[];

const CAPACITY_CHECKS = [
  {
    body: "Measure the whole job, including concurrent kernels and workers. A per-project cap does not reserve that amount of physical host memory.",
    icon: "dashboard",
    title: "RAM",
  },
  {
    body: "Check whether the program actually uses several cores. More visible cores do not make serial code parallel or eliminate contention.",
    icon: "microchip",
    title: "CPU",
  },
  {
    body: "Identify device count, memory per device, drivers, and framework compatibility. A GPU image alone does not provide GPU hardware.",
    icon: "bolt",
    title: "GPU",
  },
  {
    body: "Include inputs, temporary files, environments, saved results, architecture, and backup location in the capacity decision.",
    icon: "database",
    title: "Data and software",
  },
] satisfies { body: string; icon: IconName; title: string }[];

function ComputeBoundaryMap() {
  return (
    <div
      aria-label="Workflow map comparing a whole project on a project host with a notebook using a remote kernel"
      className="feature-compute-map"
      role="img"
    >
      <div aria-hidden="true">
        <div className="feature-compute-map-header">
          <Text strong>Where execution happens</Text>
          <Text style={{ color: PUBLIC_COLORS.mutedText, fontSize: 12 }}>
            Two distinct boundaries
          </Text>
        </div>
        <div className="feature-compute-map-body">
          <div className="feature-compute-boundary">
            <Text strong>Whole project</Text>
            <div className="feature-compute-node">
              <Flex vertical gap={5}>
                <Text strong>Project files and tools</Text>
                <Text style={{ color: PUBLIC_COLORS.mutedText, fontSize: 12 }}>
                  notebooks · terminals · services
                </Text>
              </Flex>
            </div>
            <div className="feature-compute-arrow">
              <Icon name="arrow-down" /> runs on
            </div>
            <div className="feature-compute-node">
              <Flex vertical gap={9}>
                <Text strong>Selected project host</Text>
                <div className="feature-compute-chip-row">
                  <span className="feature-compute-chip">CPU</span>
                  <span className="feature-compute-chip">RAM</span>
                  <span className="feature-compute-chip">Storage</span>
                  <span className="feature-compute-chip">Compatible GPU</span>
                </div>
              </Flex>
            </div>
          </div>
          <div className="feature-compute-boundary">
            <Text strong>One notebook</Text>
            <div className="feature-compute-node">
              <Flex vertical gap={5}>
                <Text strong>Notebook stays in CoCalc</Text>
                <Text style={{ color: PUBLIC_COLORS.mutedText, fontSize: 12 }}>
                  cells · Markdown · saved outputs
                </Text>
              </Flex>
            </div>
            <div className="feature-compute-arrow">
              <Icon name="exchange" /> SSH kernel connection
            </div>
            <div className="feature-compute-node">
              <Flex vertical gap={5}>
                <Text strong>Existing server or GPU machine</Text>
                <Text style={{ color: PUBLIC_COLORS.mutedText, fontSize: 12 }}>
                  remote datasets · packages · files
                </Text>
              </Flex>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ResearchComputeFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("hosts")
    : featureSignUpPath("code");
  const primaryCtaLabel = isAuthenticated
    ? "Open project hosts"
    : "Start a research project";

  return (
    <Flex vertical gap={56}>
      <style>{COMPUTE_PAGE_CSS}</style>

      <section
        aria-labelledby="feature-compute-hero-title"
        className="feature-compute-hero"
      >
        <Row align="middle" gutter={[40, 36]}>
          <Col xs={24} lg={12}>
            <Flex vertical gap={22}>
              <Text className="feature-compute-eyebrow">Research compute</Text>
              <Title
                className="feature-compute-hero-title"
                id="feature-compute-hero-title"
                level={2}
              >
                Put the right compute behind the research.
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  fontSize: PUBLIC_TYPE.lead,
                  lineHeight: 1.6,
                  margin: 0,
                  maxWidth: 650,
                }}
              >
                Run the full CoCalc project on a suitable project host, or keep
                a notebook in CoCalc while its kernel runs on an existing server
                over SSH. Choose from resources your deployment and account can
                actually use.
              </Paragraph>
              <Flex gap={12} wrap>
                <Button href={primaryCtaHref} size="large" type="primary">
                  {primaryCtaLabel}
                </Button>
                <Button
                  href={appPath("docs/hosts/choose-compute")}
                  size="large"
                >
                  Choose a compute path
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <ComputeBoundaryMap />
          </Col>
        </Row>
        <div className="feature-compute-proof-grid">
          {[
            ["server", "Whole-project hosts"],
            ["exchange", "Remote kernels over SSH"],
            ["microchip", "CPU, RAM, GPU, and storage checks"],
            ["terminal", "CLI inventory and status"],
          ].map(([icon, label]) => (
            <div className="feature-compute-proof-item" key={label}>
              <Icon
                name={icon as IconName}
                style={{ color: COMPUTE_ACCENT, flex: "0 0 auto" }}
              />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      <PublicSection>
        <Flex vertical gap={24}>
          <div style={{ maxWidth: 780 }}>
            <Title level={2} style={{ margin: "0 0 10px" }}>
              Choose what should move to the compute.
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: PUBLIC_TYPE.lead,
                margin: 0,
              }}
            >
              Start with the execution and file boundary. The hardware choice
              comes after you know which environment must own the code, data,
              services, and saved results.
            </Paragraph>
          </div>
          <div className="feature-compute-route-grid">
            {ROUTES.map((route) => (
              <div className="feature-compute-route-card" key={route.title}>
                <Flex vertical gap={14}>
                  <IconBadge accent={COMPUTE_ACCENT} icon={route.icon} />
                  <Title level={3} style={{ margin: 0 }}>
                    {route.title}
                  </Title>
                  <Paragraph
                    style={{
                      color: PUBLIC_COLORS.mutedText,
                      flex: 1,
                      margin: 0,
                    }}
                  >
                    {route.body}
                  </Paragraph>
                  <LinkButton href={route.href()}>{route.label}</LinkButton>
                </Flex>
              </div>
            ))}
          </div>
        </Flex>
      </PublicSection>

      <PublicSection>
        <Flex vertical gap={24}>
          <div style={{ maxWidth: 760 }}>
            <Title level={2} style={{ margin: "0 0 10px" }}>
              Measure a representative run before adding capacity.
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: PUBLIC_TYPE.lead,
                margin: 0,
              }}
            >
              Record the input, environment, resource use, and result from a
              smaller run. Then compare machines using measured results rather
              than assuming a hardware label predicts performance.
            </Paragraph>
          </div>
          <div className="feature-compute-capacity-grid">
            {CAPACITY_CHECKS.map((item) => (
              <div className="feature-compute-capacity-card" key={item.title}>
                <Flex vertical gap={12}>
                  <IconBadge
                    accent={COMPUTE_ACCENT}
                    icon={item.icon}
                    size="md"
                  />
                  <Title level={3} style={{ margin: 0 }}>
                    {item.title}
                  </Title>
                  <Paragraph
                    style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}
                  >
                    {item.body}
                  </Paragraph>
                </Flex>
              </div>
            ))}
          </div>
          <Flex gap={16} wrap>
            <LinkButton href={appPath("docs/hosts/access-and-ram")}>
              Check host access and RAM policy
            </LinkButton>
            <LinkButton href={appPath("docs/troubleshooting/memory")}>
              Investigate memory pressure
            </LinkButton>
          </Flex>
        </Flex>
      </PublicSection>

      <PublicSection>
        <Flex vertical gap={28}>
          <div style={{ maxWidth: 780 }}>
            <Title level={2} style={{ margin: "0 0 10px" }}>
              A listed machine is only the first check.
            </Title>
            <Paragraph
              style={{
                color: PUBLIC_COLORS.mutedText,
                fontSize: PUBLIC_TYPE.lead,
                margin: 0,
              }}
            >
              Compatibility, permission, provider capacity, and a ready runtime
              answer different questions. Confirm each one before starting the
              full workload.
            </Paragraph>
          </div>
          <div className="feature-compute-readiness">
            {[
              {
                body: "Confirm the machine type, architecture, location, GPU configuration, and runtime image can support the workload.",
                title: "Catalog and compatibility",
              },
              {
                body: "Check host delegation or account eligibility separately from provider quota and current regional capacity.",
                title: "Access and capacity",
              },
              {
                body: "Wait for startup and bootstrap, then test the intended terminal or kernel, inputs, devices, and saved result.",
                title: "Runtime readiness",
              },
            ].map((step) => (
              <div className="feature-compute-readiness-step" key={step.title}>
                <Title level={3} style={{ margin: "0 0 8px" }}>
                  {step.title}
                </Title>
                <Paragraph
                  style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}
                >
                  {step.body}
                </Paragraph>
              </div>
            ))}
          </div>
          <Paragraph
            style={{
              background: PUBLIC_COLORS.warningTint,
              border: `1px solid ${PUBLIC_COLORS.warningBorder}`,
              borderRadius: PUBLIC_RADIUS.panel,
              margin: 0,
              padding: "14px 16px",
            }}
          >
            Selecting a machine does not reserve provider capacity. A queued
            operation is not a ready runtime, and choosing a GPU image does not
            provide GPU hardware.
          </Paragraph>
        </Flex>
      </PublicSection>

      <PublicSection>
        <Row align="middle" gutter={[36, 28]}>
          <Col xs={24} lg={13}>
            <Flex vertical gap={16}>
              <Title level={2} style={{ margin: 0 }}>
                Save state before compute changes.
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  fontSize: PUBLIC_TYPE.lead,
                  margin: 0,
                }}
              >
                A project move transfers saved data through backup and restore;
                it does not transfer a running process or its memory. A remote
                kernel uses a separate filesystem that CoCalc does not
                automatically synchronize.
              </Paragraph>
              <BulletList
                items={[
                  "Write checkpoints and complete results to durable files before stopping or moving compute.",
                  "Confirm destination architecture, image, disk, access, and backup state before a project move.",
                  "Copy required inputs to a remote machine and deliberately bring durable outputs back when needed.",
                ]}
              />
              <Flex gap={16} wrap>
                <LinkButton href={appPath("docs/hosts/storage")}>
                  Understand storage and recovery
                </LinkButton>
                <LinkButton href={appPath("docs/hosts/move-projects")}>
                  Plan a project move
                </LinkButton>
                <LinkButton href={appPath("docs/hosts/lifecycle")}>
                  Review host lifecycle actions
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={11}>
            <TerminalMock
              title="Inspect compute with the CoCalc CLI"
              rows={[
                "$ cocalc host list --json",
                "$ cocalc host catalog --provider gcp",
                "$ cocalc host get HOST_ID",
                "$ cocalc host bootstrap-status HOST_ID",
              ]}
            />
            <Flex gap={14} style={{ marginTop: 12 }} wrap>
              <LinkButton href={appPath("docs/cli/getting-started")}>
                Get started with the CoCalc CLI
              </LinkButton>
              <LinkButton href={appPath("docs/cli/authentication-and-targets")}>
                Choose authentication and targets
              </LinkButton>
            </Flex>
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Run a small workload first, record what it uses, and then choose the execution path and capacity that fit the evidence.",
            href: appPath("docs/hosts/choose-compute"),
            label: "Choose compute for the workload",
            title: "Start with the work, not a machine label.",
          }}
          relatedLinks={[
            { href: appPath("products"), label: "Compare operating models" },
            {
              href: appPath("features/ai"),
              label: "Explore AI agent workflows",
            },
            {
              href: appPath("docs/cli/notebook-workflows"),
              label: "Run and save notebooks with the CLI",
            },
            ...(helpEmail
              ? [{ href: `mailto:${helpEmail}`, label: "Contact CoCalc" }]
              : []),
          ]}
          title="Keep compute connected to the project and its results"
        >
          <BulletList
            items={[
              "Use a project host when the whole CoCalc environment should run on the selected capacity.",
              "Use a remote kernel when one notebook should run near an existing machine, environment, or dataset.",
              "Keep software compatibility, permission, current capacity, and runtime readiness as separate checks.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
