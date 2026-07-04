/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Col, Row, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  CopyToClipBoard,
  ErrorDisplay,
  Icon,
  Loading,
} from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  SiteSetupStatus,
  SiteSetupStep,
  SiteSetupStepState,
  StarServerInfo,
} from "@cocalc/conat/hub/api/system";
import { COLORS } from "@cocalc/util/theme";
import type { AdminSection } from "./routing";

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
      return <Tag color="red">Setup needed</Tag>;
    case "warning":
      return <Tag color="orange">Review</Tag>;
    case "optional":
      return <Tag color="blue">Optional</Tag>;
    case "manual":
      return <Tag color="purple">Manual check</Tag>;
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
      return COLORS.FEATURE_JULIA_PURPLE;
  }
}

function actionForStep(step: SiteSetupStep):
  | {
      adminSection?: AdminSection;
      label: string;
      href?: string;
    }
  | undefined {
  switch (step.id) {
    case "admin-account":
      return { label: "Open account settings", href: "/settings/profile" };
    case "admin-2fa":
      return { label: "Open account security", href: "/settings/profile" };
    case "domain-cloudflare":
      return { label: "Configure Cloudflare", adminSection: "site-settings" };
    case "cloud-provider":
      return {
        label: "Configure GCP or Nebius",
        adminSection: "site-settings",
      };
    case "provider-catalog":
      return {
        label: "Refresh provider catalog",
        adminSection: "site-settings",
      };
    case "email":
      return {
        label: "Configure email",
        adminSection: "site-settings",
      };
    case "project-host":
      return { label: "Create a project host", href: "/hosts" };
    case "rootfs":
      return { label: "Manage RootFS images", adminSection: "rootfs" };
    case "custom-rootfs":
      return { label: "Customize RootFS images", adminSection: "rootfs" };
    case "smoke-test":
      return { label: "Create or open a project", href: "/projects" };
    case "backups":
      return {
        label: "Review project backups",
        adminSection: "project-backup-shards",
      };
    case "tls-public-url":
      return { label: "Configure public URL", adminSection: "site-settings" };
    case "license":
      return { label: "Review site settings", adminSection: "site-settings" };
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
    case "admin-account":
      return <Icon name="user" />;
    case "admin-2fa":
      return <Icon name="lock" />;
    case "domain-cloudflare":
      return <Icon name="cloud" />;
    case "project-backups":
      return <Icon name="disk-snapshot" />;
    case "cloud-provider":
    case "provider-catalog":
      return <Icon name="cloud-upload" />;
    case "email":
      return <Icon name="envelope" />;
    case "project-host":
      return <Icon name="server" />;
    case "rootfs":
      return <Icon name="database" />;
    case "smoke-test":
      return <Icon name="play" />;
    case "license":
      return <Icon name="key" />;
    case "tls-public-url":
      return <Icon name="global" />;
    case "custom-rootfs":
      return <Icon name="cogs" />;
    default:
      return <Icon name="check-square" />;
  }
}

function StepCard({
  index,
  onNavigateAdminSection,
  showStateTag = true,
  step,
}: {
  index: number;
  onNavigateAdminSection?: (section: AdminSection) => void;
  showStateTag?: boolean;
  step: SiteSetupStep;
}) {
  const action = actionForStep(step);
  const details = step.details ?? [];
  const showDetails = step.state !== "done" && details.length > 0;
  const adminSection = action?.adminSection;
  const actionType =
    step.hard_gate && step.state !== "done" ? "primary" : "default";
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
          <span>{step.title}</span>
          {showStateTag ? stateTag(step.state) : null}
        </Space>
      }
    >
      <Paragraph style={{ marginBottom: showDetails ? 8 : 0 }}>
        {step.summary}
      </Paragraph>
      {showDetails ? (
        <ul style={{ marginBottom: 0 }}>
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <Space wrap style={{ marginTop: 12 }}>
        {adminSection ? (
          <Button
            type={actionType}
            href={
              onNavigateAdminSection == null
                ? `/admin/${adminSection}`
                : undefined
            }
            onClick={
              onNavigateAdminSection == null
                ? undefined
                : () => onNavigateAdminSection(adminSection)
            }
          >
            {action.label}
          </Button>
        ) : action?.href ? (
          <Button type={actionType} href={action.href}>
            {action.label}
          </Button>
        ) : null}
      </Space>
    </Card>
  );
}

function nextRequiredStep(status: SiteSetupStatus): SiteSetupStep | undefined {
  return status.steps.find((step) => step.hard_gate && step.state !== "done");
}

function SetupHero({ status }: { status?: SiteSetupStatus }) {
  const isStar = status?.profile === "star";
  return (
    <Card style={heroStyle}>
      <Space direction="vertical" size="middle">
        <Title level={2} style={{ color: "white", margin: 0 }}>
          {isStar
            ? "Get this single-VM CoCalc appliance usable with almost no configuration."
            : "Bring this CoCalc site online without guessing the sequence."}
        </Title>
        <Paragraph style={{ color: "white", fontSize: 16, marginBottom: 0 }}>
          {isStar
            ? "CoCalc Star runs the control plane and project execution on one dedicated VM. Setup requires only the first admin account and a working smoke-test path; email, TLS, backups, license entry, and custom images are supported follow-ups."
            : "You need a Cloudflare account with a domain you control, plus a GCP project or Nebius account with CLI access. This setup will validate the public URL, provider credentials, first host, official RootFS, and smoke-test path."}
        </Paragraph>
      </Space>
    </Card>
  );
}

