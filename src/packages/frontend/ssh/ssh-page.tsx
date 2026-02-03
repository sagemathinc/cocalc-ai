import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Space,
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

function formatEndpoint(
  row: ReflectSessionRow,
  side: "alpha" | "beta",
): string {
  const host = side === "alpha" ? row.alpha_host : row.beta_host;
  const port = side === "alpha" ? row.alpha_port : row.beta_port;
  const root = side === "alpha" ? row.alpha_root : row.beta_root;
  if (host) {
    return `${host}${port ? `:${port}` : ""}:${root}`;
  }
  return root;
}

export const SshPage: React.FC = React.memo(() => {
  const sshRemoteTarget = useTypedRedux("customize", "ssh_remote_target");
  const [rows, setRows] = useState<SshSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [reflectSessions, setReflectSessions] = useState<ReflectSessionRow[]>(
    [],
  );
  const [reflectForwards, setReflectForwards] = useState<ReflectForwardRow[]>(
    [],
  );
  const [reflectLoading, setReflectLoading] = useState(false);
  const [reflectError, setReflectError] = useState<string | null>(null);
  const [reflectModalOpen, setReflectModalOpen] = useState(false);
  const [reflectForm] = Form.useForm();

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

  const loadReflect = async () => {
    setReflectLoading(true);
    setReflectError(null);
    try {
      const [sessions, forwards] = await Promise.all([
        webapp_client.conat_client.hub.reflect.listSessionsUI({}),
        webapp_client.conat_client.hub.reflect.listForwardsUI(),
      ]);
      setReflectSessions(sessions || []);
      setReflectForwards(forwards || []);
    } catch (err: any) {
      setReflectError(err?.message || String(err));
    } finally {
      setReflectLoading(false);
    }
  };

  const handleCreateReflect = async () => {
    try {
      const values = await reflectForm.validateFields();
      setReflectLoading(true);
      await webapp_client.conat_client.hub.reflect.createSessionUI({
        alpha: values.alpha,
        beta: values.beta,
        name: values.name || undefined,
      });
      setReflectModalOpen(false);
      reflectForm.resetFields();
      await loadReflect();
      alert_message({ type: "success", message: "Reflect sync session created" });
    } catch (err: any) {
      if (err?.errorFields) {
        return;
      }
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setReflectLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
    loadReflect();
  }, []);

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
            <Button
              size="small"
              danger
              onClick={() => handleStop(row.target)}
            >
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
        title: "ID",
        dataIndex: "id",
        key: "id",
        width: 80,
      },
      {
        title: "Name",
        dataIndex: "name",
        key: "name",
        width: 160,
        render: (val) => val || "-",
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
        title: "Alpha",
        key: "alpha",
        render: (_, row) => (
          <Typography.Text code>{formatEndpoint(row, "alpha")}</Typography.Text>
        ),
      },
      {
        title: "Beta",
        key: "beta",
        render: (_, row) => (
          <Typography.Text code>{formatEndpoint(row, "beta")}</Typography.Text>
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
    ],
    [],
  );

  const reflectForwardColumns = useMemo<ColumnsType<ReflectForwardRow>>(
    () => [
      {
        title: "ID",
        dataIndex: "id",
        key: "id",
        width: 80,
      },
      {
        title: "Name",
        dataIndex: "name",
        key: "name",
        width: 160,
        render: (val) => val || "-",
      },
      {
        title: "Direction",
        dataIndex: "direction",
        key: "direction",
        width: 140,
      },
      {
        title: "Local",
        key: "local",
        render: (_, row) => `${row.local_host}:${row.local_port}`,
      },
      {
        title: "Remote",
        key: "remote",
        render: (_, row) => `${row.remote_host}:${row.remote_port}`,
      },
      {
        title: "State",
        key: "state",
        width: 140,
        render: (_, row) => reflectStateTag(row.actual_state),
      },
    ],
    [],
  );

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
      />
      <Divider />
      <Space style={TITLE_STYLE} size={12} align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Reflect Sync (beta)
        </Typography.Title>
        <Button size="small" onClick={loadReflect} loading={reflectLoading}>
          Refresh
        </Button>
        <Button size="small" onClick={() => setReflectModalOpen(true)}>
          New Session
        </Button>
      </Space>
      {reflectError ? (
        <Alert
          type="warning"
          showIcon
          message="Reflect Sync UI unavailable"
          description={reflectError}
        />
      ) : (
        <>
          <Typography.Title level={5} style={{ marginTop: 12 }}>
            Sessions
          </Typography.Title>
          <Table
            rowKey={(row) => row.id}
            columns={reflectSessionColumns}
            dataSource={reflectSessions}
            loading={reflectLoading}
            pagination={false}
            size="small"
          />
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            Forwards
          </Typography.Title>
          <Table
            rowKey={(row) => row.id}
            columns={reflectForwardColumns}
            dataSource={reflectForwards}
            loading={reflectLoading}
            pagination={false}
            size="small"
          />
        </>
      )}
      <Modal
        title="New Reflect Sync Session"
        open={reflectModalOpen}
        onOk={handleCreateReflect}
        onCancel={() => setReflectModalOpen(false)}
        okText="Create"
        confirmLoading={reflectLoading}
      >
        <Form form={reflectForm} layout="vertical">
          <Form.Item
            label="Local path"
            name="alpha"
            rules={[{ required: true, message: "Enter a local path" }]}
          >
            <Input placeholder="/home/user/project" />
          </Form.Item>
          <Form.Item
            label="Remote path"
            name="beta"
            rules={[{ required: true, message: "Enter a remote path" }]}
          >
            <Input placeholder="user@host:/home/user/project" />
          </Form.Item>
          <Form.Item label="Name (optional)" name="name">
            <Input placeholder="my-sync" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
});
