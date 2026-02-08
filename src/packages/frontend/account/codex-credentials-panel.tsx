import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { useAsyncEffect, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import type {
  CodexPaymentSourceInfo,
  ExternalCredentialInfo,
} from "@cocalc/conat/hub/api/system";

const { Text } = Typography;

function sourceLabel(source: CodexPaymentSourceInfo["source"]): string {
  switch (source) {
    case "subscription":
      return "ChatGPT subscription";
    case "project-api-key":
      return "Workspace API key";
    case "account-api-key":
      return "Account API key";
    case "site-api-key":
      return "Site API key";
    case "shared-home":
      return "Shared home (~/.codex)";
    default:
      return "None";
  }
}

export function CodexCredentialsPanel() {
  const openaiEnabled = !!useTypedRedux("customize", "openai_enabled");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [paymentSource, setPaymentSource] = useState<
    CodexPaymentSourceInfo | undefined
  >(undefined);
  const [credentials, setCredentials] = useState<ExternalCredentialInfo[]>([]);
  const [revokingId, setRevokingId] = useState<string>("");

  const refresh = () => setRefreshToken((x) => x + 1);

  useAsyncEffect(
    async (isMounted) => {
      setLoading(true);
      setError("");
      try {
        const [payment, list] = await Promise.all([
          webapp_client.conat_client.hub.system.getCodexPaymentSource({
            project_id: workspaceId.trim() || undefined,
          }),
          webapp_client.conat_client.hub.system.listExternalCredentials({
            provider: "openai",
            kind: "codex-subscription-auth-json",
            scope: "account",
          }),
        ]);
        if (!isMounted()) return;
        setPaymentSource(payment as CodexPaymentSourceInfo);
        setCredentials((list as ExternalCredentialInfo[]) ?? []);
      } catch (err) {
        if (!isMounted()) return;
        setError(`${err}`);
      } finally {
        if (isMounted()) setLoading(false);
      }
    },
    [refreshToken, workspaceId],
  );

  const columns = useMemo(
    () => [
      {
        title: "Credential",
        key: "credential",
        render: () => <Tag color="blue">ChatGPT subscription</Tag>,
      },
      {
        title: "Updated",
        key: "updated",
        render: (_: any, row: ExternalCredentialInfo) => (
          <TimeAgo date={row.updated} />
        ),
      },
      {
        title: "Last used",
        key: "last_used",
        render: (_: any, row: ExternalCredentialInfo) =>
          row.last_used ? <TimeAgo date={row.last_used} /> : <Text type="secondary">Never</Text>,
      },
      {
        title: "Action",
        key: "action",
        render: (_: any, row: ExternalCredentialInfo) => (
          <Popconfirm
            title="Delete external credential?"
            description="This revokes it immediately for future Codex turns."
            okText="Delete"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              setRevokingId(row.id);
              try {
                await webapp_client.conat_client.hub.system.revokeExternalCredential({
                  id: row.id,
                });
                refresh();
              } catch (err) {
                setError(`${err}`);
              } finally {
                setRevokingId("");
              }
            }}
          >
            <Button
              size="small"
              danger
              loading={revokingId === row.id}
              disabled={!!row.revoked}
            >
              Delete
            </Button>
          </Popconfirm>
        ),
      },
    ],
    [revokingId],
  );

  const hasSiteApiKeyEffective =
    !!paymentSource?.hasSiteApiKey || openaiEnabled;
  const effectiveSource =
    paymentSource?.source === "none" && hasSiteApiKeyEffective
      ? "site-api-key"
      : paymentSource?.source;

  return (
    <Panel
      style={{ marginTop: "15px" }}
      header={
        <>
          <Icon name="robot" /> Codex Auth & Payment Source
        </>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Text type="secondary">
          If you have linked your ChatGPT subscription, Codex will try to use it
          first. If it is unavailable, Codex falls back to workspace API key,
          then account API key, then site API key.
        </Text>
        <Text type="secondary">
          This panel currently shows only your Codex subscription credentials.
        </Text>
        <div style={{ maxWidth: 460 }}>
          <div style={{ marginBottom: 6, fontWeight: 500 }}>
            Target Workspace (optional)
          </div>
          <SelectProject
            value={workspaceId}
            onChange={(project_id) => setWorkspaceId(project_id ?? "")}
            style={{ width: 440, maxWidth: "100%" }}
          />
          <div style={{ marginTop: 8 }}>
            <Button onClick={refresh}>Refresh</Button>
          </div>
        </div>

        {loading && <Loading />}
        {!loading && error && <Alert type="error" message={error} />}
        {!loading && !error && paymentSource && (
          <Alert
            type={effectiveSource === "none" ? "warning" : "info"}
            message={
              <Space>
                <span>Current Codex payment source:</span>
                <Tag color={effectiveSource === "none" ? "default" : "blue"}>
                  {sourceLabel(
                    (effectiveSource ?? "none") as CodexPaymentSourceInfo["source"],
                  )}
                </Tag>
              </Space>
            }
            description={
              <>
                <Space wrap>
                  <Tag color={paymentSource.hasSubscription ? "green" : "default"}>
                    subscription
                  </Tag>
                  <Tag color={paymentSource.hasProjectApiKey ? "green" : "default"}>
                    workspace key
                  </Tag>
                  <Tag color={paymentSource.hasAccountApiKey ? "green" : "default"}>
                    account key
                  </Tag>
                  <Tag color={hasSiteApiKeyEffective ? "green" : "default"}>
                    site key
                  </Tag>
                  <Tag>shared-home mode: {paymentSource.sharedHomeMode}</Tag>
                </Space>
                {openaiEnabled && !paymentSource.hasSiteApiKey && (
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary">
                      Site key availability inferred from OpenAI being enabled in site settings.
                    </Text>
                  </div>
                )}
              </>
            }
          />
        )}

        <Table
          rowKey="id"
          size="small"
          dataSource={credentials}
          columns={columns as any}
          pagination={false}
          locale={{ emptyText: "No external credentials saved." }}
        />
      </Space>
    </Panel>
  );
}
