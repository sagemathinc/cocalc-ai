/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export type StartupPerformanceOverride = "auto" | "full" | "reduced";
export type StartupPerformanceMode = "full" | "reduced";

export interface StartupPerformanceSignals {
  bootstrapModuleLoadedMs?: number;
  deviceMemoryGb?: number;
  downlinkMbps?: number;
  effectiveConnectionType?: string;
  hardwareConcurrency?: number;
  observedTransferMbps?: number;
  smallTouchDevice?: boolean;
  saveData?: boolean;
}

export interface StartupPerformancePolicy {
  mode: StartupPerformanceMode;
  override: StartupPerformanceOverride;
  reasons: string[];
  signals: StartupPerformanceSignals;
}

const STORAGE_KEY = "cocalc-startup-performance-mode-v1";
const CHANGE_EVENT = "cocalc-startup-performance-policy-change";
const SLOW_BOOTSTRAP_MS = 2_000;
const SLOW_OBSERVED_TRANSFER_MBPS = 3;
const MIN_TRANSFER_SAMPLE_BYTES = 128 * 1024;
const MIN_TRANSFER_SAMPLE_MS = 250;

const bootstrapModuleLoadedMs =
  typeof performance === "undefined" ? undefined : performance.now();

function finitePositive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function classifyStartupPerformancePolicy({
  override,
  signals,
}: {
  override: StartupPerformanceOverride;
  signals: StartupPerformanceSignals;
}): StartupPerformancePolicy {
  if (override !== "auto") {
    return {
      mode: override,
      override,
      reasons: [`override:${override}`],
      signals,
    };
  }
  const reasons: string[] = [];
  if (signals.saveData) reasons.push("save-data");
  if (["slow-2g", "2g"].includes(signals.effectiveConnectionType ?? "")) {
    reasons.push(`connection:${signals.effectiveConnectionType}`);
  }
  if (signals.downlinkMbps != null && signals.downlinkMbps <= 1.5) {
    reasons.push("downlink");
  }
  if (
    signals.observedTransferMbps != null &&
    signals.observedTransferMbps <= SLOW_OBSERVED_TRANSFER_MBPS
  ) {
    reasons.push("observed-transfer");
  }
  if (
    signals.bootstrapModuleLoadedMs != null &&
    signals.bootstrapModuleLoadedMs >= SLOW_BOOTSTRAP_MS
  ) {
    reasons.push("slow-bootstrap");
  }
  if (signals.hardwareConcurrency != null && signals.hardwareConcurrency <= 2) {
    reasons.push("cpu");
  }
  if (signals.deviceMemoryGb != null && signals.deviceMemoryGb <= 2) {
    reasons.push("memory");
  }
  if (signals.smallTouchDevice) reasons.push("small-touch-device");
  return {
    mode: reasons.length > 0 ? "reduced" : "full",
    override,
    reasons,
    signals,
  };
}

export function getStartupPerformanceOverride(): StartupPerformanceOverride {
  if (typeof localStorage === "undefined") return "auto";
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "full" || value === "reduced" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function setStartupPerformanceOverride(
  value: StartupPerformanceOverride,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value === "auto") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, value);
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // A blocked localStorage must not affect application behavior.
  }
}

function browserSignals(): StartupPerformanceSignals {
  if (typeof navigator === "undefined") return {};
  const connection = (navigator as any).connection;
  const narrow = typeof window !== "undefined" && window.innerWidth <= 700;
  return {
    bootstrapModuleLoadedMs: finitePositive(bootstrapModuleLoadedMs),
    deviceMemoryGb: finitePositive((navigator as any).deviceMemory),
    downlinkMbps: finitePositive(connection?.downlink),
    effectiveConnectionType:
      typeof connection?.effectiveType === "string"
        ? connection.effectiveType
        : undefined,
    hardwareConcurrency: finitePositive(navigator.hardwareConcurrency),
    observedTransferMbps: observedBootstrapTransferMbps(),
    saveData: connection?.saveData === true,
    smallTouchDevice: narrow && (navigator.maxTouchPoints ?? 0) > 0,
  };
}

function observedBootstrapTransferMbps(): number | undefined {
  if (typeof performance === "undefined") return;
  const resources = performance.getEntriesByType?.(
    "resource",
  ) as PerformanceResourceTiming[];
  let bestSample: { bytes: number; mbps: number } | undefined;
  for (const resource of resources ?? []) {
    if (resource.initiatorType !== "script") continue;
    const bytes = resource.encodedBodySize || resource.transferSize;
    const transferMs = resource.responseEnd - resource.responseStart;
    if (
      bytes < MIN_TRANSFER_SAMPLE_BYTES ||
      transferMs < MIN_TRANSFER_SAMPLE_MS
    ) {
      continue;
    }
    const mbps = (bytes * 8) / (transferMs * 1_000);
    if (!Number.isFinite(mbps) || mbps <= 0) continue;
    if (bestSample == null || bytes > bestSample.bytes) {
      bestSample = { bytes, mbps };
    }
  }
  return bestSample?.mbps;
}

let cachedPolicy: StartupPerformancePolicy | undefined;
let cachedSignature = "";

export function getStartupPerformancePolicy(): StartupPerformancePolicy {
  const next = classifyStartupPerformancePolicy({
    override: getStartupPerformanceOverride(),
    signals: browserSignals(),
  });
  const signature = JSON.stringify(next);
  if (cachedPolicy == null || signature !== cachedSignature) {
    cachedPolicy = next;
    cachedSignature = signature;
  }
  return cachedPolicy;
}

export function subscribeStartupPerformancePolicy(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const connection = (navigator as any).connection;
  window.addEventListener("storage", listener);
  window.addEventListener("resize", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  connection?.addEventListener?.("change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("resize", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
    connection?.removeEventListener?.("change", listener);
  };
}

export type PostSurfaceWork = "navigation" | "modals" | "banners";

export function postSurfaceDelayMs(
  mode: StartupPerformanceMode,
  work: PostSurfaceWork,
): number {
  if (mode === "full") return 0;
  switch (work) {
    case "navigation":
      return 750;
    case "modals":
      return 2_000;
    case "banners":
      return 4_000;
  }
}
