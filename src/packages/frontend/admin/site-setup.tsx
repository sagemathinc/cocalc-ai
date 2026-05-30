/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Progress, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { ErrorDisplay, Loading } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  SiteSetupStatus,
  SiteSetupStep,
  SiteSetupStepState,
} from "@cocalc/conat/hub/api/system";

const { Paragraph, Text, Title } = Typography;

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

function StepCard({ step }: { step: SiteSetupStep }) {
  return (
    <Card
      size="small"
      title={
        <Space wrap>
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
      {step.admin_section ? (
        <div style={{ marginTop: 8 }}>
          <Button size="small" href={`/admin/${step.admin_section}`}>
            Open {step.admin_section}
          </Button>
        </div>
      ) : null}
    </Card>
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

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Title level={4} style={{ marginBottom: 0 }}>
        Site Setup Checklist
      </Title>
      <Alert
        type={status?.ready ? "success" : "info"}
        showIcon
        message={
          status?.ready
            ? "All derived hard gates are satisfied."
            : "Follow these gates in order before treating this Launchpad/Rocket site as ready."
        }
        description="Start with a secure admin account, a real domain on Cloudflare, then provider credentials, one healthy host, an official RootFS, and a smoke-test project."
      />
      {error ? <ErrorDisplay error={error} /> : null}
      {status ? (
        <>
          <Card size="small">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Progress
                percent={Math.round(
                  (100 * status.hard_gates_done) /
                    Math.max(1, status.hard_gates_total),
                )}
              />
              <Text>
                Hard gates: {status.hard_gates_done} / {status.hard_gates_total}
              </Text>
              <Text type="secondary">
                Last checked: {new Date(status.checked_at).toLocaleString()}
              </Text>
              <Space wrap>
                <Tag>{status.counts.configured_providers} providers</Tag>
                <Tag>
                  {status.counts.cached_provider_catalogs} cached catalogs
                </Tag>
                <Tag>{status.counts.healthy_project_hosts} healthy hosts</Tag>
                <Tag>
                  {status.counts.official_rootfs_images} official RootFS
                </Tag>
                <Tag>{status.counts.prepull_rootfs_images} prepull RootFS</Tag>
              </Space>
            </Space>
          </Card>
          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            {status.steps.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </Space>
        </>
      ) : null}
      <Button onClick={() => void load()} loading={loading}>
        Refresh setup status
      </Button>
    </Space>
  );
}
