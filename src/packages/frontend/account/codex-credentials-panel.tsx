import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import type {
  CodexPaymentSourceInfo,
  ExternalCredentialInfo,
} from "@cocalc/conat/hub/api/system";

const { Text } = Typography;

function sourceLabel(source: CodexPaymentSourceInfo["source"]): string {
  if (lite) {
    if (source === "subscription") return "ChatGPT Plan";
    if (
      source === "project-api-key" ||
      source === "account-api-key" ||
      source === "site-api-key"
    ) {
      return "OpenAI API key";
    }
    if (source === "shared-home") return "Local Codex auth";
    return "Not configured";
  }
  switch (source) {
    case "subscription":
      return "ChatGPT plan";
    case "project-api-key":
      return "Project API key";
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
  defaultProjectId?: string;
  hidePanelChrome?: boolean;
  onPaymentSourceChanged?: () => void;
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
  defaultProjectId = "",
  hidePanelChrome = false,
  onPaymentSourceChanged,
}: CodexCredentialsPanelProps = {}) {
  const projectMap = useTypedRedux("projects", "project_map");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    defaultProjectId ?? "",
  );
  const [paymentSource, setPaymentSource] = useState<
    CodexPaymentSourceInfo | undefined
  >(undefined);
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(undefined);
  const [credentials, setCredentials] = useState<ExternalCredentialInfo[]>([]);
  const [revokingId, setRevokingId] = useState<string>("");
  const [accountApiKey, setAccountApiKey] = useState<string>("");
  const [projectApiKey, setProjectApiKey] = useState<string>("");
  const [savingScope, setSavingScope] = useState<"" | "account" | "project">(
    "",
  );
  const [deletingScope, setDeletingScope] = useState<
    "" | "account" | "project"
  >("");
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
  const previousProjectKeyRef = useRef(selectedProjectId.trim());

  const refresh = () => setRefreshToken((x) => x + 1);
  const refreshAfterPaymentSourceChange = useCallback(() => {
    refresh();
    onPaymentSourceChanged?.();
  }, [onPaymentSourceChanged]);

  const recentProjectId = useMemo(() => {
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

  const authProjectId = selectedProjectId.trim() || recentProjectId;

  useEffect(() => {
    setSelectedProjectId(defaultProjectId ?? "");
  }, [defaultProjectId]);

  useAsyncEffect(
    async (isMounted) => {
      const projectKey = selectedProjectId.trim();
      const projectChanged = previousProjectKeyRef.current !== projectKey;
      previousProjectKeyRef.current = projectKey;
      if (projectChanged) {
        setPaymentSource(undefined);
        setCredentials([]);
        setApiKeyStatus(undefined);
        setDeviceAuth(null);
        setDeviceAuthError("");
        setUploadedAuthFileStatus(null);
      }
      setLoading(true);
      setError("");
      try {
        const project_id = projectKey || undefined;
        let payment: CodexPaymentSourceInfo;
        let list: ExternalCredentialInfo[] = [];
        let keyStatus: any = {};

        if (lite) {
          payment =
            await webapp_client.conat_client.hub.system.getCodexPaymentSource({
              project_id,
            });
        } else {
          const systemApi: any = webapp_client.conat_client.hub.system as any;
          const result = await Promise.all([
            webapp_client.conat_client.hub.system.getCodexPaymentSource({
              project_id,
            }),
            webapp_client.conat_client.hub.system.listExternalCredentials({
              provider: "openai",
              kind: "codex-subscription-auth-json",
              scope: "account",
            }),
            systemApi.getOpenAiApiKeyStatus({
              project_id,
            }),
          ]);
          payment = result[0] as CodexPaymentSourceInfo;
          list = (result[1] as ExternalCredentialInfo[]) ?? [];
          keyStatus = result[2] ?? {};
        }
        if (!isMounted()) return;
        setPaymentSource(payment as CodexPaymentSourceInfo);
        setCredentials(list);
        setApiKeyStatus(keyStatus ?? {});
      } catch (err) {
        if (!isMounted()) return;
        setError(`${err}`);
      } finally {
        if (isMounted()) setLoading(false);
      }
    },
    [refreshToken, selectedProjectId],
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
          row.last_used ? (
            <TimeAgo date={row.last_used} />
          ) : (
            <Text type="secondary">Never</Text>
          ),
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
                await webapp_client.conat_client.hub.system.revokeExternalCredential(
                  {
                    id: row.id,
                  },
                );
                refreshAfterPaymentSourceChange();
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
    [refreshAfterPaymentSourceChange, revokingId],
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
    if (!authProjectId) return;
    const authId = id ?? deviceAuth?.id;
    if (!authId) return;
    try {
      const status =
        await webapp_client.conat_client.hub.projects.codexDeviceAuthStatus({
          project_id: authProjectId,
          id: authId,
        });
      setDeviceAuth(status as DeviceAuthStatus);
      if ((status as DeviceAuthStatus).state === "completed") {
        refreshAfterPaymentSourceChange();
      }
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    }
  };

  const startDeviceAuth = async () => {
    if (!authProjectId) {
      setDeviceAuthError(
        "No project available. Create or open a project, then retry.",
      );
      return;
    }
    setDeviceAuthActionPending(true);
    setDeviceAuthError("");
    try {
      const status =
        await webapp_client.conat_client.hub.projects.codexDeviceAuthStart({
          project_id: authProjectId,
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
    if (!authProjectId || !deviceAuth?.id) return;
    setDeviceAuthActionPending(true);
    setDeviceAuthError("");
    try {
      await webapp_client.conat_client.hub.projects.codexDeviceAuthCancel({
        project_id: authProjectId,
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
    if (!authProjectId) {
      setDeviceAuthError(
        "No project available. Create or open a project, then retry.",
      );
      return;
    }
    setAuthFileUploadPending(true);
    setDeviceAuthError("");
    try {
      const content = await file.text();
      const result =
        await webapp_client.conat_client.hub.projects.codexUploadAuthFile({
          project_id: authProjectId,
          filename: file.name,
          content,
        });
      setUploadedAuthFileStatus({
        codexHome: result.codexHome,
        bytes: result.bytes,
        uploadedAt: Date.now(),
      });
      refreshAfterPaymentSourceChange();
      void message.success("Auth file uploaded successfully");
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setAuthFileUploadPending(false);
      if (authFileInputRef.current) authFileInputRef.current.value = "";
    }
  };

  useEffect(() => {
    if (!authProjectId || deviceAuth?.state !== "pending" || !deviceAuth.id) {
      return;
    }
    const timer = setInterval(() => {
      void refreshDeviceAuth(deviceAuth.id);
    }, 1500);
    return () => clearInterval(timer);
  }, [authProjectId, deviceAuth?.id, deviceAuth?.state]);

  const content = (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {loading && <Loading />}
      {!loading && error && <Alert type="error" title={error} />}
      {!loading && !error && paymentSource && (
        <Alert
          type={paymentSource.source === "none" ? "warning" : "info"}
          title={
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
            lite ? (
              <Text type="secondary">
                In Lite mode, Codex uses either your ChatGPT Plan or one OpenAI
                API key.
              </Text>
            ) : (
              <>
                <Text type="secondary">
                  Order: ChatGPT Plan, Project OpenAI API key, Account OpenAI
                  API key, then Site OpenAI API key.
                </Text>
                <Space wrap>
                  <Tag
                    color={paymentSource.hasSubscription ? "green" : "default"}
                  >
                    ChatGPT plan
                  </Tag>
                  <Tag
                    color={paymentSource.hasProjectApiKey ? "green" : "default"}
                  >
                    project key
                  </Tag>
                  <Tag
                    color={paymentSource.hasAccountApiKey ? "green" : "default"}
                  >
                    account key
                  </Tag>
                  <Tag
                    color={paymentSource.hasSiteApiKey ? "green" : "default"}
                  >
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
            )
          }
        />
      )}
      <Collapse
        size="small"
        defaultActiveKey={[]}
        items={[
          {
            key: "subscription-auth",
            label: lite
              ? "Option A: Connect ChatGPT Plan"
              : "Connect ChatGPT subscription",
            children: (
              <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                <Text type="secondary">
                  Use device login, or upload local{" "}
                  <Text code>~/.codex/auth.json</Text> as a fallback.
                </Text>
                {!authProjectId ? (
                  <Alert
                    type="warning"
                    showIcon
                    title="No project available"
                    description="Create or open a project, then retry."
                  />
                ) : (
                  <Text type="secondary">
                    Using project: <Text code>{authProjectId}</Text>
                    {!selectedProjectId.trim() ? " (most recently edited)" : ""}
                  </Text>
                )}
                <Space wrap>
                  <Button
                    type="primary"
                    onClick={() => void startDeviceAuth()}
                    loading={deviceAuthActionPending}
                    disabled={!authProjectId || deviceAuth?.state === "pending"}
                  >
                    Start device login
                  </Button>
                  <Button
                    onClick={() => void refreshDeviceAuth()}
                    disabled={
                      !authProjectId ||
                      !deviceAuth?.id ||
                      deviceAuthActionPending
                    }
                  >
                    Refresh status
                  </Button>
                  <Button
                    danger
                    onClick={() => void cancelDeviceAuth()}
                    loading={deviceAuthActionPending}
                    disabled={
                      !authProjectId ||
                      !deviceAuth?.id ||
                      deviceAuth?.state !== "pending"
                    }
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => authFileInputRef.current?.click()}
                    loading={authFileUploadPending}
                    disabled={!authProjectId || deviceAuthActionPending}
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
                    title="Auth file uploaded"
                    description={`Saved ${uploadedAuthFileStatus.bytes} bytes to ${uploadedAuthFileStatus.codexHome}`}
                  />
                ) : null}
                {deviceAuthError ? (
                  <Alert type="error" showIcon title={deviceAuthError} />
                ) : null}
                {deviceAuth ? (
                  <Alert
                    type={DEVICE_AUTH_ALERT_TYPE[deviceAuth.state]}
                    showIcon
                    title={`Device auth status: ${deviceAuth.state}`}
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
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, monospace",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {deviceAuth.userCode}
                      </Text>
                      <Button
                        onClick={() =>
                          void copyText(
                            deviceAuth.userCode ?? "",
                            "Device code",
                          )
                        }
                      >
                        Copy code
                      </Button>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Text type="secondary">
                        Device codes are a common phishing target. Never share
                        this code.
                      </Text>
                    </div>
                  </div>
                ) : null}
                {deviceAuth?.verificationUrl &&
                deviceAuth.state !== "completed" ? (
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
                      in your browser, sign in to your account, and paste the
                      code.
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
          ...(lite
            ? []
            : [
                {
                  key: "api-keys",
                  label: "OpenAI API Keys",
                  children: (
                    <Space
                      orientation="vertical"
                      size="middle"
                      style={{ width: "100%" }}
                    >
                      <div style={{ maxWidth: 520 }}>
                        <div style={{ marginBottom: 6, fontWeight: 500 }}>
                          Project (optional)
                        </div>
                        <Space wrap style={{ width: "100%" }}>
                          <SelectProject
                            value={selectedProjectId}
                            onChange={(project_id) =>
                              setSelectedProjectId(project_id ?? "")
                            }
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
                                Updated{" "}
                                <TimeAgo date={apiKeyStatus.account.updated} />
                              </Text>
                              <Text type="secondary">
                                Last used{" "}
                                {apiKeyStatus.account.last_used ? (
                                  <TimeAgo
                                    date={apiKeyStatus.account.last_used}
                                  />
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
                                await (
                                  webapp_client.conat_client.hub.system as any
                                ).setOpenAiApiKey({
                                  api_key: key,
                                });
                                setAccountApiKey("");
                                refreshAfterPaymentSourceChange();
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
                                await (
                                  webapp_client.conat_client.hub.system as any
                                ).deleteOpenAiApiKey({});
                                refreshAfterPaymentSourceChange();
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
                          Project OpenAI API key
                        </div>
                        <div style={{ marginTop: 8, marginBottom: 8 }}>
                          {!selectedProjectId.trim() ? (
                            <Tag>Select a project above</Tag>
                          ) : apiKeyStatus?.project ? (
                            <Space wrap>
                              <Tag color="green">Configured</Tag>
                              <Text type="secondary">
                                Updated{" "}
                                <TimeAgo date={apiKeyStatus.project.updated} />
                              </Text>
                              <Text type="secondary">
                                Last used{" "}
                                {apiKeyStatus.project.last_used ? (
                                  <TimeAgo
                                    date={apiKeyStatus.project.last_used}
                                  />
                                ) : (
                                  "Never"
                                )}
                              </Text>
                            </Space>
                          ) : (
                            <Tag>Not configured for selected project</Tag>
                          )}
                        </div>
                        <Space wrap>
                          <Password
                            value={projectApiKey}
                            onChange={(e) => setProjectApiKey(e.target.value)}
                            placeholder="sk-..."
                            visibilityToggle
                            style={{ width: 360, maxWidth: "100%" }}
                            disabled={!selectedProjectId.trim()}
                          />
                          <Button
                            type="primary"
                            loading={savingScope === "project"}
                            disabled={!selectedProjectId.trim()}
                            onClick={async () => {
                              const key = projectApiKey.trim();
                              if (!key) {
                                setError("Project API key cannot be empty.");
                                return;
                              }
                              if (!selectedProjectId.trim()) {
                                setError("Select a project first.");
                                return;
                              }
                              setSavingScope("project");
                              setError("");
                              try {
                                await (
                                  webapp_client.conat_client.hub.system as any
                                ).setOpenAiApiKey({
                                  project_id: selectedProjectId,
                                  api_key: key,
                                });
                                setProjectApiKey("");
                                refreshAfterPaymentSourceChange();
                              } catch (err) {
                                setError(`${err}`);
                              } finally {
                                setSavingScope("");
                              }
                            }}
                          >
                            Save project key
                          </Button>
                          <Popconfirm
                            title="Delete project API key?"
                            okText="Delete"
                            okButtonProps={{ danger: true }}
                            onConfirm={async () => {
                              if (!selectedProjectId.trim()) return;
                              setDeletingScope("project");
                              setError("");
                              try {
                                await (
                                  webapp_client.conat_client.hub.system as any
                                ).deleteOpenAiApiKey({
                                  project_id: selectedProjectId,
                                });
                                refreshAfterPaymentSourceChange();
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
                              disabled={
                                !selectedProjectId.trim() ||
                                !apiKeyStatus?.project
                              }
                            >
                              Delete project key
                            </Button>
                          </Popconfirm>
                        </Space>
                      </div>
                    </Space>
                  ),
                },
              ]),
          ...(lite
            ? []
            : [
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
                      locale={{
                        emptyText: "No saved subscription credentials.",
                      }}
                    />
                  ),
                },
              ]),
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
