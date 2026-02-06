import { Alert, Button, Divider, Modal, Space, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";

type ConnectorInfo = {
  id: string;
  name?: string;
  last_seen?: string;
  version?: string;
};

type SelfHostSetupModalProps = {
  open: boolean;
  host?: Host;
  connector?: ConnectorInfo;
  baseUrl: string;
  token?: string;
  expires?: string;
  launchpad?: {
    http_port?: number;
    sshd_port?: number;
    ssh_user?: string;
    ssh_host?: string;
  };
  connectorVersion?: string;
  installing?: boolean;
  loading: boolean;
  error?: string;
  notice?: string;
  onCancel: () => void;
  onRefresh: () => void;
  onInstall?: () => void;
};

export const SelfHostSetupModal: React.FC<SelfHostSetupModalProps> = ({
  open,
  host,
  connector,
  baseUrl,
  token,
  expires,
  launchpad,
  connectorVersion,
  installing,
  loading,
  error,
  notice,
  onCancel,
  onRefresh,
  onInstall,
}) => {
  const connectorId = connector?.id ?? host?.region ?? "n/a";
  const connectorName = connector?.name ? `${connector.name} (${connectorId})` : connectorId;
  const lastSeen = connector?.last_seen
    ? new Date(connector.last_seen).toLocaleString()
    : undefined;
  const base = baseUrl || "<base-url>";
  const safeName =
    connector?.name?.trim() ||
    host?.name?.trim() ||
    `connector-${connectorId}`;
  const quoteShell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const selfHostMode =
    (host?.machine?.metadata?.self_host_mode as string | undefined) ??
    (host?.machine?.cloud === "self-host" ? "local" : undefined);
  const selfHostKind =
    (host?.machine?.metadata?.self_host_kind as string | undefined) ??
    "direct";
  const isDirect = selfHostKind === "direct";
  const useSshPairing = selfHostMode === "local";
  const parsedBase = (() => {
    try {
      return new URL(base);
    } catch {
      return undefined;
    }
  })();
  const rawSshTarget =
    typeof host?.machine?.metadata?.self_host_ssh_target === "string"
      ? host.machine.metadata.self_host_ssh_target
      : "";
  const parseSshTarget = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    let user: string | undefined;
    let hostPort = trimmed;
    const atIndex = trimmed.lastIndexOf("@");
    if (atIndex > 0) {
      user = trimmed.slice(0, atIndex);
      hostPort = trimmed.slice(atIndex + 1);
    }
    let host = hostPort;
    let port: number | undefined;
    const match = hostPort.match(/^(.*):(\d+)$/);
    if (match) {
      host = match[1];
      port = Number(match[2]);
    }
    return { user, host, port };
  };
  const sshTarget = parseSshTarget(rawSshTarget);
  const hasSshTarget = !!rawSshTarget.trim();
  const sshHost =
    sshTarget?.host ??
    launchpad?.ssh_host ??
    parsedBase?.hostname ??
    "<ssh-host>";
  const sshPortValue =
    sshTarget?.port ??
    (hasSshTarget ? undefined : launchpad?.sshd_port ?? undefined);
  const sshUserValue =
    sshTarget?.user ??
    (hasSshTarget ? undefined : launchpad?.ssh_user ?? undefined);
  const sshPort =
    sshPortValue != null ? ` --ssh-port ${sshPortValue}` : "";
  const sshUser = sshUserValue ? ` --ssh-user ${sshUserValue}` : "";
  const sshNoStrict = " --ssh-no-strict-host-key-checking";
  const versionFlag = connectorVersion
    ? ` --version ${connectorVersion}`
    : "";
  const installCommand = token
    ? useSshPairing
      ? `curl -fsSL https://software.cocalc.ai/software/self-host/install.sh | \\\n  bash -s -- --ssh-host ${sshHost}${sshPort}${sshUser} --token ${token} --name ${quoteShell(safeName)}${sshNoStrict}${versionFlag}`
      : `curl -fsSL https://software.cocalc.ai/software/self-host/install.sh | \\\n  bash -s -- --base-url ${base} --token ${token} --name ${quoteShell(safeName)}${versionFlag}`
    : undefined;
  const [showCommand, setShowCommand] = React.useState(false);

  React.useEffect(() => {
    if (!open || !expires) return;
    const ts = Date.parse(expires);
    if (!Number.isFinite(ts)) return;
    const delayMs = Math.max(ts - Date.now() - 1000, 0);
    const timer = window.setTimeout(() => {
      onRefresh();
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [open, expires, onRefresh]);

  return (
    <Modal
      open={open}
      title="Set up your self-hosted connector"
      onCancel={onCancel}
      width={650}
      footer={[
        <Button key="close" type="primary" onClick={onCancel}>
          Done
        </Button>,
      ]}
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {isDirect ? (
          <Typography.Paragraph>
            This connector installs the project host directly on this machine
            (no VM required).
          </Typography.Paragraph>
        ) : (
          <Typography.Paragraph>
            This connector manages a dedicated VM on your machine using
            Multipass (free, open-source, and easy to install).
          </Typography.Paragraph>
        )}
        {isDirect ? (
          <Alert
            type="warning"
            showIcon
            title="Direct install requires Ubuntu 24.x or newer"
            description="This host must be running Ubuntu Linux 24.x (or newer). Other Linux distributions are not supported yet."
          />
        ) : (
          <Typography.Paragraph type="secondary">
            Supported on macOS and Linux only (Windows support is planned).
          </Typography.Paragraph>
        )}
        <Typography.Paragraph>
          Connector ID: <Typography.Text code>{connectorName}</Typography.Text>
        </Typography.Paragraph>
        {connector?.version && (
          <Typography.Paragraph type="secondary">
            Connector version: {connector.version}
          </Typography.Paragraph>
        )}
        {lastSeen && (
          <Typography.Paragraph type="secondary">
            Last seen: {lastSeen}
          </Typography.Paragraph>
        )}
        <Divider style={{ margin: "8px 0" }} />
        {!isDirect && (
          <Typography.Paragraph>
            1) Install Multipass:{" "}
            <Typography.Link
              href="https://canonical.com/multipass"
              target="_blank"
              rel="noreferrer"
            >
              https://canonical.com/multipass
            </Typography.Link>
          </Typography.Paragraph>
        )}
        <Typography.Paragraph>
          {isDirect ? "1" : "2"}){" "}
          {useSshPairing && onInstall && hasSshTarget
            ? "Upgrade connector automatically:"
            : "Copy/paste this command:"}
        </Typography.Paragraph>
        {useSshPairing && !hasSshTarget && (
          <Alert
            type="warning"
            showIcon
            title="No SSH target provided"
            description="Without an SSH target, the host must be able to reach the hub’s SSH port directly."
          />
        )}
        {loading && (
          <Typography.Text type="secondary">
            Creating pairing token…
          </Typography.Text>
        )}
        {error && (
          <Alert
            type="error"
            title={error}
            showIcon
            action={
              <Button size="small" onClick={onRefresh} disabled={loading}>
                Regenerate token
              </Button>
            }
          />
        )}
        {notice && (
          <Alert type="success" showIcon title={notice} />
        )}
        {installCommand && useSshPairing && onInstall && hasSshTarget ? (
          <>
            <Button
              type="primary"
              onClick={onInstall}
              disabled={loading || installing}
              loading={installing}
            >
              Upgrade connector
            </Button>
            <Button type="link" onClick={() => setShowCommand((v) => !v)}>
              {showCommand ? "Hide install command" : "Show install command"}
            </Button>
            {showCommand && (
              <>
                <Typography.Paragraph copyable={{ text: installCommand }}>
                  <pre
                    style={{
                      margin: 0,
                      padding: "10px 12px",
                      background: "#f5f5f5",
                      border: "1px solid #e6e6e6",
                      borderRadius: 6,
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                    }}
                  >
                    {installCommand}
                  </pre>
                </Typography.Paragraph>
                {expires && (
                  <Typography.Paragraph type="secondary">
                    Token expires: {new Date(expires).toLocaleString()}
                  </Typography.Paragraph>
                )}
                <Typography.Paragraph type="secondary">
                  Logs:
                  <br />
                  Linux:{" "}
                  <Typography.Text code>
                    journalctl --user -u cocalc-self-host-connector.service -f
                  </Typography.Text>
                  <br />
                  macOS:{" "}
                  <Typography.Text code>
                    ~/Library/Logs/cocalc-self-host-connector.log
                  </Typography.Text>
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary">
                  Manual start/stop (if needed):{" "}
                  <Typography.Text code>
                    cocalc-self-host-connector run --daemon
                  </Typography.Text>
                  {" / "}
                  <Typography.Text code>
                    cocalc-self-host-connector stop
                  </Typography.Text>
                </Typography.Paragraph>
              </>
            )}
          </>
        ) : (
          installCommand && (
            <>
              <Typography.Paragraph copyable={{ text: installCommand }}>
                <pre
                  style={{
                    margin: 0,
                    padding: "10px 12px",
                    background: "#f5f5f5",
                    border: "1px solid #e6e6e6",
                    borderRadius: 6,
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                  }}
                >
                  {installCommand}
                </pre>
              </Typography.Paragraph>
              {expires && (
                <Typography.Paragraph type="secondary">
                  Token expires: {new Date(expires).toLocaleString()}
                </Typography.Paragraph>
              )}
              <Typography.Paragraph type="secondary">
                Logs:
                <br />
                Linux:{" "}
                <Typography.Text code>
                  journalctl --user -u cocalc-self-host-connector.service -f
                </Typography.Text>
                <br />
                macOS:{" "}
                <Typography.Text code>
                  ~/Library/Logs/cocalc-self-host-connector.log
                </Typography.Text>
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary">
                Manual start/stop (if needed):{" "}
                <Typography.Text code>
                  cocalc-self-host-connector run --daemon
                </Typography.Text>
                {" / "}
                <Typography.Text code>
                  cocalc-self-host-connector stop
                </Typography.Text>
              </Typography.Paragraph>
            </>
          )
        )}
        {!loading && !error && !installCommand && (
          <Button onClick={onRefresh}>Regenerate token</Button>
        )}
        {installCommand && (
          <Button onClick={onRefresh} disabled={loading}>
            Regenerate token
          </Button>
        )}
        <Typography.Paragraph type="secondary">
          The connector will start immediately and your host will auto-start once it connects.
          Run only one connector per computer.
        </Typography.Paragraph>
      </Space>
    </Modal>
  );
};
