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
import { useAsyncEffect } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import Password from "@cocalc/frontend/components/password";
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
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [paymentSource, setPaymentSource] = useState<
    CodexPaymentSourceInfo | undefined
  >(undefined);
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(undefined);
  const [credentials, setCredentials] = useState<ExternalCredentialInfo[]>([]);
  const [revokingId, setRevokingId] = useState<string>("");
  const [accountApiKey, setAccountApiKey] = useState<string>("");
  const [workspaceApiKey, setWorkspaceApiKey] = useState<string>("");
  const [savingScope, setSavingScope] = useState<"" | "account" | "project">(
    "",
  );
  const [deletingScope, setDeletingScope] = useState<"" | "account" | "project">(
    "",
  );

  const refresh = () => setRefreshToken((x) => x + 1);

  useAsyncEffect(
    async (isMounted) => {
      setLoading(true);
      setError("");
      try {
        const systemApi: any = webapp_client.conat_client.hub.system as any;
        const [payment, list, keyStatus] = await Promise.all([
          webapp_client.conat_client.hub.system.getCodexPaymentSource({
            project_id: workspaceId.trim() || undefined,
          }),
          webapp_client.conat_client.hub.system.listExternalCredentials({
            provider: "openai",
            kind: "codex-subscription-auth-json",
            scope: "account",
          }),
          systemApi.getOpenAiApiKeyStatus({
            project_id: workspaceId.trim() || undefined,
          }),
        ]);
        if (!isMounted()) return;
        setPaymentSource(payment as CodexPaymentSourceInfo);
        setCredentials((list as ExternalCredentialInfo[]) ?? []);
        setApiKeyStatus(keyStatus ?? {});
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
            description="This revokes it for future Codex turns."
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

  return (
    <Panel
      style={{ marginTop: "15px" }}
      header={
        <>
          <Icon name="robot" /> OpenAI Credentials & Codex Payment Source
        </>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Text type="secondary">
          OpenAI API keys are used for OpenAI-powered features in CoCalc,
          including Codex.
        </Text>
        <Text type="secondary">
          If you have linked your ChatGPT subscription, Codex will try to use it
          first. If it is unavailable, Codex falls back to workspace API key,
          then account API key, then site API key.
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

        <div>
          <div style={{ marginBottom: 6, fontWeight: 500 }}>
            Account OpenAI API key
          </div>
          <Text type="secondary">
            Used for OpenAI-powered features in any workspace when subscription
            and workspace-level key are unavailable.
          </Text>
          <div style={{ marginTop: 8, marginBottom: 8 }}>
            {apiKeyStatus?.account ? (
              <Space wrap>
                <Tag color="green">Configured</Tag>
                <Text type="secondary">
                  Updated <TimeAgo date={apiKeyStatus.account.updated} />
                </Text>
                <Text type="secondary">
                  Last used{" "}
                  {apiKeyStatus.account.last_used ? (
                    <TimeAgo date={apiKeyStatus.account.last_used} />
                  ) : (
                    "Never"
                  )}
                </Text>
              </Space>
            ) : (
              <Tag>Not configured</Tag>
            )}
          </div>
          <Space wrap>
            <Password
              value={accountApiKey}
              onChange={(e) => setAccountApiKey(e.target.value)}
              placeholder="sk-..."
              visibilityToggle
              style={{ width: 360, maxWidth: "100%" }}
            />
            <Button
              type="primary"
              loading={savingScope === "account"}
              onClick={async () => {
                const key = accountApiKey.trim();
                if (!key) {
                  setError("Account API key cannot be empty.");
                  return;
                }
                setSavingScope("account");
                setError("");
                try {
                  await (webapp_client.conat_client.hub.system as any).setOpenAiApiKey({
                    api_key: key,
                  });
                  setAccountApiKey("");
                  refresh();
                } catch (err) {
                  setError(`${err}`);
                } finally {
                  setSavingScope("");
                }
              }}
            >
              Save account key
            </Button>
            <Popconfirm
              title="Delete account API key?"
              okText="Delete"
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                setDeletingScope("account");
                setError("");
                try {
                  await (webapp_client.conat_client.hub.system as any).deleteOpenAiApiKey({});
                  refresh();
                } catch (err) {
                  setError(`${err}`);
                } finally {
                  setDeletingScope("");
                }
              }}
            >
              <Button
                danger
                loading={deletingScope === "account"}
                disabled={!apiKeyStatus?.account}
              >
                Delete account key
              </Button>
            </Popconfirm>
          </Space>
        </div>

        <div>
          <div style={{ marginBottom: 6, fontWeight: 500 }}>
            Workspace OpenAI API key
          </div>
          <Text type="secondary">
            Shared by collaborators in the selected workspace and used before
            your account key for OpenAI-powered features.
          </Text>
          <div style={{ marginTop: 8, marginBottom: 8 }}>
            {!workspaceId.trim() ? (
              <Tag>Select a workspace above</Tag>
            ) : apiKeyStatus?.project ? (
              <Space wrap>
                <Tag color="green">Configured</Tag>
                <Text type="secondary">
                  Updated <TimeAgo date={apiKeyStatus.project.updated} />
                </Text>
                <Text type="secondary">
                  Last used{" "}
                  {apiKeyStatus.project.last_used ? (
                    <TimeAgo date={apiKeyStatus.project.last_used} />
                  ) : (
                    "Never"
                  )}
                </Text>
              </Space>
            ) : (
              <Tag>Not configured for selected workspace</Tag>
            )}
          </div>
          <Space wrap>
            <Password
              value={workspaceApiKey}
              onChange={(e) => setWorkspaceApiKey(e.target.value)}
              placeholder="sk-..."
              visibilityToggle
              style={{ width: 360, maxWidth: "100%" }}
              disabled={!workspaceId.trim()}
            />
            <Button
              type="primary"
              loading={savingScope === "project"}
              disabled={!workspaceId.trim()}
              onClick={async () => {
                const key = workspaceApiKey.trim();
                if (!key) {
                  setError("Workspace API key cannot be empty.");
                  return;
                }
                if (!workspaceId.trim()) {
                  setError("Select a workspace first.");
                  return;
                }
                setSavingScope("project");
                setError("");
                try {
                  await (webapp_client.conat_client.hub.system as any).setOpenAiApiKey({
                    project_id: workspaceId,
                    api_key: key,
                  });
                  setWorkspaceApiKey("");
                  refresh();
                } catch (err) {
                  setError(`${err}`);
                } finally {
                  setSavingScope("");
                }
              }}
            >
              Save workspace key
            </Button>
            <Popconfirm
              title="Delete workspace API key?"
              okText="Delete"
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                if (!workspaceId.trim()) return;
                setDeletingScope("project");
                setError("");
                try {
                  await (webapp_client.conat_client.hub.system as any).deleteOpenAiApiKey({
                    project_id: workspaceId,
                  });
                  refresh();
                } catch (err) {
                  setError(`${err}`);
                } finally {
                  setDeletingScope("");
                }
              }}
            >
              <Button
                danger
                loading={deletingScope === "project"}
                disabled={!workspaceId.trim() || !apiKeyStatus?.project}
              >
                Delete workspace key
              </Button>
            </Popconfirm>
          </Space>
        </div>

        {loading && <Loading />}
        {!loading && error && <Alert type="error" message={error} />}
        {!loading && !error && paymentSource && (
          <Alert
            type={paymentSource.source === "none" ? "warning" : "info"}
            message={
              <Space>
                <span>Current Codex payment source:</span>
                <Tag color={paymentSource.source === "none" ? "default" : "blue"}>
                  {sourceLabel(
                    paymentSource.source as CodexPaymentSourceInfo["source"],
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
                  <Tag color={paymentSource.hasSiteApiKey ? "green" : "default"}>
                    site key
                  </Tag>
                  <Tag>shared-home mode: {paymentSource.sharedHomeMode}</Tag>
                </Space>
              </>
            }
          />
        )}

        <div>
          <div style={{ marginBottom: 6, fontWeight: 500 }}>
            Codex subscription credentials
          </div>
        </div>
        <Table
          rowKey="id"
          size="small"
          dataSource={credentials}
          columns={columns as any}
          pagination={false}
          locale={{ emptyText: "No Codex subscription credentials saved." }}
        />
      </Space>
    </Panel>
  );
}
