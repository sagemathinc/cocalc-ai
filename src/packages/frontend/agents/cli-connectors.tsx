/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// GitHub and Cloudflare connectors: an agent runs gh, git and cf as the user
// during its turns. Connections (who it signs in as) belong to the account;
// each agent has the connector on or off and uses one connection.

import { DeleteOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  Tag,
  Modal,
  Radio,
  Space,
  Spin,
  Switch,
  Table,
  Typography,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type {
  CliConnection,
  CliConnectorGrant,
  CliConnectorSetup,
  CliConnectorSignIn,
} from "@cocalc/conat/hub/api/agent";
import {
  CLI_CONNECTOR_INFO,
  CLOUDFLARE_SCOPE_PRESETS,
  type CliConnector,
  type CloudflareScopePreset,
} from "@cocalc/util/ai/cli-connectors";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { Tooltip } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi, useNamedAgents } from "./api";

export interface CliConnectorData {
  connections: CliConnection[];
  grants: CliConnectorGrant[];
  setup: CliConnectorSetup;
}

// One shared load for the settings page and every message box.
let request: Promise<CliConnectorData> | undefined;
const listeners = new Set<() => void>();

export function refreshCliConnectors(): void {
  request = undefined;
  for (const listener of listeners) listener();
}

function loadCliConnectors(): Promise<CliConnectorData> {
  if (request == null) {
    const api = personalAgentApi();
    const pending = Promise.all([
      api.listCliConnections(),
      api.listCliConnectorGrants(),
      api.getCliConnectorSetup(),
    ]).then(([connections, grants, setup]) => ({ connections, grants, setup }));
    request = pending;
    // A failed load is retried on the next use.
    pending.catch(() => {
      if (request === pending) request = undefined;
    });
  }
  return request;
}

