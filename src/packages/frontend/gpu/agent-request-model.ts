/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What the approval banner says about an agent's GPU request (step 6b-2):
// exactly the stored payload the human approves, in words. Pure, so it is
// tested on its own.

import type { GpuAgentRequestView } from "@cocalc/conat/hub/api/gpu";

export function usd(value: string | number, perHour = false): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `$${value}`;
  const digits = n > 0 && n < 0.01 ? 4 : 2;
  return `$${n.toFixed(digits)}${perHour ? "/hour" : ""}`;
}

// Who asked: a project agent token is one chat session, never shown by its
// key; a registered agent only when the server genuinely resolved one.
export function agentLabel(view: GpuAgentRequestView): string {
  if (view.principal_kind === "registered_agent" && view.agent_id) {
    return `Agent ${view.agent_id.slice(0, 8)}${
      view.run_id ? ` (run ${`${view.run_id}`.slice(0, 8)})` : ""
    }`;
  }
  return "This chat session";
}

export function requestSummary(view: GpuAgentRequestView): string {
  const { spec } = view.payload;
  const count = spec.gpu_count ?? 1;
  return `${count} x ${spec.gpu_type_id}`;
}

export interface RequestLine {
  label: string;
  value: string;
}

// The launch, line by line, from the stored payload only.
export function requestLines(view: GpuAgentRequestView): RequestLine[] {
  const { spec, hourly_usd, max_cost_usd } = view.payload;
  const lines: RequestLine[] = [
    { label: "Asked by", value: agentLabel(view) },
    { label: "GPU", value: requestSummary(view) },
    {
      label: "Cloud",
      value: `${spec.cloud === "COMMUNITY" ? "Community" : "Secure"} Cloud${
        spec.data_center_id ? `, ${spec.data_center_id}` : ""
      }`,
    },
    { label: "Image", value: `${spec.image}` },
    {
      label: "Runs at most",
      value: `${spec.max_runtime_minutes} minutes, then CoCalc terminates it`,
    },
  ];
  const disk = [
    spec.container_disk_gb ? `${spec.container_disk_gb} GB disk` : "",
    spec.volume_gb ? `${spec.volume_gb} GB volume` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (disk) lines.push({ label: "Storage", value: disk });
  if (spec.ports?.length) {
    lines.push({ label: "Ports", value: spec.ports.join(", ") });
  }
  const env = Object.entries(spec.env ?? {});
  if (env.length) {
    lines.push({
      label: "Environment",
      value: env.map(([k, v]) => `${k}=${v}`).join(", "),
    });
  }
  lines.push(
    {
      label: "Price",
      value: `${usd(hourly_usd, true)} at RunPod's list price`,
    },
    {
      label: "Most it can cost",
      value: `${usd(max_cost_usd)} (GPUs and disk for the whole runtime)`,
    },
    {
      label: "Allows",
      value: "One pod, launched once, on your own RunPod key",
    },
  );
  return lines;
}

// The exact payload and its hash, as approval names them.
export function exactRequest(view: GpuAgentRequestView): string {
  return JSON.stringify(
    { payload: view.payload, payload_hash: view.payload_hash },
    null,
    2,
  );
}

export function pendingRequests(
  views: GpuAgentRequestView[],
): GpuAgentRequestView[] {
  return views.filter((v) => v.state === "pending");
}

export function activeApprovals(
  views: GpuAgentRequestView[],
): GpuAgentRequestView[] {
  return views.filter((v) => v.grant?.state === "active");
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
