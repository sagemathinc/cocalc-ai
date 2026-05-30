/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Progress,
  Row,
  Space,
  Tag,
  Typography,
} from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { ErrorDisplay, Icon, Loading } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  SiteSetupStatus,
  SiteSetupStep,
  SiteSetupStepState,
} from "@cocalc/conat/hub/api/system";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;

const heroStyle = {
  border: 0,
  background: `linear-gradient(135deg, ${COLORS.BLUE_DDD} 0%, ${COLORS.BLUE_D} 52%, ${COLORS.COCALC_ORANGE} 160%)`,
  color: "white",
} as const;

const subtlePanelStyle = {
  background: COLORS.GRAY_LLL,
  border: `1px solid ${COLORS.GRAY_LL}`,
} as const;

function stateTag(state: SiteSetupStepState): ReactNode {
  switch (state) {
    case "done":
      return <Tag color="green">Done</Tag>;
    case "blocked":
      return <Tag color="red">Blocked</Tag>;
    case "warning":
      return <Tag color="orange">Warning</Tag>;
    case "optional":
      return <Tag color="blue">Optional</Tag>;
    case "manual":
      return <Tag color="purple">Manual</Tag>;
  }
}

function stateBorderColor(state: SiteSetupStepState): string {
  switch (state) {
    case "done":
      return COLORS.BS_GREEN;
    case "blocked":
      return COLORS.ANTD_RED_WARN;
    case "warning":
      return COLORS.ORANGE_WARN;
    case "optional":
      return COLORS.BLUE;
    case "manual":
      return COLORS.COCALC_ORANGE;
  }
}

function actionForStep(step: SiteSetupStep):
  | {
      label: string;
      href?: string;
    }
  | undefined {
  switch (step.id) {
    case "admin-2fa":
      return { label: "Open account security", href: "/settings/profile" };
    case "domain-cloudflare":
      return { label: "Configure Cloudflare", href: "/admin/site-settings" };
    case "cloud-provider":
      return { label: "Configure GCP or Nebius", href: "/admin/site-settings" };
    case "provider-catalog":
      return {
        label: "Refresh provider catalog",
        href: "/admin/site-settings",
      };
    case "email":
      return { label: "Configure or skip email", href: "/admin/site-settings" };
    case "project-host":
      return { label: "Create a project host", href: "/hosts" };
    case "rootfs":
      return { label: "Manage RootFS images", href: "/admin/rootfs" };
    case "smoke-test":
      return { label: "Create smoke-test project", href: "/projects" };
    default:
      if (step.admin_section) {
        return {
          label: `Open ${step.admin_section}`,
          href: `/admin/${step.admin_section}`,
        };
      }
      return undefined;
  }
}

function stepIcon(step: SiteSetupStep): ReactNode {
  switch (step.id) {
    case "admin-2fa":
      return <Icon name="lock" />;
    case "domain-cloudflare":
      return <Icon name="cloud" />;
    case "cloud-provider":
    case "provider-catalog":
      return <Icon name="cloud-upload" />;
    case "project-host":
      return <Icon name="server" />;
    case "rootfs":
      return <Icon name="database" />;
    case "smoke-test":
      return <Icon name="play" />;
    default:
      return <Icon name="check-square" />;
  }
}

