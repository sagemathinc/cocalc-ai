import {
  Alert,
  Button,
  Collapse,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  CSS,
  React,
  useEffect,
  useMemo,
  useState,
  redux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { SshSessionRow } from "@cocalc/conat/hub/api/ssh";
import type {
  ReflectForwardRow,
  ReflectLogRow,
  ReflectSessionLogRow,
  ReflectSessionRow,
} from "@cocalc/conat/hub/api/reflect";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { lite, project_id } from "@cocalc/frontend/lite";

const PAGE_STYLE: CSS = {
  padding: "16px",
  overflow: "auto",
} as const;

const TITLE_STYLE: CSS = {
  marginBottom: "12px",
} as const;

type ReflectTargetState = {
  sessions: ReflectSessionRow[];
  forwards: ReflectForwardRow[];
  loading: boolean;
  error: string | null;
};

function statusTag(status?: string) {
  const value = status ?? "unknown";
  if (value === "running") return <Tag color="green">running</Tag>;
  if (value === "stopped") return <Tag color="default">stopped</Tag>;
  if (value === "missing") return <Tag color="orange">missing</Tag>;
  if (value === "unreachable") return <Tag color="red">unreachable</Tag>;
  if (value === "error") return <Tag color="red">error</Tag>;
  return <Tag>{value}</Tag>;
}

function tunnelTag(active?: boolean) {
  if (active) return <Tag color="blue">active</Tag>;
  return <Tag>idle</Tag>;
}

function reflectStateTag(state?: string) {
  if (!state) return <Tag>unknown</Tag>;
  if (state === "running") return <Tag color="green">running</Tag>;
  if (state === "stopped") return <Tag color="default">stopped</Tag>;
  if (state === "error") return <Tag color="red">error</Tag>;
  return <Tag>{state}</Tag>;
}

function formatForwardDirection(direction?: string) {
  if (direction === "remote_to_local") return "remote → local";
  if (direction === "local_to_remote") return "local → remote";
  return direction ?? "unknown";
}

function formatForwardLocal(fwd: ReflectForwardRow) {
  return `${fwd.local_host}:${fwd.local_port}`;
}

function formatForwardRemote(fwd: ReflectForwardRow) {
  const host = fwd.remote_host || fwd.ssh_host || "remote";
  const endpoint = `${host}:${fwd.remote_port}`;
  if (fwd.ssh_port) {
    return `${endpoint} (ssh:${fwd.ssh_port})`;
  }
  return endpoint;
}

function parseSshTarget(target: string): { host: string; port: number | null } {
  const trimmed = target.trim();
  const match = /^(?:(?<user>[^@]+)@)?(?<host>[^:]+)(?::(?<port>\d+))?$/.exec(
    trimmed,
  );
  if (!match) {
    return { host: trimmed, port: null };
  }
  const user = match.groups?.user;
  const hostPart = match.groups?.host?.trim() ?? "";
  const port = match.groups?.port ? Number(match.groups.port) : null;
  return {
    host: user ? `${user}@${hostPart}` : hostPart,
    port: port ?? null,
  };
}

function normalizePath(input: string) {
  return input.replace(/\/+$/, "") || "/";
}

function pathsOverlap(a: string, b: string) {
  const aNorm = normalizePath(a);
  const bNorm = normalizePath(b);
  if (aNorm === bNorm) return true;
  return aNorm.startsWith(`${bNorm}/`) || bNorm.startsWith(`${aNorm}/`);
}

function extractIgnoreRules(raw?: string) {
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const SshPage: React.FC = React.memo(() => {
  const sshRemoteTarget = useTypedRedux("customize", "ssh_remote_target");
  const [rows, setRows] = useState<SshSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [reflectByTarget, setReflectByTarget] = useState<
    Record<string, ReflectTargetState>
  >({});
  const [expandedTargets, setExpandedTargets] = useState<string[]>([]);
  const [reflectModalOpen, setReflectModalOpen] = useState(false);
  const [reflectModalTarget, setReflectModalTarget] = useState<string | null>(
    null,
  );
  const [reflectForm] = Form.useForm();
  const [forwardModalOpen, setForwardModalOpen] = useState(false);
  const [forwardModalTarget, setForwardModalTarget] = useState<string | null>(
    null,
  );
  const [forwardForm] = Form.useForm();
  const [reflectLogModalOpen, setReflectLogModalOpen] = useState(false);
  const [reflectLogRows, setReflectLogRows] = useState<ReflectLogRow[]>([]);
  const [reflectLogLoading, setReflectLogLoading] = useState(false);
  const [reflectLogTitle, setReflectLogTitle] = useState<string>("Logs");
  const [reflectLogError, setReflectLogError] = useState<string | null>(null);
  const [reflectLogTarget, setReflectLogTarget] = useState<string | null>(null);

  if (sshRemoteTarget) {
    return (
      <div style={PAGE_STYLE}>
        <Space style={TITLE_STYLE} size={12} align="center">
          {lite && (
            <Button
              size="small"
              onClick={() => {
                redux.getActions("page").set_active_tab(project_id);
              }}
            >
              Back
            </Button>
          )}
          <Typography.Title level={4} style={{ margin: 0 }}>
            Remote SSH Session
          </Typography.Title>
        </Space>
        <Typography.Paragraph>
          SSH session management is disabled in this remote instance.
        </Typography.Paragraph>
        <Typography.Paragraph>
          Target:{" "}
          <Typography.Text code copyable={{ text: sshRemoteTarget }}>
            {sshRemoteTarget}
          </Typography.Text>
        </Typography.Paragraph>
      </div>
    );
  }

  const ensureReflectState = (target: string): ReflectTargetState => {
    return (
      reflectByTarget[target] || {
        sessions: [],
        forwards: [],
        loading: false,
        error: null,
      }
    );
  };

  const loadSessions = async () => {
    setLoading(true);
    try {
      const data = await webapp_client.conat_client.hub.ssh.listSessionsUI({
        withStatus: true,
      });
      setRows(data || []);
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const loadReflectForTarget = async (target: string) => {
    setReflectByTarget((prev) => ({
      ...prev,
      [target]: {
        ...ensureReflectState(target),
        loading: true,
        error: null,
      },
    }));
    try {
      const [sessions, forwards] = await Promise.all([
        webapp_client.conat_client.hub.reflect.listSessionsUI({ target }),
        webapp_client.conat_client.hub.reflect.listForwardsUI(),
      ]);
      const { host, port } = parseSshTarget(target);
      const filteredForwards = (forwards || []).filter((row) => {
        const rowPort = row.ssh_port ?? null;
        return row.ssh_host === host && rowPort === (port ?? null);
      });
      setReflectByTarget((prev) => ({
        ...prev,
        [target]: {
          sessions: sessions || [],
          forwards: filteredForwards,
          loading: false,
          error: null,
        },
      }));
    } catch (err: any) {
      setReflectByTarget((prev) => ({
        ...prev,
        [target]: {
          ...ensureReflectState(target),
          loading: false,
          error: err?.message || String(err),
        },
      }));
    }
  };

  const handleOpen = async (target: string) => {
    setLoading(true);
    try {
      const result = await webapp_client.conat_client.hub.ssh.connectSessionUI({
        target,
        options: { noOpen: true },
      });
      if (result?.url) {
        window.open(result.url, "_blank", "noopener");
      }
      await loadSessions();
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async (target: string) => {
    setLoading(true);
    try {
      await webapp_client.conat_client.hub.ssh.stopSessionUI({ target });
      await loadSessions();
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateReflect = async () => {
    if (!reflectModalTarget) return;
    try {
      const values = await reflectForm.validateFields();
      const localPath = values.localPath?.trim();
      const remotePath = values.remotePath?.trim() || undefined;
      const ignoreRules = extractIgnoreRules(values.ignoreRules);
      const prefer = values.prefer;
      await webapp_client.conat_client.hub.reflect.createSessionUI({
        target: reflectModalTarget,
        localPath,
        remotePath,
        prefer,
        useGitignore: values.useGitignore,
        ignore: ignoreRules,
      });
      setReflectModalOpen(false);
      setReflectModalTarget(null);
      reflectForm.resetFields();
      await loadReflectForTarget(reflectModalTarget);
      alert_message({ type: "success", message: "Sync session created" });
    } catch (err: any) {
      if (err?.errorFields) {
        return;
      }
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleCreateForward = async () => {
    if (!forwardModalTarget) return;
    try {
      const values = await forwardForm.validateFields();
      await webapp_client.conat_client.hub.reflect.createForwardUI({
        target: forwardModalTarget,
        localPort: Number(values.localPort),
        remotePort: values.remotePort ? Number(values.remotePort) : undefined,
        direction: values.direction,
        name: values.name || undefined,
      });
      setForwardModalOpen(false);
      setForwardModalTarget(null);
      forwardForm.resetFields();
      await loadReflectForTarget(forwardModalTarget);
      alert_message({ type: "success", message: "Port forward created" });
    } catch (err: any) {
      if (err?.errorFields) {
        return;
      }
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleTerminateForward = async (target: string, id: number) => {
    try {
      await webapp_client.conat_client.hub.reflect.terminateForwardUI({ id });
      await loadReflectForTarget(target);
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const formatReflectLogs = (rows: ReflectLogRow[]) => {
    return rows
      .map((row) => {
        const ts = new Date(row.ts).toLocaleString();
        const scope = row.scope ? ` (${row.scope})` : "";
        const meta = row.meta ? ` ${JSON.stringify(row.meta)}` : "";
        return `${ts} [${row.level}]${scope} ${row.message}${meta}`;
      })
      .join("\n");
  };

  const loadSessionLogs = async (row: ReflectSessionRow) => {
    setReflectLogTitle(`Session Logs: ${row.alpha_root}`);
    setReflectLogTarget(String(row.id));
    setReflectLogError(null);
    setReflectLogLoading(true);
    setReflectLogModalOpen(true);
    try {
      const logs = (await webapp_client.conat_client.hub.reflect.listSessionLogsUI(
        {
          idOrName: String(row.id),
          order: "desc",
          limit: 200,
        },
      )) as ReflectSessionLogRow[];
      setReflectLogRows(logs || []);
    } catch (err: any) {
      setReflectLogError(err?.message || String(err));
      setReflectLogRows([]);
    } finally {
      setReflectLogLoading(false);
    }
  };

  const loadDaemonLogs = async () => {
    setReflectLogTitle("Reflect Daemon Logs");
    setReflectLogTarget("daemon");
    setReflectLogError(null);
    setReflectLogLoading(true);
    setReflectLogModalOpen(true);
    try {
      const logs = (await webapp_client.conat_client.hub.reflect.listDaemonLogsUI(
        {
          order: "desc",
          limit: 200,
        },
      )) as ReflectLogRow[];
      setReflectLogRows(logs || []);
    } catch (err: any) {
      setReflectLogError(err?.message || String(err));
      setReflectLogRows([]);
    } finally {
      setReflectLogLoading(false);
    }
  };

  const refreshLogView = async () => {
    if (!reflectLogTarget) return;
    if (reflectLogTarget === "daemon") {
      await loadDaemonLogs();
      return;
    }
    const id = reflectLogTarget;
    const target = Object.keys(reflectByTarget).find((key) =>
      reflectByTarget[key]?.sessions.some((row) => String(row.id) === id),
    );
    if (target) {
      const row = reflectByTarget[target].sessions.find(
        (r) => String(r.id) === id,
      );
      if (row) {
        await loadSessionLogs(row);
      }
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (reflectModalOpen) {
      reflectForm.setFieldsValue({
        prefer: "alpha",
        useGitignore: true,
      });
    }
  }, [reflectModalOpen, reflectForm]);

  useEffect(() => {
    if (forwardModalOpen) {
      forwardForm.setFieldsValue({
        direction: "remote_to_local",
      });
    }
  }, [forwardModalOpen, forwardForm]);

  const columns = useMemo<ColumnsType<SshSessionRow>>(
    () => [
      {
        title: "Target",
        dataIndex: "target",
        key: "target",
      },
      {
        title: "Port",
        dataIndex: "localPort",
        key: "localPort",
        width: 110,
      },
      {
        title: "Status",
        dataIndex: "status",
        key: "status",
        width: 140,
        render: (_, row) => statusTag(row.status),
      },
      {
        title: "Tunnel",
        dataIndex: "tunnelActive",
        key: "tunnelActive",
        width: 120,
        render: (_, row) => tunnelTag(row.tunnelActive),
      },
      {
        title: "Last Used",
        dataIndex: "lastUsed",
        key: "lastUsed",
      },
      {
        title: "Actions",
        key: "actions",
        width: 200,
        render: (_, row) => (
          <Space>
            <Button size="small" onClick={() => handleOpen(row.target)}>
              Open
            </Button>
            <Button size="small" danger onClick={() => handleStop(row.target)}>
              Stop
            </Button>
          </Space>
        ),
      },
    ],
    [rows],
  );

  const reflectSessionColumns = useMemo<ColumnsType<ReflectSessionRow>>(
    () => [
      {
        title: "Local Path",
        dataIndex: "alpha_root",
        key: "alpha_root",
        render: (val) => <Typography.Text code>{val}</Typography.Text>,
      },
      {
        title: "Remote Path",
        dataIndex: "beta_root",
        key: "beta_root",
        render: (val, row) => (
          <Typography.Text code>
            {row.beta_host
              ? `${row.beta_host}${row.beta_port ? `:${row.beta_port}` : ""}:${val}`
              : val}
          </Typography.Text>
        ),
      },
      {
        title: "State",
        key: "state",
        width: 160,
        render: (_, row) => (
          <Space size={6}>
            {reflectStateTag(row.actual_state)}
            <Typography.Text type="secondary">
              {row.desired_state}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "Last Sync",
        key: "last",
        width: 180,
        render: (_, row) =>
          row.last_clean_sync_at
            ? new Date(row.last_clean_sync_at).toLocaleString()
            : "-",
      },
      {
        title: "Logs",
        key: "logs",
        width: 110,
        render: (_, row) => (
          <Button size="small" onClick={() => loadSessionLogs(row)}>
            Logs
          </Button>
        ),
      },
    ],
    [],
  );

  const expandedRowRender = (row: SshSessionRow) => {
    const state = ensureReflectState(row.target);
    const forwardColumns: ColumnsType<ReflectForwardRow> = [
      {
        title: "Direction",
        dataIndex: "direction",
        key: "direction",
        width: 160,
        render: (value) => formatForwardDirection(value),
      },
      {
        title: "Local",
        key: "local",
        render: (_, fwd) => formatForwardLocal(fwd),
      },
      {
        title: "Remote",
        key: "remote",
        render: (_, fwd) => formatForwardRemote(fwd),
      },
      {
        title: "State",
        key: "state",
        width: 140,
        render: (_, fwd) => reflectStateTag(fwd.actual_state),
      },
      {
        title: "Actions",
        key: "actions",
        width: 120,
        render: (_, fwd) => (
          <Button
            size="small"
            danger
            onClick={() => handleTerminateForward(row.target, fwd.id)}
          >
            Remove
          </Button>
        ),
      },
    ];
    return (
      <div style={{ padding: "12px 8px" }}>
        <Space style={{ marginBottom: 8 }} size={12} align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            Sync
          </Typography.Title>
          <Button
            size="small"
            onClick={() => loadReflectForTarget(row.target)}
            loading={state.loading}
          >
            Refresh
          </Button>
          <Button
            size="small"
            onClick={() => {
              setReflectModalTarget(row.target);
              setReflectModalOpen(true);
            }}
          >
            New Sync
          </Button>
          <Button size="small" onClick={loadDaemonLogs}>
            Logs
          </Button>
        </Space>
        {state.error ? (
          <Alert
            type="warning"
            showIcon
            message="Reflect Sync unavailable"
            description={state.error}
          />
        ) : (
          <Table
            rowKey={(r) => r.id}
            columns={reflectSessionColumns}
            dataSource={state.sessions}
            pagination={false}
            size="small"
          />
        )}
        <Divider style={{ margin: "16px 0" }} />
        <Space style={{ marginBottom: 8 }} size={12} align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            Port Forwards
          </Typography.Title>
          <Button
            size="small"
            onClick={() => {
              setForwardModalTarget(row.target);
              setForwardModalOpen(true);
            }}
          >
            New Forward
          </Button>
        </Space>
        <Table
          rowKey={(r) => r.id}
          columns={forwardColumns}
          dataSource={state.forwards}
          pagination={false}
          size="small"
        />
      </div>
    );
  };

  const validateLocalPath = async (_: any, value?: string) => {
    if (!value || !value.trim()) {
      throw new Error("Enter a local path");
    }
    const trimmed = value.trim();
    if (!reflectModalTarget) return;
    if (trimmed.startsWith("/")) {
      const existing = ensureReflectState(reflectModalTarget).sessions;
      for (const row of existing) {
        if (pathsOverlap(trimmed, row.alpha_root)) {
          throw new Error(
            `Local path overlaps existing sync: ${row.alpha_root}`,
          );
        }
      }
    }
  };

  return (
    <div style={PAGE_STYLE}>
      <Space style={TITLE_STYLE} size={12} align="center">
        {lite && (
          <Button
            size="small"
            onClick={() => {
              redux.getActions("page").set_active_tab(project_id);
            }}
          >
            Back
          </Button>
        )}
        <Typography.Title level={4} style={{ margin: 0 }}>
          Remote SSH Sessions
        </Typography.Title>
        <Button size="small" onClick={loadSessions} loading={loading}>
          Refresh
        </Button>
      </Space>
      <Table
        rowKey={(row) => row.target}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        size="small"
        expandable={{
          expandedRowRender,
          expandedRowKeys: expandedTargets,
          onExpand: (expanded, record) => {
            setExpandedTargets((prev) => {
              const next = expanded
                ? [...prev, record.target]
                : prev.filter((t) => t !== record.target);
              return Array.from(new Set(next));
            });
            if (expanded) {
              loadReflectForTarget(record.target);
            }
          },
        }}
      />

      <Modal
        title={
          reflectModalTarget
            ? `New Sync for ${reflectModalTarget}`
            : "New Sync"
        }
        open={reflectModalOpen}
        onOk={handleCreateReflect}
        onCancel={() => {
          setReflectModalOpen(false);
          setReflectModalTarget(null);
        }}
        okText="Create"
      >
        <Form
          form={reflectForm}
          layout="vertical"
          initialValues={{ useGitignore: true, prefer: "alpha" }}
        >
          <Form.Item
            label="Local path"
            name="localPath"
            rules={[{ validator: validateLocalPath }]}
          >
            <Input placeholder="~/project or /home/user/project" />
          </Form.Item>
          <Collapse
            size="small"
            items={[
              {
                key: "advanced",
                label: "Advanced",
                children: (
                  <>
                    <Form.Item
                      label="Remote path (defaults to local path)"
                      name="remotePath"
                    >
                      <Input placeholder="~/project" />
                    </Form.Item>
                    <Form.Item
                      label="Conflict preference"
                      name="prefer"
                    >
                      <Select
                        options={[
                          {
                            value: "alpha",
                            label: "Prefer local (alpha)",
                          },
                          {
                            value: "beta",
                            label: "Prefer remote (beta)",
                          },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      label="Use .gitignore (if present)"
                      name="useGitignore"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      label="Additional ignore patterns"
                      name="ignoreRules"
                    >
                      <Input.TextArea
                        autoSize={{ minRows: 3, maxRows: 6 }}
                        placeholder="node_modules\n*.log"
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Modal>

      <Modal
        title={
          forwardModalTarget
            ? `New Forward for ${forwardModalTarget}`
            : "New Forward"
        }
        open={forwardModalOpen}
        onOk={handleCreateForward}
        onCancel={() => {
          setForwardModalOpen(false);
          setForwardModalTarget(null);
        }}
        okText="Create"
      >
        <Form form={forwardForm} layout="vertical">
          <Form.Item
            label="Direction"
            name="direction"
            rules={[{ required: true, message: "Select a direction" }]}
          >
            <Select
              options={[
                { value: "remote_to_local", label: "remote → local" },
                { value: "local_to_remote", label: "local → remote" },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="Local port"
            name="localPort"
            rules={[{ required: true, message: "Enter a local port" }]}
          >
            <InputNumber min={1} max={65535} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="Remote port (defaults to local port)" name="remotePort">
            <InputNumber min={1} max={65535} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="Name (optional)" name="name">
            <Input placeholder="my-forward" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={reflectLogTitle}
        open={reflectLogModalOpen}
        onCancel={() => setReflectLogModalOpen(false)}
        footer={[
          <Button key="refresh" onClick={refreshLogView} loading={reflectLogLoading}>
            Refresh
          </Button>,
          <Button key="close" onClick={() => setReflectLogModalOpen(false)}>
            Close
          </Button>,
        ]}
      >
        {reflectLogError ? (
          <Alert
            type="warning"
            showIcon
            message="Unable to load logs"
            description={reflectLogError}
          />
        ) : (
          <Input.TextArea
            value={formatReflectLogs(reflectLogRows)}
            readOnly
            autoSize={{ minRows: 8, maxRows: 16 }}
            placeholder={reflectLogLoading ? "Loading logs..." : "No logs"}
          />
        )}
      </Modal>
    </div>
  );
});
