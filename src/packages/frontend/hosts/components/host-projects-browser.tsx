import { Button, Modal, Popconfirm, Select, Space, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { Host, HostProjectStateFilter } from "@cocalc/conat/hub/api/hosts";
import { HostProjectsTable } from "./host-projects-table";

const STATE_OPTIONS: Array<{
  value: HostProjectStateFilter;
  label: string;
}> = [
  { value: "running", label: "Running" },
  { value: "all", label: "All assigned" },
  { value: "stopped", label: "Stopped" },
  { value: "unprovisioned", label: "Unprovisioned" },
];

export function HostProjectsBrowser({
  host,
  open,
  onClose,
  hostOpActive = false,
  onStopRunningProjects,
  onRestartRunningProjects,
}: {
  host: Host;
  open: boolean;
  onClose: () => void;
  hostOpActive?: boolean;
  onStopRunningProjects?: (host: Host) => void | Promise<void>;
  onRestartRunningProjects?: (host: Host) => void | Promise<void>;
}) {
  const [stateFilter, setStateFilter] =
    React.useState<HostProjectStateFilter>("running");

  React.useEffect(() => {
    if (!open) {
      setStateFilter("running");
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      width={980}
      title={`Projects on ${host.name ?? host.id}`}
      okText="Close"
      destroyOnHidden
    >
      <Space orientation="vertical" style={{ width: "100%" }} size="middle">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Running projects are shown by default. Use the filter to inspect other
          assigned project states. Emergency stop and restart actions below only
          target currently running projects on this host.
        </Typography.Paragraph>
        <Space wrap align="center">
          <Typography.Text strong>Show</Typography.Text>
          <Select<HostProjectStateFilter>
            value={stateFilter}
            style={{ minWidth: 180 }}
            options={STATE_OPTIONS}
            onChange={setStateFilter}
          />
          {onStopRunningProjects && (
            <Popconfirm
              title="Stop all running projects on this host?"
              okText="Stop running"
              cancelText="Cancel"
              onConfirm={() => onStopRunningProjects(host)}
              disabled={hostOpActive}
            >
              <Button size="small" disabled={hostOpActive}>
                Stop running projects
              </Button>
            </Popconfirm>
          )}
          {onRestartRunningProjects && (
            <Popconfirm
              title="Restart all running projects on this host?"
              okText="Restart running"
              cancelText="Cancel"
              onConfirm={() => onRestartRunningProjects(host)}
              disabled={hostOpActive}
            >
              <Button size="small" disabled={hostOpActive}>
                Restart running projects
              </Button>
            </Popconfirm>
          )}
        </Space>
        <HostProjectsTable
          host={host}
          pageSize={200}
          stateFilter={stateFilter}
        />
      </Space>
    </Modal>
  );
}
