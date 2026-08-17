/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ComputeVm } from "@cocalc/conat/hub/api/compute";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { useEffect, useState } from "react";
import type { UltraliteSession } from "./session";
import { fullProjectToolUrl } from "./urls";
import { EmptyState, InlineAlert, LoadingState, SurfaceHeader } from "./ui";
import { UltraliteIcon } from "./icons";
import {
  markUltraliteBackend,
  recordUltraliteFailure,
  recordUltraliteSurfaceReady,
} from "./telemetry";

function hourlyPrice(vm: ComputeVm): string {
  const machine = Number(
    vm.effective_pricing_model === "spot"
      ? vm.spot_hourly_price
      : vm.on_demand_hourly_price,
  );
  const license = Number(vm.os_license_hourly_price || 0);
  const total = machine + license;
  return Number.isFinite(total)
    ? `$${total.toFixed(total < 1 ? 3 : 2)}/hr`
    : "";
}

function VmRow({
  busy,
  onAction,
  vm,
}: {
  busy: boolean;
  onAction: (vm: ComputeVm, running: boolean) => void;
  vm: ComputeVm;
}) {
  const running = vm.desired_state === "running" && vm.state !== "stopped";
  return (
    <div className="ul-compact-row">
      <div className="ul-row-grid">
        <div>
          <div className="ul-row-title">{vm.name}</div>
          <div className="ul-row-detail">
            {vm.state} · {vm.provider.toUpperCase()} · {vm.machine_type} ·{" "}
            {vm.cpu} CPU · {vm.ram_gb} GB RAM
          </div>
          <div className="ul-row-detail">
            {vm.operating_system === "windows" ? "Windows" : "Linux"} · boot
            disk {vm.boot_disk_gb} GB ·{" "}
            {vm.effective_pricing_model.replace("_", " ")} · {hourlyPrice(vm)}
          </div>
          {vm.public_hostname ? (
            <div className="ul-row-detail">{vm.public_hostname}</div>
          ) : null}
          {vm.error ? <div className="ul-row-detail">{vm.error}</div> : null}
        </div>
        <button
          className={`ul-button ${running ? "ul-button-secondary" : ""}`}
          disabled={
            busy || ["starting", "stopping", "deleting"].includes(vm.state)
          }
          onClick={() => {
            const action = running ? "stop" : "start";
            if (
              window.confirm(
                `${action === "start" ? "Start" : "Stop"} VM '${vm.name}'?${action === "start" ? " Running compute charges will apply." : ""}`,
              )
            ) {
              onAction(vm, !running);
            }
          }}
          type="button"
        >
          {busy ? "Working..." : running ? "Stop" : "Start"}
        </button>
      </div>
    </div>
  );
}

export default function VmSurface({
  project,
  session,
}: {
  project: AccountProjectListWindowRow;
  session: UltraliteSession;
}) {
  const [vms, setVms] = useState<ComputeVm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    markUltraliteBackend("vms", "start");
    try {
      setVms(
        await session.hubApi.compute.listVms({
          project_id: project.project_id,
        }),
      );
      markUltraliteBackend("vms", "end");
      recordUltraliteSurfaceReady("vms");
    } catch (err) {
      markUltraliteBackend("vms", "end");
      recordUltraliteFailure("vms", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // This surface intentionally reads once and refreshes only on user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.project_id, session]);

  const setRunning = async (vm: ComputeVm, running: boolean) => {
    if (busyId) return;
    setBusyId(vm.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const options = {
        id_or_name: vm.id,
        idempotency_key: crypto.randomUUID(),
      };
      if (running) {
        await session.hubApi.compute.startVm({
          ...options,
          browser_id: session.browserId,
        });
      } else {
        await session.hubApi.compute.stopVm(options);
      }
      setNotice(`${vm.name} is ${running ? "starting" : "stopping"}.`);
      await load();
    } catch (err) {
      recordUltraliteFailure("vms", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <>
            <button
              className="ul-icon-button"
              onClick={() => void load()}
              type="button"
            >
              <UltraliteIcon name="refresh" /> Refresh
            </button>
            <a
              className="ul-link-button ul-link-button-subtle"
              data-ul-full-cocalc
              href={fullProjectToolUrl({
                projectId: project.project_id,
                tool: "vms",
              })}
            >
              Create or configure in full CoCalc
            </a>
          </>
        }
        eyebrow="Dedicated compute"
        title="Virtual machines"
      />
      <p className="ul-muted">
        Start and stop existing project VMs here. Creation, deletion, funding,
        resizing, and Remote Desktop configuration remain in full CoCalc.
      </p>
      {notice ? <InlineAlert>{notice}</InlineAlert> : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {loading ? <LoadingState label="Loading virtual machines" /> : null}
      {!loading && !vms.length ? (
        <EmptyState>This project has no dedicated virtual machines.</EmptyState>
      ) : null}
      {vms.length ? (
        <div className="ul-compact-list">
          {vms.map((vm) => (
            <VmRow
              busy={busyId === vm.id}
              key={vm.id}
              onAction={(item, running) => void setRunning(item, running)}
              vm={vm}
            />
          ))}
        </div>
      ) : null}
    </main>
  );
}