function StepCard({
  index,
  onRefresh,
  step,
}: {
  index: number;
  onRefresh: () => void;
  step: SiteSetupStep;
}) {
  const action = actionForStep(step);
  return (
    <Card
      size="small"
      style={{
        borderLeft: `5px solid ${stateBorderColor(step.state)}`,
      }}
      title={
        <Space wrap>
          <Text strong>{index}.</Text>
          {stepIcon(step)}
          {stateTag(step.state)}
          <span>{step.title}</span>
          {step.hard_gate ? <Tag>hard gate</Tag> : null}
        </Space>
      }
    >
      <Paragraph style={{ marginBottom: step.details?.length ? 8 : 0 }}>
        {step.summary}
      </Paragraph>
      {step.details?.length ? (
        <ul style={{ marginBottom: 0 }}>
          {step.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <Space wrap style={{ marginTop: 12 }}>
        {action?.href ? (
          <Button
            size="small"
            type={step.state === "done" ? "default" : "primary"}
            href={action.href}
          >
            {action.label}
          </Button>
        ) : null}
        <Button size="small" onClick={onRefresh}>
          Recheck
        </Button>
      </Space>
    </Card>
  );
}

function nextRequiredStep(status: SiteSetupStatus): SiteSetupStep | undefined {
  return (
    status.steps.find((step) => step.hard_gate && step.state !== "done") ??
    status.steps.find((step) => step.state !== "done")
  );
}

function SetupHero({ status }: { status?: SiteSetupStatus }) {
  const nextStep = status ? nextRequiredStep(status) : undefined;
  return (
    <Card style={heroStyle}>
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={15}>
          <Space direction="vertical" size="middle">
            <Tag color={status?.ready ? "green" : "gold"}>
              Launchpad/Rocket cloud setup
            </Tag>
            <Title level={2} style={{ color: "white", margin: 0 }}>
              Bring this CoCalc site online without guessing the sequence.
            </Title>
            <Paragraph
              style={{ color: "white", fontSize: 16, marginBottom: 0 }}
            >
              You need a Cloudflare account with a domain you control, plus a
              GCP project or Nebius account with CLI access. This setup will
              validate the public URL, provider credentials, first host,
              official RootFS, and smoke-test path.
            </Paragraph>
            {nextStep ? (
              <Alert
                type={status?.ready ? "success" : "warning"}
                showIcon
                message={
                  status?.ready
                    ? "All hard gates are complete."
                    : `Next required action: ${nextStep.title}`
                }
                description={nextStep.summary}
              />
            ) : null}
          </Space>
        </Col>
        <Col xs={24} lg={9}>
          <Card
            size="small"
            style={{
              background: "rgba(255, 255, 255, 0.92)",
              border: 0,
            }}
          >
            <Space direction="vertical" style={{ width: "100%" }}>
              <Text strong>Before you start, have:</Text>
              <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
                <li>Cloudflare account and domain.</li>
                <li>GCP project or Nebius account.</li>
                <li>CLI access on your workstation.</li>
                <li>A decision about whether email can be skipped.</li>
              </ul>
              <Divider style={{ margin: "8px 0" }} />
              <Text type="secondary">
                Single-VM appliance setup is a different future mode and should
                not require Cloudflare or cloud providers.
              </Text>
            </Space>
          </Card>
        </Col>
      </Row>
    </Card>
  );
}

function ProgressSummary({ status }: { status: SiteSetupStatus }) {
  return (
    <Card size="small" style={subtlePanelStyle}>
      <Row gutter={[16, 16]} align="middle">
        <Col xs={24} md={10}>
          <Progress
            percent={Math.round(
              (100 * status.hard_gates_done) /
                Math.max(1, status.hard_gates_total),
            )}
          />
          <Text>
            Hard gates: {status.hard_gates_done} / {status.hard_gates_total}
          </Text>
        </Col>
        <Col xs={24} md={14}>
          <Space wrap>
            <Tag>{status.counts.configured_providers} providers</Tag>
            <Tag>{status.counts.cached_provider_catalogs} cached catalogs</Tag>
            <Tag>{status.counts.healthy_project_hosts} healthy hosts</Tag>
            <Tag>{status.counts.official_rootfs_images} official RootFS</Tag>
            <Tag>{status.counts.prepull_rootfs_images} prepull RootFS</Tag>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">
              Last checked: {new Date(status.checked_at).toLocaleString()}
            </Text>
          </div>
        </Col>
      </Row>
    </Card>
  );
}

export function SiteSetupBanner({ onOpenSetup }: { onOpenSetup: () => void }) {
  const [status, setStatus] = useState<SiteSetupStatus>();

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const next =
          await webapp_client.conat_client.hub.system.getSiteSetupStatus({});
        if (mounted) {
          setStatus(next);
        }
      } catch {
        // The full setup page renders the actionable error. Do not make the
        // top banner noisy when the admin page itself is still usable.
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (status == null || status.ready) {
    return null;
  }

  const nextStep = nextRequiredStep(status);
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 18 }}
      message="This Launchpad/Rocket site is not fully set up."
      description={
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>
            {nextStep
              ? `Next required action: ${nextStep.title}. ${nextStep.summary}`
              : "Open the setup shell to finish the remaining checks."}
          </Text>
          <Space wrap>
            <Button type="primary" onClick={onOpenSetup}>
              Continue site setup
            </Button>
            <Button href="/admin/site-setup">Open focused setup page</Button>
          </Space>
        </Space>
      }
    />
  );
}

export function SiteSetupAdmin() {
  const [status, setStatus] = useState<SiteSetupStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const load = async () => {
    setLoading(true);
    try {
      setStatus(
        await webapp_client.conat_client.hub.system.getSiteSetupStatus({}),
      );
      setError("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading && status == null) {
    return <Loading />;
  }

  const hardGateSteps = status?.steps.filter((step) => step.hard_gate) ?? [];
  const optionalSteps = status?.steps.filter((step) => !step.hard_gate) ?? [];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <SetupHero status={status} />
      <Alert
        type={status?.ready ? "success" : "info"}
        showIcon
        message={
          status?.ready
            ? "All derived hard gates are satisfied."
            : "Follow these gates in order before treating this cloud-backed Launchpad/Rocket site as ready."
        }
        description="This setup profile assumes Cloudflare plus GCP or Nebius. A future single-VM appliance setup should have a separate, much shorter path."
      />
      {error ? <ErrorDisplay error={error} /> : null}
      {status ? (
        <>
          <ProgressSummary status={status} />
          <Title level={4} style={{ marginBottom: 0 }}>
            Required Setup Gates
          </Title>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {hardGateSteps.map((step, i) => (
              <StepCard
                index={i + 1}
                key={step.id}
                onRefresh={() => void load()}
                step={step}
              />
            ))}
          </Space>
          {optionalSteps.length ? (
            <>
              <Title level={4} style={{ marginBottom: 0 }}>
                Optional Or Deferred
              </Title>
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                {optionalSteps.map((step, i) => (
                  <StepCard
                    index={hardGateSteps.length + i + 1}
                    key={step.id}
                    onRefresh={() => void load()}
                    step={step}
                  />
                ))}
              </Space>
            </>
          ) : null}
        </>
      ) : null}
      <Button onClick={() => void load()} loading={loading}>
        Refresh setup status
      </Button>
    </Space>
  );
}
