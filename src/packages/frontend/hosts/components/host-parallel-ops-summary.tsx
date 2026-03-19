import {
  Alert,
  Button,
  Card,
  InputNumber,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { SyncOutlined } from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import type {
  ParallelOpsWorkerBreakdownStatus,
  ParallelOpsWorkerStatus,
} from "@cocalc/conat/hub/api/system";

type ParallelOpsLimitScopeType = "global" | "provider" | "project_host";

function labelForWorker(worker_kind: string): string {
  switch (worker_kind) {
    case "project-move":
      return "Project move";
    case "project-restore":
      return "Project restore";
    case "project-hard-delete":
      return "Project hard delete";
    case "copy-path-between-projects":
      return "Project copy";
    case "project-backup":
      return "Project backup";
    case "host-ops":
      return "Host ops";
    case "cloud-vm-work":
      return "Cloud VM work";
    default:
      return worker_kind;
  }
}

function formatAge(ms: number | null): string {
  if (!(ms && ms > 0)) return "n/a";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.round(sec / 60)}m`;
}

function scopeKey(
  worker_kind: string,
  scope_type: ParallelOpsLimitScopeType,
  scope_id?: string,
) {
  return `${worker_kind}:${scope_type}:${scope_id ?? ""}`;
}

type LimitControlProps = {
  worker_kind: string;
  scope_type: ParallelOpsLimitScopeType;
  scope_id?: string;
  effective_limit: number | null | undefined;
  savingKey?: string;
  onSetLimit: (opts: {
    worker_kind: string;
    scope_type?: ParallelOpsLimitScopeType;
    scope_id?: string;
    limit_value: number;
  }) => void | Promise<void>;
  onClearLimit: (opts: {
    worker_kind: string;
    scope_type?: ParallelOpsLimitScopeType;
    scope_id?: string;
  }) => void | Promise<void>;
};

function LimitControl(props: LimitControlProps) {
  const {
    worker_kind,
    scope_type,
    scope_id,
    effective_limit,
    savingKey,
    onSetLimit,
    onClearLimit,
  } = props;
  const [value, setValue] = React.useState<number | null>(
    effective_limit ?? null,
  );

  React.useEffect(() => {
    setValue(effective_limit ?? null);
  }, [effective_limit, worker_kind, scope_type, scope_id]);

  const saving = savingKey === scopeKey(worker_kind, scope_type, scope_id);

  return (
    <Space.Compact size="small">
      <InputNumber
        min={1}
        value={value ?? undefined}
        onChange={(next) => setValue(typeof next === "number" ? next : null)}
        style={{ width: 88 }}
        disabled={saving}
      />
      <Button
        size="small"
        loading={saving}
        disabled={!value || value < 1}
        onClick={() =>
          value &&
          onSetLimit({
            worker_kind,
            scope_type,
            scope_id,
            limit_value: value,
          })
        }
      >
        Set
      </Button>
      <Button
        size="small"
        disabled={saving}
        onClick={() => onClearLimit({ worker_kind, scope_type, scope_id })}
      >
        Clear
      </Button>
    </Space.Compact>
  );
}

type Props = {
  status: ParallelOpsWorkerStatus[];
  loading?: boolean;
  error?: string;
  savingKey?: string;
  onRefresh: () => void | Promise<void>;
  onSetLimit: LimitControlProps["onSetLimit"];
  onClearLimit: LimitControlProps["onClearLimit"];
};

export function HostParallelOpsSummary(props: Props) {
  const {
    status,
    loading,
    error,
    savingKey,
    onRefresh,
    onSetLimit,
    onClearLimit,
  } = props;

  const workers = status.filter(
    (entry) => entry.scope_model !== "per-project-host",
  );
  const cloudWork = workers.find(
    (entry) => entry.worker_kind === "cloud-vm-work",
  );
  const mainWorkers = workers.filter(
    (entry) => entry.worker_kind !== "cloud-vm-work",
  );

  const workerRows = mainWorkers.map((entry) => ({
    key: entry.worker_kind,
    worker: labelForWorker(entry.worker_kind),
    running: entry.running_count,
    queued: entry.queued_count,
    limit: entry.effective_limit,
    oldestQueued: formatAge(entry.oldest_queued_ms),
    notes: entry.notes,
    entry,
  }));

  const providerRows =
    cloudWork?.breakdown.map((row: ParallelOpsWorkerBreakdownStatus) => ({
      key: row.key,
      provider: row.key,
      running: row.running_count,
      queued: row.queued_count,
      limit: row.limit ?? cloudWork.effective_limit,
    })) ?? [];

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space>
          <Typography.Text strong>Parallel ops</Typography.Text>
          <Typography.Text type="secondary">
            live hub activity and limits
          </Typography.Text>
        </Space>
      }
      extra={
        <Button
          size="small"
          icon={<SyncOutlined spin={!!loading} />}
          onClick={() => void onRefresh()}
        >
          Refresh
        </Button>
      }
    >
      {error && (
        <Alert
          type="warning"
          showIcon
          message="Unable to load parallel ops status"
          description={error}
          style={{ marginBottom: 12 }}
        />
      )}
      {loading && status.length === 0 ? (
        <div style={{ padding: "12px 0", textAlign: "center" }}>
          <Spin />
        </div>
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Table
            size="small"
            pagination={false}
            rowKey="key"
            dataSource={workerRows}
            columns={[
              {
                title: "Worker",
                dataIndex: "worker",
                key: "worker",
                render: (_value, record) => (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>{record.worker}</Typography.Text>
                    {record.notes?.length ? (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {record.notes[0]}
                      </Typography.Text>
                    ) : null}
                  </Space>
                ),
              },
              {
                title: "Running",
                dataIndex: "running",
                key: "running",
                width: 90,
              },
              {
                title: "Queued",
                dataIndex: "queued",
                key: "queued",
                width: 90,
              },
              { title: "Limit", dataIndex: "limit", key: "limit", width: 90 },
              {
                title: "Oldest queued",
                dataIndex: "oldestQueued",
                key: "oldestQueued",
                width: 110,
              },
              {
                title: "Adjust",
                key: "adjust",
                render: (_value, record) =>
                  record.entry.dynamic_limit_supported &&
                  record.entry.scope_model === "global" ? (
                    <LimitControl
                      worker_kind={record.entry.worker_kind}
                      scope_type="global"
                      effective_limit={record.entry.effective_limit}
                      savingKey={savingKey}
                      onSetLimit={onSetLimit}
                      onClearLimit={onClearLimit}
                    />
                  ) : null,
              },
            ]}
          />
          {cloudWork && (
            <Card size="small" title="Cloud VM work by provider">
              <Table
                size="small"
                pagination={false}
                rowKey="key"
                dataSource={providerRows}
                columns={[
                  { title: "Provider", dataIndex: "provider", key: "provider" },
                  {
                    title: "Running",
                    dataIndex: "running",
                    key: "running",
                    width: 90,
                  },
                  {
                    title: "Queued",
                    dataIndex: "queued",
                    key: "queued",
                    width: 90,
                  },
                  {
                    title: "Limit",
                    dataIndex: "limit",
                    key: "limit",
                    width: 90,
                  },
                  {
                    title: "Adjust",
                    key: "adjust",
                    render: (_value, record) => (
                      <LimitControl
                        worker_kind="cloud-vm-work"
                        scope_type="provider"
                        scope_id={record.provider}
                        effective_limit={record.limit}
                        savingKey={savingKey}
                        onSetLimit={onSetLimit}
                        onClearLimit={onClearLimit}
                      />
                    ),
                  },
                ]}
              />
              <div style={{ marginTop: 8 }}>
                <Tooltip title="Global cloud VM work cap across all providers on this hub worker.">
                  <Tag color="blue">
                    Global limit: {cloudWork.effective_limit ?? "n/a"}
                  </Tag>
                </Tooltip>
                <LimitControl
                  worker_kind="cloud-vm-work"
                  scope_type="global"
                  effective_limit={cloudWork.effective_limit}
                  savingKey={savingKey}
                  onSetLimit={onSetLimit}
                  onClearLimit={onClearLimit}
                />
              </div>
            </Card>
          )}
        </Space>
      )}
    </Card>
  );
}