function StarInviteCard({ inviteUrl }: { inviteUrl?: string }) {
  if (!inviteUrl) return null;
  return (
    <Card
      size="small"
      title={
        <Space>
          <Icon name="user-plus" />
          <span>Invite users</span>
        </Space>
      }
      style={subtlePanelStyle}
    >
      <Paragraph>
        Share this sign-up link with people who should be able to create
        accounts on this CoCalc Star instance.
      </Paragraph>
      <CopyToClipBoard
        value={inviteUrl}
        inputWidth="min(76vw, 720px)"
        copyTip="Invite link copied"
      />
      <Space wrap style={{ marginTop: 12 }}>
        <Button href={inviteUrl} target="_blank">
          Open invite sign-up page
        </Button>
        <Text type="secondary">
          The link uses the reusable Star registration token created during
          install.
        </Text>
      </Space>
    </Card>
  );
}

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function InfoLine({ label, value }: { label: string; value?: ReactNode }) {
  if (!value) return null;
  return (
    <Col xs={24} md={12}>
      <Space direction="vertical" size={0}>
        <Text type="secondary">{label}</Text>
        <Text>{value}</Text>
      </Space>
    </Col>
  );
}

function StarAboutCard({ info }: { info?: StarServerInfo }) {
  const releaseUrl = info?.release_id
    ? `https://github.com/sagemathinc/cocalc-ai/releases/tag/${info.release_id}`
    : undefined;
  return (
    <Card
      size="small"
      title={
        <Space>
          <Icon name="info-circle" />
          <span>About this server</span>
        </Space>
      }
      style={subtlePanelStyle}
    >
      {!info ? (
        <Loading />
      ) : !info.detected ? (
        <Alert
          type="info"
          showIcon
          message="No CoCalc Star release metadata found on this server."
        />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Row gutter={[16, 12]}>
            <InfoLine label="Product" value={info.product} />
            <InfoLine
              label="Channel"
              value={info.channel ? <Tag>{info.channel}</Tag> : "unknown"}
            />
            <InfoLine
              label="Release"
              value={
                info.release_id ? (
                  releaseUrl ? (
                    <Typography.Link href={releaseUrl} target="_blank">
                      {info.release_id}
                    </Typography.Link>
                  ) : (
                    info.release_id
                  )
                ) : (
                  "unknown"
                )
              }
            />
            <InfoLine label="Git revision" value={info.git_revision} />
            <InfoLine label="Built" value={formatDate(info.built_at)} />
            <InfoLine label="Installed" value={formatDate(info.installed_at)} />
            <InfoLine label="Promoted" value={formatDate(info.promoted_at)} />
            <InfoLine
              label="Runtime"
              value={`${info.platform} ${info.os_release} (${info.architecture})`}
            />
            <InfoLine label="Hostname" value={info.hostname} />
            <InfoLine label="Install root" value={info.install_root} />
          </Row>
          <Space wrap>
            {info.release_id ? (
              <CopyToClipBoard
                value={info.release_id}
                inputWidth="min(76vw, 360px)"
                copyTip="Release id copied"
              />
            ) : null}
            {info.git_dirty ? <Tag color="orange">dirty build</Tag> : null}
            {info.artifact_mode ? <Tag>{info.artifact_mode}</Tag> : null}
          </Space>
        </Space>
      )}
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
  const isStar = status.profile === "star";
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 18 }}
      message={
        isStar
          ? "This CoCalc Star appliance has setup checks remaining."
          : "This Launchpad/Rocket site is not fully set up."
      }
      description={
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>
            {nextStep
              ? `Next required action: ${nextStep.title}. ${nextStep.summary}`
              : "Open the setup shell to finish the remaining checks."}
          </Text>
          <Space wrap>
            <Button onClick={onOpenSetup}>Review all setup steps</Button>
          </Space>
        </Space>
      }
    />
  );
}

export function SiteSetupAdmin({
  onNavigateAdminSection,
}: {
  onNavigateAdminSection?: (section: AdminSection) => void;
}) {
  const [status, setStatus] = useState<SiteSetupStatus>();
  const [starInfo, setStarInfo] = useState<StarServerInfo>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const load = async () => {
    setLoading(true);
    try {
      const nextStatus =
        await webapp_client.conat_client.hub.system.getSiteSetupStatus({});
      setStatus(nextStatus);
      if (nextStatus.profile === "star") {
        setStarInfo(
          await webapp_client.conat_client.hub.system.getStarServerInfo({}),
        );
      } else {
        setStarInfo(undefined);
      }
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
  const isStar = status?.profile === "star";

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <SetupHero status={status} />
      {error ? <ErrorDisplay error={error} /> : null}
      {status ? (
        <>
          {isStar ? <StarInviteCard inviteUrl={status.invite_url} /> : null}
          {isStar ? <StarAboutCard info={starInfo} /> : null}
          <Space
            align="center"
            style={{ justifyContent: "space-between", width: "100%" }}
          >
            <Title level={4} style={{ marginBottom: 0 }}>
              Required Steps
            </Title>
            <Button onClick={() => void load()} loading={loading}>
              Refresh setup status
            </Button>
          </Space>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {hardGateSteps.map((step, i) => (
              <StepCard
                index={i + 1}
                key={step.id}
                onNavigateAdminSection={onNavigateAdminSection}
                step={step}
              />
            ))}
          </Space>
          {optionalSteps.length ? (
            <>
              <Title level={4} style={{ marginBottom: 0 }}>
                Optional Steps
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
                    onNavigateAdminSection={onNavigateAdminSection}
                    showStateTag={step.state !== "optional"}
                    step={step}
                  />
                ))}
              </Space>
            </>
          ) : null}
        </>
      ) : null}
    </Space>
  );
}
