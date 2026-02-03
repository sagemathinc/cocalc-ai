import { Button, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  CSS,
  React,
  useEffect,
  useMemo,
  useState,
  redux,
} from "@cocalc/frontend/app-framework";
import type { SshSessionRow } from "@cocalc/conat/hub/api/ssh";
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

export const SshPage: React.FC = React.memo(() => {
  const [rows, setRows] = useState<SshSessionRow[]>([]);
  const [loading, setLoading] = useState(false);

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

  useEffect(() => {
    loadSessions();
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
    </div>
  );
});
