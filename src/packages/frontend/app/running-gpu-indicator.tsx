import { Button, Modal, Space, Typography } from "antd";
import { CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import type { ComputeVm } from "@cocalc/conat/hub/api/compute";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  getHostsPageHref,
  openHostsPage,
} from "@cocalc/frontend/hosts/navigation";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import VmFundingStatus from "@cocalc/frontend/project/compute-vm-funding-status";

const STALE_MS = 120000;

export function runningVmSummary(
  vms: ComputeVm[] | undefined,
  now = Date.now(),
) {
  let running = 0;
  let unknown = vms === undefined;
  for (const vm of vms ?? []) {
    if (vm.deleted_at) continue;
    const observed = vm.provider_observed_at
      ? new Date(vm.provider_observed_at).valueOf()
      : NaN;
    if (
      !Number.isFinite(observed) ||
      now - observed > STALE_MS ||
      vm.provider_observation_error
    ) {
      unknown = true;
    } else if (
      vm.provider_state === "running" ||
      vm.provider_state === "starting"
    ) {
      running++;
    } else if (
      vm.provider_state !== "stopped" &&
      vm.provider_state !== "missing"
    ) {
      unknown = true;
    }
  }
  return { running, unknown };
}

export function RunningGpuIndicator({ narrow = false }: { narrow?: boolean }) {
  const accountId = useTypedRedux("account", "account_id");
  const [snapshot, setSnapshot] = useState<{
    accountId: string;
    rows: ComputeVm[];
    at: number;
  }>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [dismissedSnapshot, setDismissedSnapshot] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now);
  const trigger = useRef<ComponentRef<typeof Button>>(null);
  useEffect(() => {
    setDismissedSnapshot(undefined);
    setOpen(false);
  }, [accountId]);
  useEffect(() => {
    if (!accountId) return;
    let active = true;
    let inFlight = false;
    const load = async () => {
      setNow(Date.now());
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        // No project filter: account-owned VMs across every project.
        const rows = await webapp_client.conat_client.hub.compute.listVms({});
        if (!Array.isArray(rows)) throw new Error("VM status unavailable");
        if (active) {
          setSnapshot({ accountId, rows, at: Date.now() });
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [accountId, refresh]);
  if (!accountId) return null;
  const current = snapshot?.accountId === accountId ? snapshot : undefined;
  const summary = runningVmSummary(failed ? undefined : current?.rows, now);
  const unknown =
    summary.unknown || (current != null && now - current.at > STALE_MS);
  const label = unknown
    ? "VM status unknown"
    : `${summary.running} ${summary.running === 1 ? "VM" : "VMs"} running`;
  const runningVms = (current?.rows ?? []).filter(
    (vm) =>
      !vm.deleted_at &&
      (vm.provider_state === "running" || vm.provider_state === "starting"),
  );
  const reminderKey = JSON.stringify(runningVms.map((vm) => vm.id).sort());
  const expanded =
    !narrow &&
    dismissedSnapshot !== reminderKey &&
    summary.running > 0 &&
    !unknown;
  return (
    <>
      <Space size={0} style={{ flexShrink: 0 }}>
        <Button
          ref={trigger}
          size="small"
          aria-label={label}
          onClick={() => setOpen(true)}
          style={{
            marginInline: 4,
            maxWidth: expanded ? 180 : 80,
            color: summary.running > 0 ? UI_COLORS.warning : undefined,
            background: summary.running > 0 ? UI_COLORS.warningBg : undefined,
          }}
        >
          {expanded ? label : `VM ${unknown ? "?" : summary.running}`}
        </Button>
        {expanded && (
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            aria-label="Collapse VM status"
            title="Collapse VM status"
            onClick={() => {
              setDismissedSnapshot(reminderKey);
              trigger.current?.focus();
            }}
          />
        )}
      </Space>
      <Modal
        title="Account virtual machines"
        open={open}
        onCancel={() => setOpen(false)}
        modalRender={(modal) => (
          <KeyboardBoundary boundary="running-gpu">{modal}</KeyboardBoundary>
        )}
        footer={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Refresh
            </Button>
            <Button
              href={getHostsPageHref("vms")}
              onClick={(event) => {
                event.preventDefault();
                setOpen(false);
                openHostsPage("vms");
              }}
            >
              View VMs
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
              }}
            >
              Close
            </Button>
          </Space>
        }
      >
        <div>
          <Typography.Paragraph role="status">{label}</Typography.Paragraph>
          {current && (
            <Typography.Paragraph>
              Last checked: {new Date(current.at).toLocaleString()}
            </Typography.Paragraph>
          )}
          <Typography.Paragraph>
            Running VMs continue to use their selected funding. Scheduled stops
            do not delete retained disks.
          </Typography.Paragraph>
          {runningVms.map((vm) => (
            <section
              key={vm.id}
              aria-label={`${vm.name} funding`}
              style={{
                borderTop: `1px solid ${UI_COLORS.border}`,
                paddingBlock: 12,
              }}
            >
              <Typography.Text strong>{vm.name}</Typography.Text>
              {vm.funding_status ? (
                <VmFundingStatus funding={vm.funding_status} compact />
              ) : (
                <Typography.Paragraph type="secondary">
                  Paid using {vm.funding_mode.replaceAll("-", " ")} funding.
                </Typography.Paragraph>
              )}
            </section>
          ))}
        </div>
      </Modal>
    </>
  );
}
