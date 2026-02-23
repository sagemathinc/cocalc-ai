import { Checkbox, Input, InputNumber, Modal, Typography } from "antd";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import type {
  HostDeleteOptions,
  HostDrainOptions,
  HostStopOptions,
} from "../types";
import { HostProjectsTable } from "./host-projects-table";

function getBackupCounts(host?: Host) {
  const backup = host?.backup_status;
  return {
    total: backup?.total ?? 0,
    provisioned: backup?.provisioned ?? 0,
    running: backup?.running ?? 0,
    upToDate: backup?.provisioned_up_to_date ?? 0,
    needsBackup: backup?.provisioned_needs_backup ?? 0,
  };
}

export function confirmHostStop({
  host,
  onConfirm,
}: {
  host: Host;
  onConfirm: (opts?: HostStopOptions) => void | Promise<void>;
}) {
  const hostName = host.name ?? "Host";
  const { total, provisioned, running, upToDate, needsBackup } =
    getBackupCounts(host);
  const risky = needsBackup + running;
  const state = { skip: false };
  Modal.confirm({
    title: `Stop ${hostName}?`,
    width: 900,
    content: (
      <div>
        <Typography.Text type="secondary">
          This will create backups for provisioned workspaces that need them.
        </Typography.Text>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          When a host is off or deprovisioned, workspaces can still be used on
          another host using the most recent backup.
        </Typography.Paragraph>
        {total > 0 && (
          <div style={{ marginTop: 6 }}>
            <Typography.Text type="secondary">
              Assigned: {total} · Provisioned: {provisioned} · Running:{" "}
              {running} · Backed up: {upToDate}/{provisioned}
              {risky > 0 ? ` · Needs backup: ${risky}` : ""}
            </Typography.Text>
          </div>
        )}
        {risky > 0 && (
          <div style={{ marginTop: 10 }}>
            <Typography.Text strong>At-risk workspaces</Typography.Text>
            <div style={{ marginTop: 6 }}>
              <HostProjectsTable
                host={host}
                riskOnly
                compact
                showSummary={false}
                pageSize={50}
                showControls={false}
              />
            </div>
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <Checkbox onChange={(event) => (state.skip = event.target.checked)}>
            Skip backups (force)
          </Checkbox>
        </div>
      </div>
    ),
    okText: "Stop",
    onOk: () => onConfirm({ skip_backups: state.skip }),
  });
}

export function confirmHostDrain({
  host,
  onConfirm,
}: {
  host: Host;
  onConfirm: (opts?: HostDrainOptions) => void | Promise<void>;
}) {
  const hostName = host.name ?? "Host";
  const { total, provisioned, running, upToDate, needsBackup } =
    getBackupCounts(host);
  const state = { force: false, parallel: 10 };
  Modal.confirm({
    title: `Drain ${hostName}?`,
    width: 900,
    content: (
      <div>
        <Typography.Text type="secondary">
          Drain moves assigned workspaces off this host onto another running
          host selected automatically.
        </Typography.Text>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Enable force drain only as a last resort. It directly clears
          workspace host assignment (`host_id=null`) without performing safe
          move operations.
        </Typography.Paragraph>
        {total > 0 && (
          <div style={{ marginTop: 6 }}>
            <Typography.Text type="secondary">
              Assigned: {total} · Provisioned: {provisioned} · Running:{" "}
              {running} · Backed up: {upToDate}/{provisioned}
              {needsBackup > 0 ? ` · Needs backup: ${needsBackup}` : ""}
            </Typography.Text>
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <Typography.Text strong>Assigned workspaces</Typography.Text>
          <div style={{ marginTop: 6 }}>
            <HostProjectsTable
              host={host}
              compact
              showSummary={false}
              pageSize={50}
              showControls={false}
            />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <Checkbox onChange={(event) => (state.force = event.target.checked)}>
            Force drain (set workspace host assignment to null)
          </Checkbox>
        </div>
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ marginRight: 8 }}>
            Parallel moves:
          </Typography.Text>
          <InputNumber
            min={1}
            step={1}
            precision={0}
            defaultValue={10}
            onChange={(value) => {
              const n = Number(value);
              if (Number.isFinite(n) && n >= 1) {
                state.parallel = Math.floor(n);
              } else {
                state.parallel = 10;
              }
            }}
          />
          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
            default 10; non-admin max 15; ignored with force drain
          </Typography.Text>
        </div>
      </div>
    ),
    okText: "Drain",
    onOk: () =>
      onConfirm({
        force: state.force,
        parallel: state.force ? undefined : state.parallel,
      }),
  });
}

export function confirmHostDeprovision({
  host,
  onConfirm,
}: {
  host: Host;
  onConfirm: (opts?: HostDeleteOptions) => void | Promise<void>;
}) {
  const state = { name: "", skip: false };
  const hostName = host.name ?? "Host";
  const { total, provisioned, running, upToDate, needsBackup } =
    getBackupCounts(host);
  const needs = needsBackup + running;
  const status = host.status ?? "off";
  const hostRunning =
    status === "running" ||
    status === "starting" ||
    status === "restarting" ||
    status === "error";
  const modal = Modal.confirm({
    title: `Deprovision ${hostName}?`,
    width: 900,
    content: (
      <div>
        <Typography.Text type="secondary">
          Type the host name to confirm deprovisioning.
        </Typography.Text>
        <Input
          style={{ marginTop: 8 }}
          placeholder={hostName}
          onChange={(event) => {
            state.name = event.target.value;
            modal.update({
              okButtonProps: {
                danger: true,
                disabled: state.name.trim() !== hostName,
              },
            });
          }}
        />
        {hostRunning ? (
          <div style={{ marginTop: 8 }}>
            <Checkbox onChange={(event) => (state.skip = event.target.checked)}>
              Skip backups (force)
            </Checkbox>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">
              Host is off, so backups cannot run. Start this host if you want to
              ensure {needs} provisioned workspace
              {needs === 1 ? "" : "s"} are properly backed up.
            </Typography.Text>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              When a host is off or deprovisioned, workspaces can still be used
              on another host using the most recent backup.
            </Typography.Paragraph>
            {total > 0 && (
              <div style={{ marginTop: 6 }}>
                <Typography.Text type="secondary">
                  Assigned: {total} · Provisioned: {provisioned} · Running:{" "}
                  {running} · Backed up: {upToDate}/{provisioned}
                  {needs > 0 ? ` · Needs backup: ${needs}` : ""}
                </Typography.Text>
              </div>
            )}
          </div>
        )}
        {needs > 0 && (
          <div style={{ marginTop: 10 }}>
            <Typography.Text strong>At-risk workspaces</Typography.Text>
            <div style={{ marginTop: 6 }}>
              <HostProjectsTable
                host={host}
                riskOnly
                compact
                showSummary={false}
                pageSize={50}
                showControls={false}
              />
            </div>
          </div>
        )}
      </div>
    ),
    okText: "Deprovision",
    okButtonProps: { danger: true, disabled: true },
    onOk: async () => {
      if (state.name.trim() !== hostName) {
        throw new Error("host name does not match");
      }
      await onConfirm({ skip_backups: hostRunning ? state.skip : true });
    },
  });
}