export function useCliConnectors(): {
  data?: CliConnectorData;
  error?: string;
} {
  const [state, setState] = useState<{
    data?: CliConnectorData;
    error?: string;
  }>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadCliConnectors().then(
      (data) => {
        if (!cancelled) setState({ data });
      },
      (err) => {
        if (!cancelled) setState({ error: `${err}` });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);
  return state;
}

export function agentGrant(
  data: CliConnectorData | undefined,
  agent: NamedAgent,
  connector: CliConnector,
): CliConnectorGrant | undefined {
  return data?.grants.find(
    (grant) =>
      grant.connector === connector &&
      grant.agent_id === agent.endpoint.agent_id &&
      grant.source_project_id === agent.endpoint.project_id,
  );
}

/** What the connector does for the agent, in a few words. */
export function cliConnectorSummary(
  data: CliConnectorData | undefined,
  agent: NamedAgent,
  connector: CliConnector,
): string {
  const grant = agentGrant(data, agent, connector);
  if (!grant?.enabled) return "Off";
  const connection = data?.connections.find(
    ({ connection_id }) => connection_id === grant.connection_id,
  );
  return connection?.description || "On";
}

type SignInState =
  | { step: "choose" }
  | { step: "starting" }
  | { step: "waiting"; signIn: CliConnectorSignIn }
  | { step: "ended"; message: string };

/**
 * Sign in to a connector's provider: the user approves a code on the
 * provider's site while this dialog waits. Only expiring tokens result.
 */
export function ConnectCliSignInModal({
  connector,
  open,
  onClose,
  onConnected,
}: {
  connector: CliConnector;
  open: boolean;
  onClose: () => void;
  onConnected?: (connection: CliConnection) => void;
}) {
  const { label } = CLI_CONNECTOR_INFO[connector];
  const { data } = useCliConnectors();
  const appUrl =
    connector === "github" ? data?.setup.github.app_url : undefined;
  // Cloudflare asks first what agents may do there; GitHub's permissions are
  // those of the site's GitHub App.
  const choosePresets = connector === "cloudflare";
  const [presets, setPresets] = useState<CloudflareScopePreset[]>(["workers"]);
  const [state, setState] = useState<SignInState>({ step: "starting" });
  // 0 until the sign-in starts; each "Try again" starts it once more.
  const [attempt, setAttempt] = useState(0);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  useEffect(() => {
    if (!open) {
      setAttempt(0);
      return;
    }
    if (choosePresets && attempt === 0) {
      setState({ step: "choose" });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (signIn: CliConnectorSignIn, interval: number) => {
      timer = setTimeout(async () => {
        if (cancelled) return;
        try {
          const result = await personalAgentApi().pollCliConnectorSignIn({
            connector,
            login_id: signIn.login_id,
          });
          if (cancelled) return;
          if (result.status === "pending") {
            poll(signIn, interval + (result.slow_down ? 5 : 0));
          } else if (result.status === "connected") {
            refreshCliConnectors();
            onConnected?.(result.connection);
            onClose();
          } else {
            setState({
              step: "ended",
              message:
                result.status === "denied"
                  ? `The sign-in was declined on ${label}.`
                  : "The code expired before it was approved.",
            });
          }
        } catch (err) {
          if (!cancelled) setState({ step: "ended", message: `${err}` });
        }
      }, interval * 1000);
    };
    setState({ step: "starting" });
    void (async () => {
      try {
        let signIn: CliConnectorSignIn | undefined;
        const completed = await runFreshAuthAction(async () => {
          signIn = await personalAgentApi().startCliConnectorSignIn({
            connector,
            ...(choosePresets ? { presets } : {}),
          });
        });
        if (cancelled) return;
        if (!completed || !signIn) {
          onClose();
          return;
        }
        setState({ step: "waiting", signIn });
        poll(signIn, signIn.interval);
      } catch (err) {
        if (!cancelled) setState({ step: "ended", message: `${err}` });
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Restart only when opened again or on "Try again".
  }, [open, attempt]);
  return (
    <>
      <Modal
        open={open}
        title={`Connect ${label}`}
        footer={
          state.step === "choose" ? (
            <Space>
              <Button onClick={onClose}>Cancel</Button>
              <Button
                type="primary"
                disabled={presets.length === 0}
                onClick={() => setAttempt((n) => n + 1)}
              >
                Continue
              </Button>
            </Space>
          ) : state.step === "ended" ? (
            <Space>
              <Button onClick={onClose}>Close</Button>
              <Button type="primary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </Space>
          ) : (
            <Button onClick={onClose}>Cancel</Button>
          )
        }
        onCancel={onClose}
        destroyOnHidden
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        {state.step === "choose" && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Paragraph>
              What may your agents do on Cloudflare? They get only these
              permissions; connect again later to change them.
            </Typography.Paragraph>
            <Checkbox.Group
              aria-label="Cloudflare permissions"
              value={presets}
              onChange={(value) => setPresets(value as CloudflareScopePreset[])}
            >
              <Space direction="vertical">
                {(
                  Object.keys(
                    CLOUDFLARE_SCOPE_PRESETS,
                  ) as CloudflareScopePreset[]
                ).map((preset) => (
                  <Checkbox key={preset} value={preset}>
                    {CLOUDFLARE_SCOPE_PRESETS[preset].label}
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Space>
        )}
        {state.step === "starting" && (
          <Spin aria-label={`Starting ${label} sign-in`} />
        )}
        {state.step === "waiting" && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Paragraph>
              Enter this code on {label} to let your agents use it as you:
            </Typography.Paragraph>
            <Typography.Text
              copyable
              code
              aria-label={`${label} sign-in code`}
              style={{ fontSize: "1.6em", letterSpacing: "0.1em" }}
            >
              {state.signIn.user_code}
            </Typography.Text>
            <Button
              type="primary"
              href={state.signIn.verification_uri}
              target="_blank"
              rel="noreferrer"
            >
              Open {label}
            </Button>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <Spin size="small" /> Waiting for you to approve it&hellip;
            </Typography.Paragraph>
            {appUrl && (
              <Typography.Paragraph
                type="secondary"
                style={{ marginBottom: 0 }}
              >
                Agents can use only the repositories where you installed this
                site&apos;s GitHub App:{" "}
                <a href={appUrl} target="_blank" rel="noreferrer">
                  choose repositories
                </a>
                .
              </Typography.Paragraph>
            )}
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              CoCalc keeps the sign-in on its servers and gives agents you turn{" "}
              {label} on for a short-lived token, only during their turns.
            </Typography.Paragraph>
          </Space>
        )}
        {state.step === "ended" && (
          <Alert role="alert" type="error" showIcon title={state.message} />
        )}
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

/** Turn a connector on or off for one agent and pick its connection. */
export function CliConnectorAgentModal({
  agent,
  connector,
  open,
  onClose,
}: {
  agent: NamedAgent;
  connector: CliConnector;
  open: boolean;
  onClose: () => void;
}) {
  const { label, command } = CLI_CONNECTOR_INFO[connector];
  const { data, error: loadError } = useCliConnectors();
  const grant = agentGrant(data, agent, connector);
  const connections = (data?.connections ?? []).filter(
    (connection) => connection.connector === connector,
  );
  const available = data?.setup[connector].available === true;
  const [enabled, setEnabled] = useState(false);
  const [connectionId, setConnectionId] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  useEffect(() => {
    if (!open || data == null) return;
    setEnabled(grant?.enabled ?? false);
    setConnectionId(
      grant?.connection_id ?? connections[0]?.connection_id ?? undefined,
    );
    setError("");
    // Reset only when the dialog opens or the saved settings change.
  }, [open, data == null, grant?.revision, grant?.grant_id]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        await personalAgentApi().saveCliConnectorGrant({
          agent_id: agent.endpoint.agent_id,
          source_project_id: agent.endpoint.project_id,
          connector,
          connection_id: enabled ? connectionId : grant?.connection_id,
          enabled,
          expected_revision: grant?.revision,
        });
      });
      if (completed) {
        refreshCliConnectors();
        onClose();
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  };
  const unchanged =
    (grant?.enabled ?? false) === enabled &&
    (!enabled || grant?.connection_id === connectionId);
  return (
    <>
      <Modal
        open={open}
        title={`${label} for @${agent.name}`}
        okText="Save"
        okButtonProps={{
          disabled: unchanged || (enabled && !connectionId),
          loading: busy,
        }}
        onOk={() => void save()}
        onCancel={onClose}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        {loadError ? (
          <Alert
            type="error"
            title={`Unable to load ${label} connections`}
            description={loadError}
            action={<Button onClick={refreshCliConnectors}>Retry</Button>}
          />
        ) : data == null ? (
          <Spin aria-label={`Loading ${label} connections`} />
        ) : (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Paragraph>
              When on, <code>{command}</code>
              {connector === "github" ? (
                <>
                  {" "}
                  and <code>git</code> (over https://github.com)
                </>
              ) : (
                <>
                  {" "}
                  and <code>wrangler</code>
                </>
              )}{" "}
              act as you during this agent&apos;s turns. Anything else running
              in the project during a turn can use the same access.
            </Typography.Paragraph>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Switch
                checked={enabled}
                aria-label={`Use ${label}`}
                onChange={setEnabled}
              />
              Use {label}
            </label>
            {enabled &&
              (connections.length === 0 ? (
                <Typography.Paragraph type="secondary">
                  {available
                    ? `Connect a ${label} account first.`
                    : notSetUp(label)}
                </Typography.Paragraph>
              ) : (
                <Radio.Group
                  aria-label={`${label} connection`}
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                >
                  <Space direction="vertical">
                    {connections.map((connection) => (
                      <Radio
                        key={connection.connection_id}
                        value={connection.connection_id}
                      >
                        <ConnectionName connection={connection} />
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              ))}
            {enabled && available && (
              <Button size="small" onClick={() => setConnecting(true)}>
                Connect {connections.length > 0 ? "another" : "a"} {label}{" "}
                account
              </Button>
            )}
            {error && (
              <Alert role="alert" type="error" showIcon title={error} />
            )}
          </Space>
        )}
      </Modal>
      <ConnectCliSignInModal
        connector={connector}
        open={connecting}
        onClose={() => setConnecting(false)}
        onConnected={(connection) => setConnectionId(connection.connection_id)}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

function notSetUp(label: string): string {
  return `${label} is not set up on this site yet. A site administrator can set it up (see the admin docs).`;
}

function ConnectionName({ connection }: { connection: CliConnection }) {
  return (
    <>
      {connection.description}
      {connection.needs_reconnect && (
        <Tooltip title="The provider no longer accepts this sign-in. Connect the account again, then disconnect this one.">
          <Tag color="warning" style={{ marginLeft: 8 }}>
            Sign in again
          </Tag>
        </Tooltip>
      )}
    </>
  );
}

const SECTION_TEXT: Record<CliConnector, string> = {
  github:
    "Lets an agent use gh and git with GitHub as you during its turns: clone, push, open pull requests, review and comment.",
  cloudflare:
    "Lets an agent use cf and wrangler with your Cloudflare account during its turns: deploy Workers and Pages, manage R2, KV and DNS.",
};

type AgentRow = {
  key: string;
  agent?: NamedAgent;
  grant: CliConnectorGrant;
  connection?: CliConnection;
};

/** Settings > Connectors section for one CLI connector. */
export function CliConnectorSection({
  connector,
}: {
  connector: CliConnector;
}) {
  const { label } = CLI_CONNECTOR_INFO[connector];
  const { data, error } = useCliConnectors();
  const { directory } = useNamedAgents();
  const [connecting, setConnecting] = useState(false);
  const [managing, setManaging] = useState<NamedAgent>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState("");
  const connections = (data?.connections ?? []).filter(
    (connection) => connection.connector === connector,
  );
  const available = data?.setup[connector].available === true;
  const appUrl =
    connector === "github" ? data?.setup.github.app_url : undefined;
  const rows: AgentRow[] = (data?.grants ?? [])
    .filter((grant) => grant.connector === connector && grant.enabled)
    .map((grant) => ({
      key: grant.grant_id,
      grant,
      agent: directory?.agents.find(
        ({ endpoint }) =>
          endpoint.agent_id === grant.agent_id &&
          endpoint.project_id === grant.source_project_id,
      ),
      connection: connections.find(
        ({ connection_id }) => connection_id === grant.connection_id,
      ),
    }));
  const disconnect = useCallback(
    (connection: CliConnection) => {
      const users = rows.filter(
        (row) => row.grant.connection_id === connection.connection_id,
      ).length;
      Modal.confirm({
        title: `Disconnect ${connection.description}?`,
        content:
          users > 0
            ? `${users} ${users === 1 ? "agent uses" : "agents use"} it; ${label} turns off for ${users === 1 ? "it" : "them"}. CoCalc deletes its copy of the token; revoke the token at ${label} too if you no longer need it.`
            : `CoCalc deletes its copy of the token; revoke the token at ${label} too if you no longer need it.`,
        okText: "Disconnect",
        okButtonProps: { danger: true },
        onOk: async () => {
          setBusy(connection.connection_id);
          setActionError("");
          try {
            await personalAgentApi().disconnectCliConnection({
              connection_id: connection.connection_id,
            });
            refreshCliConnectors();
          } catch (err) {
            setActionError(`${err}`);
          } finally {
            setBusy(undefined);
          }
        },
      });
    },
    [rows, label],
  );
  return (
    <Panel header={label}>
      <Typography.Paragraph type="secondary">
        {SECTION_TEXT[connector]} Turn it on for an agent from the connectors
        list (+) in that agent&apos;s message box.
      </Typography.Paragraph>
      {error ? (
        <Alert
          type="error"
          title={`Unable to load ${label}`}
          description={error}
          action={<Button onClick={refreshCliConnectors}>Retry</Button>}
        />
      ) : data == null ? (
        <Spin aria-label={`Loading ${label}`} />
      ) : (
        <>
          {actionError && (
            <Alert
              role="alert"
              type="error"
              showIcon
              title={actionError}
              style={{ marginBottom: 12 }}
            />
          )}
          {connections.length === 0 ? (
            <Typography.Paragraph>
              {available
                ? `No ${label} account is connected.`
                : notSetUp(label)}
            </Typography.Paragraph>
          ) : (
            <Table<CliConnection>
              size="small"
              pagination={false}
              rowKey="connection_id"
              dataSource={connections}
              style={{ marginBottom: 12 }}
              columns={[
                {
                  key: "account",
                  title: "Account",
                  render: (_, connection) => (
                    <ConnectionName connection={connection} />
                  ),
                },
                {
                  key: "agents",
                  title: "Agents",
                  render: (_, connection) => {
                    const names = rows
                      .filter(
                        (row) =>
                          row.grant.connection_id === connection.connection_id,
                      )
                      .map((row) =>
                        row.agent ? `@${row.agent.name}` : "another agent",
                      );
                    return names.length > 0 ? names.join(", ") : "None";
                  },
                },
                {
                  key: "disconnect",
                  title: "",
                  align: "right",
                  render: (_, connection) => (
                    <Button
                      size="small"
                      danger
                      type="text"
                      icon={<DeleteOutlined aria-hidden />}
                      aria-label={`Disconnect ${connection.description}`}
                      loading={busy === connection.connection_id}
                      disabled={busy != null}
                      onClick={() => disconnect(connection)}
                    />
                  ),
                },
              ]}
            />
          )}
          {available && (
            <Space wrap>
              <Button onClick={() => setConnecting(true)}>
                Connect {connections.length > 0 ? "another" : "a"} {label}{" "}
                account
              </Button>
              {appUrl && (
                <Button href={appUrl} target="_blank" rel="noreferrer">
                  Choose repositories
                </Button>
              )}
            </Space>
          )}
          {rows.some((row) => row.agent) && (
            <Table<AgentRow>
              size="small"
              pagination={false}
              rowKey="key"
              dataSource={rows.filter((row) => row.agent)}
              style={{ marginTop: 16 }}
              columns={[
                {
                  key: "agent",
                  title: "Agent",
                  render: (_, { agent }) => `@${agent!.name}`,
                },
                {
                  key: "project",
                  title: "Project",
                  render: (_, { agent }) => agent!.project_title ?? "",
                },
                {
                  key: "connection",
                  title: "Account",
                  render: (_, { connection }) => connection?.description ?? "",
                },
                {
                  key: "manage",
                  title: "",
                  align: "right",
                  render: (_, { agent }) => (
                    <Button
                      size="small"
                      aria-label={`Manage ${label} for @${agent!.name}`}
                      onClick={() => setManaging(agent)}
                    >
                      Manage
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      <ConnectCliSignInModal
        connector={connector}
        open={connecting}
        onClose={() => setConnecting(false)}
      />
      {managing && (
        <CliConnectorAgentModal
          agent={managing}
          connector={connector}
          open
          onClose={() => setManaging(undefined)}
        />
      )}
    </Panel>
  );
}
