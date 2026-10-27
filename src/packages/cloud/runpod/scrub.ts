/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// RunPod responses can carry secrets: pod env (ours, e.g. a bootstrap token,
// or anything the account owner set), registry auth, start commands, and
// provider error bodies that echo request fields. Nothing provider-shaped
// leaves this package unscrubbed.

const MAX_ERROR_TEXT = 200;

// Anything that looks like a RunPod key or a bearer token.
const SECRET_PATTERNS: RegExp[] = [
  /rpa_[A-Za-z0-9]+/g,
  /rps_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /RUNPOD_SECRET_[A-Za-z0-9_]*/g,
];

export function scrubText(text: unknown, max = MAX_ERROR_TEXT): string {
  let s = typeof text === "string" ? text : safeStringify(text);
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
  // Provider bodies may embed our request (env, start command): never
  // return more than a short prefix.
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export interface RunpodPodView {
  id: string;
  name?: string;
  desiredStatus?: string;
  costPerHr?: number;
  adjustedCostPerHr?: number;
  gpuCount?: number;
  gpuTypeId?: string;
  machineId?: string;
  dataCenterId?: string;
  publicIp?: string | null;
  portMappings?: Record<string, number>;
  interruptible?: boolean;
  imageName?: string;
  createdAt?: string;
  lastStartedAt?: string;
}

// An explicit allowlist, not a denylist: provider fields we don't know about
// (or that RunPod adds later) are dropped. In particular env, dockerStartCmd,
// dockerEntrypoint, containerRegistryAuthId, templateId and consumerUserId
// never appear in a view.
export function podView(raw: any): RunpodPodView | undefined {
  if (raw == null || typeof raw !== "object" || typeof raw.id !== "string") {
    return undefined;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const view: RunpodPodView = {
    id: raw.id,
    name: str(raw.name),
    desiredStatus: str(raw.desiredStatus),
    costPerHr: num(raw.costPerHr),
    adjustedCostPerHr: num(raw.adjustedCostPerHr),
    gpuCount: num(raw.gpuCount),
    gpuTypeId: str(raw.machine?.gpuTypeId) ?? str(raw.gpu?.id),
    machineId: str(raw.machineId),
    dataCenterId: str(raw.machine?.dataCenterId) ?? str(raw.dataCenterId),
    publicIp: raw.publicIp === null ? null : str(raw.publicIp),
    interruptible:
      typeof raw.interruptible === "boolean" ? raw.interruptible : undefined,
    imageName: str(raw.image) ?? str(raw.imageName),
    createdAt: str(raw.createdAt),
    lastStartedAt: str(raw.lastStartedAt),
  };
  if (raw.portMappings && typeof raw.portMappings === "object") {
    const ports: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.portMappings)) {
      const n = num(v);
      if (/^\d{1,5}$/.test(k) && n != null) ports[k] = n;
    }
    view.portMappings = ports;
  }
  for (const k of Object.keys(view) as (keyof RunpodPodView)[]) {
    if (view[k] === undefined) delete view[k];
  }
  return view;
}
