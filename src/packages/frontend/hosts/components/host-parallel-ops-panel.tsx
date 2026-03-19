import { Button, Card, InputNumber, Space, Table, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { ParallelOpsWorkerStatus } from "@cocalc/conat/hub/api/system";

type ParallelOpsLimitScopeType = "global" | "provider" | "project_host";

function workerLabel(worker_kind: string): string {
  switch (worker_kind) {
    case "project-host-backup-execution":
      return "Backup execution";
    case "project-move-source-host":
      return "Move source slots";
    case "project-move-destination-host":
      return "Move destination slots";
    default:
      return worker_kind;
  }
}

function scopeKey(
  worker_kind: string,
  scope_type: ParallelOpsLimitScopeType,
  scope_id?: string,
) {
  return `${worker_kind}:${scope_type}:${scope_id ?? ""}`;
}

function HostLimitControl(props: {
  worker_kind: string;
  host_id: string;
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
}) {
  const {
    worker_kind,
    host_id,
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
  }, [effective_limit, worker_kind, host_id]);

  const saving = savingKey === scopeKey(worker_kind, "project_host", host_id);

  return (
    <Space.Compact size="small">
      <InputNumber
        min={1}
        value={value ?? undefined}
        onChange={(next) => setValue(typeof next === "number" ? next : null)}
        style={{ width: 82 }}
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
            scope_type: "project_host",
            scope_id: host_id,
            limit_value: value,
          })
        }
      >
        Set
      </Button>
      <Button
        size="small"
        disabled={saving}
        onClick={() =>
          onClearLimit({
            worker_kind,
            scope_type: "project_host",
            scope_id: host_id,
          })
        }
      >
        Clear
      </Button>
    </Space.Compact>
  );
}

type Props = {
  host_id: string;
  status: ParallelOpsWorkerStatus[];
  loading?: boolean;
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

export function HostParallelOpsPanel(props: Props) {
  const { host_id, status, loading, savingKey, onSetLimit, onClearLimit } =
    props;

  const rows = status
    .filter((entry) => entry.scope_model === "per-project-host")
    .map((entry) => {
      const breakdown = entry.breakdown.find((row) => row.key === host_id);
      if (!breakdown) return undefined;
      return {
        key: entry.worker_kind,
        worker_kind: entry.worker_kind,
        worker: workerLabel(entry.worker_kind),
        running: breakdown.running_count,
        queued: breakdown.queued_count,
        limit: breakdown.limit ?? entry.effective_limit,
      };
    })
    .filter((row): row is NonNullable<typeof row> => !!row);

  if (!loading && rows.length === 0) {
    return null;
  }

  return (
    <Card size="small" title="Parallel ops">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Host-scoped move and backup activity, plus live slot overrides for this
        host.
      </Typography.Paragraph>
      <Table
        size="small"
        pagination={false}
        rowKey="key"
        dataSource={rows}
        columns={[
          { title: "Worker", dataIndex: "worker", key: "worker" },
          { title: "Running", dataIndex: "running", key: "running", width: 90 },
          { title: "Queued", dataIndex: "queued", key: "queued", width: 90 },
          { title: "Limit", dataIndex: "limit", key: "limit", width: 90 },
          {
            title: "Adjust",
            key: "adjust",
            render: (_value, record) => (
              <HostLimitControl
                worker_kind={record.worker_kind}
                host_id={host_id}
                effective_limit={record.limit}
                savingKey={savingKey}
                onSetLimit={onSetLimit}
                onClearLimit={onClearLimit}
              />
            ),
          },
        ]}
        locale={{
          emptyText: loading ? "Loading..." : "No host-scoped activity",
        }}
      />
    </Card>
  );
}
