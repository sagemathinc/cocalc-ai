import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Collapse,
  Input,
  message,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { useAsyncEffect, useTypedRedux } from "@cocalc/frontend/app-framework";
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
      return "ChatGPT plan";
    case "project-api-key":
      return "Workspace API key";
    case "account-api-key":
      return "Account API key";
    case "site-api-key":
      return "CoCalc Membership";
    case "shared-home":
      return "Shared home (~/.codex)";
    default:
      return "None";
  }
}

export function CodexCredentialsPanel(props: CodexCredentialsPanelProps = {}) {
  return <CodexCredentialsPanelBody {...props} />;
}

export interface CodexCredentialsPanelProps {
  embedded?: boolean;
  defaultWorkspaceId?: string;
  hidePanelChrome?: boolean;
}

type DeviceAuthState = "pending" | "completed" | "failed" | "canceled";

type DeviceAuthStatus = {
  id: string;
  projectId: string;
  accountId: string;
  codexHome: string;
  state: DeviceAuthState;
  verificationUrl?: string;
  userCode?: string;
  output: string;
  startedAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
};

const DEVICE_AUTH_ALERT_TYPE: Record<
  DeviceAuthState,
  "info" | "success" | "error" | "warning"
> = {
  pending: "info",
  completed: "success",
  failed: "error",
  canceled: "warning",
};

function CodexCredentialsPanelBody({
  embedded = false,
  defaultWorkspaceId = "",
  hidePanelChrome = false,
}: CodexCredentialsPanelProps = {}) {
  const projectMap = useTypedRedux("projects", "project_map");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [workspaceId, setWorkspaceId] = useState<string>(
    defaultWorkspaceId ?? "",
  );
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
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthStatus | null>(null);
  const [deviceAuthError, setDeviceAuthError] = useState<string>("");
  const [deviceAuthActionPending, setDeviceAuthActionPending] =
    useState<boolean>(false);
  const [authFileUploadPending, setAuthFileUploadPending] =
    useState<boolean>(false);
  const [uploadedAuthFileStatus, setUploadedAuthFileStatus] = useState<{
    codexHome: string;
    bytes: number;
    uploadedAt: number;
  } | null>(null);
  const authFileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = () => setRefreshToken((x) => x + 1);

  const recentWorkspaceId = useMemo(() => {
    if (!projectMap) return "";
    try {
      const projects = (projectMap as any).valueSeq().toJS() as any[];
      if (!projects.length) return "";
      projects.sort((a, b) => (b?.last_edited ?? 0) - (a?.last_edited ?? 0));
      return projects[0]?.project_id ?? "";
    } catch {
      return "";
    }
  }, [projectMap]);

  const authWorkspaceId = workspaceId.trim() || recentWorkspaceId;

  useEffect(() => {
    setWorkspaceId(defaultWorkspaceId ?? "");
  }, [defaultWorkspaceId]);

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

  const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    return `${err}`;
  };

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement("textarea");
        el.value = text;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      void message.success(`${label} copied`);
    } catch (err) {
      void message.error(
        `Unable to copy ${label.toLowerCase()}: ${getErrorMessage(err)}`,
      );
    }
  };

  const refreshDeviceAuth = async (id?: string) => {
    if (!authWorkspaceId) return;
    const authId = id ?? deviceAuth?.id;
    if (!authId) return;
    try {
      const status =
        await webapp_client.conat_client.hub.projects.codexDeviceAuthStatus({
          project_id: authWorkspaceId,
          id: authId,
        });
      setDeviceAuth(status as DeviceAuthStatus);
      if ((status as DeviceAuthStatus).state === "completed") {
        refresh();
      }
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    }
  };

  const startDeviceAuth = async () => {
    if (!authWorkspaceId) {
      setDeviceAuthError(
        "No workspace available. Create or open a workspace, then retry.",
      );
      return;
    }
    setDeviceAuthActionPending(true);
    setDeviceAuthError("");
    try {
      const status =
        await webapp_client.conat_client.hub.projects.codexDeviceAuthStart({
          project_id: authWorkspaceId,
        });
      setDeviceAuth(status as DeviceAuthStatus);
      refresh();
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setDeviceAuthActionPending(false);
    }
  };

  const cancelDeviceAuth = async () => {
    if (!authWorkspaceId || !deviceAuth?.id) return;
    setDeviceAuthActionPending(true);
    setDeviceAuthError("");
    try {
      await webapp_client.conat_client.hub.projects.codexDeviceAuthCancel({
        project_id: authWorkspaceId,
        id: deviceAuth.id,
      });
      await refreshDeviceAuth(deviceAuth.id);
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setDeviceAuthActionPending(false);
    }
  };

  const uploadAuthFile = async (file: File) => {
    if (!authWorkspaceId) {
      setDeviceAuthError(
        "No workspace available. Create or open a workspace, then retry.",
      );
      return;
    }
    setAuthFileUploadPending(true);
    setDeviceAuthError("");
    try {
      const content = await file.text();
      const result =
        await webapp_client.conat_client.hub.projects.codexUploadAuthFile({
          project_id: authWorkspaceId,
          filename: file.name,
          content,
        });
      setUploadedAuthFileStatus({
        codexHome: result.codexHome,
        bytes: result.bytes,
        uploadedAt: Date.now(),
      });
      refresh();
      void message.success("Auth file uploaded successfully");
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setAuthFileUploadPending(false);
      if (authFileInputRef.current) authFileInputRef.current.value = "";
    }
  };

  useEffect(() => {
    if (!authWorkspaceId || deviceAuth?.state !== "pending" || !deviceAuth.id) {
      return;
    }
    const timer = setInterval(() => {
      void refreshDeviceAuth(deviceAuth.id);
    }, 1500);
    return () => clearInterval(timer);
  }, [authWorkspaceId, deviceAuth?.id, deviceAuth?.state]);

  const content = (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
              <Text type="secondary">
                Order: ChatGPT Plan, Workspace OpenAI API key, Account OpenAI API key, then Site OpenAI API key.
              </Text>
              <Space wrap>
                <Tag color={paymentSource.hasSubscription ? "green" : "default"}>
                  ChatGPT plan
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
              {paymentSource.hasSubscription ? (
                <div style={{ marginTop: 8 }}>
                  <a
                    href="https://chatgpt.com/codex/settings/usage"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Check ChatGPT Codex usage
                  </a>
                </div>
              ) : null}
            </>
          }
        />
      )}
      <Collapse
        size="small"
        defaultActiveKey={[]}
        items={[
          {
            key: "subscription-auth",
            label: "Connect ChatGPT subscription",
            children: (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Text type="secondary">
                  Use device login, or upload local <Text code>~/.codex/auth.json</Text>{" "}
                  as a fallback.
                </Text>
                {!authWorkspaceId ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="No workspace available"
                    description="Create or open a workspace, then retry."
                  />
                ) : (
                  <Text type="secondary">
                    Using workspace: <Text code>{authWorkspaceId}</Text>
                    {!workspaceId.trim() ? " (most recently edited)" : ""}
                  </Text>
                )}
                <Space wrap>
                  <Button
                    type="primary"
                    onClick={() => void startDeviceAuth()}
                    loading={deviceAuthActionPending}
                    disabled={!authWorkspaceId || deviceAuth?.state === "pending"}
                  >
                    Start device login
                  </Button>
                  <Button
                    onClick={() => void refreshDeviceAuth()}
                    disabled={
                      !authWorkspaceId || !deviceAuth?.id || deviceAuthActionPending
                    }
                  >
                    Refresh status
                  </Button>
                  <Button
                    danger
                    onClick={() => void cancelDeviceAuth()}
                    loading={deviceAuthActionPending}
                    disabled={
                      !authWorkspaceId ||
                      !deviceAuth?.id ||
                      deviceAuth?.state !== "pending"
                    }
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => authFileInputRef.current?.click()}
                    loading={authFileUploadPending}
                    disabled={!authWorkspaceId || deviceAuthActionPending}
                  >
                    Upload local auth.json
                  </Button>
                </Space>
                <input
                  ref={authFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      void uploadAuthFile(file);
                    }
                  }}
                />
                {uploadedAuthFileStatus ? (
                  <Alert
                    type="success"
                    showIcon
                    message="Auth file uploaded"
                    description={`Saved ${uploadedAuthFileStatus.bytes} bytes to ${uploadedAuthFileStatus.codexHome}`}
                  />
                ) : null}
                {deviceAuthError ? (
                  <Alert type="error" showIcon message={deviceAuthError} />
                ) : null}
                {deviceAuth ? (
                  <Alert
                    type={DEVICE_AUTH_ALERT_TYPE[deviceAuth.state]}
                    showIcon
                    message={`Device auth status: ${deviceAuth.state}`}
                    description={
                      deviceAuth.state === "pending"
                        ? "Polling status every 1.5 seconds while this dialog is open."
                        : deviceAuth.error
                          ? deviceAuth.error
                          : undefined
                    }
                  />
                ) : null}
                {deviceAuth?.userCode && deviceAuth.state !== "completed" ? (
                  <div
                    style={{
                      border: "1px solid #d9d9d9",
                      borderRadius: 8,
                      padding: 12,
                      background: "#fafafa",
                    }}
                  >
                    <Text type="secondary">1. Copy this one-time code</Text>
                    <div
                      style={{
                        marginTop: 8,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 28,
                          lineHeight: "34px",
                          fontWeight: 700,
                          letterSpacing: "0.08em",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {deviceAuth.userCode}
                      </Text>
                      <Button onClick={() => void copyText(deviceAuth.userCode ?? "", "Device code")}>
                        Copy code
                      </Button>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Text type="secondary">
                        Device codes are a common phishing target. Never share this code.
                      </Text>
                    </div>
                  </div>
                ) : null}
                {deviceAuth?.verificationUrl && deviceAuth.state !== "completed" ? (
                  <div
                    style={{
                      border: "1px solid #d9d9d9",
                      borderRadius: 8,
                      padding: 12,
                      background: "#fafafa",
                    }}
                  >
                    <Text type="secondary">
                      2.{" "}
                      <a
                        href={deviceAuth.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open this link
                      </a>{" "}
                      in your browser, sign in to your account, and paste the code.
                    </Text>
                    <div style={{ marginTop: 8 }}>
                      <Space wrap>
                        <Button
                          onClick={() =>
                            void copyText(
                              deviceAuth.verificationUrl ?? "",
                              "Verification URL",
                            )
                          }
                        >
                          Copy URL
                        </Button>
                        <Button
                          type="primary"
                          href={deviceAuth.verificationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open
                        </Button>
                      </Space>
                    </div>
                  </div>
                ) : null}
                {deviceAuth?.output ? (
                  <Collapse
                    size="small"
                    items={[
                      {
                        key: "raw-device-auth-output",
                        label: "Show raw Codex output",
                        children: (
                          <Input.TextArea
                            readOnly
                            value={deviceAuth.output}
                            autoSize={{ minRows: 3, maxRows: 10 }}
                          />
                        ),
                      },
                    ]}
                  />
                ) : null}
              </Space>
            ),
          },
          {
            key: "api-keys",
            label: "OpenAI API Keys",
            children: (
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                <div style={{ maxWidth: 520 }}>
                  <div style={{ marginBottom: 6, fontWeight: 500 }}>
                    Workspace (optional)
                  </div>
                  <Space wrap style={{ width: "100%" }}>
                    <SelectProject
                      value={workspaceId}
                      onChange={(project_id) => setWorkspaceId(project_id ?? "")}
                      style={{ width: 360, maxWidth: "100%" }}
                    />
                    <Button onClick={refresh}>Refresh</Button>
                  </Space>
                </div>

                <div>
                  <div style={{ marginBottom: 6, fontWeight: 500 }}>
                    Account OpenAI API key
                  </div>
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
              </Space>
            ),
          },
          {
            key: "credentials",
            label: `Codex subscription credentials (${credentials.length})`,
            children: (
              <Table
                rowKey="id"
                size="small"
                dataSource={credentials}
                columns={columns as any}
                pagination={false}
                locale={{ emptyText: "No saved subscription credentials." }}
              />
            ),
          },
        ]}
      />
    </Space>
  );

  if (hidePanelChrome || embedded) {
    return content;
  }

  return (
    <Panel
      style={{ marginTop: "15px" }}
      header={
        <>
          <Icon name="robot" /> OpenAI Credentials & Codex Payment Source
        </>
      }
    >
      {content}
    </Panel>
  );
}
