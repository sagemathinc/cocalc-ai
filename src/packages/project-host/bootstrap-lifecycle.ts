import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  HostBootstrapLifecycle,
  HostBootstrapLifecycleItem,
  HostBootstrapLifecycleItemStatus,
} from "@cocalc/conat/hub/api/hosts";
import { projectHostBootstrapDirCandidates } from "./bootstrap-paths";
import { getSoftwareVersions } from "./software";

type JsonRecord = Record<string, any>;

function readJson(path: string): JsonRecord | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore unreadable files
  }
  return undefined;
}

function resolveBootstrapDir(): string | undefined {
  for (const candidate of projectHostBootstrapDirCandidates()) {
    if (
      existsSync(join(candidate, "bootstrap-desired-state.json")) ||
      existsSync(join(candidate, "bootstrap-state.json"))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function nonEmptyValue(
  value: unknown,
): string | boolean | number | null | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null) return null;
  return undefined;
}

function shortSha(value: string | undefined): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 12);
}

function currentBootstrapSha256(bootstrapDir: string): string | undefined {
  try {
    const bootstrapPy = realpathSync(join(bootstrapDir, "bootstrap.py"));
    const hash = createHash("sha256");
    hash.update(readFileSync(bootstrapPy));
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function cloudflaredBinaryPresent(): boolean {
  return (
    existsSync("/usr/bin/cloudflared") ||
    existsSync("/usr/local/bin/cloudflared")
  );
}

function cloudflaredServicePresent(): boolean {
  return (
    existsSync("/usr/local/sbin/cocalc-cloudflared-ctl") &&
    (existsSync("/etc/systemd/system/cocalc-cloudflared.service") ||
      existsSync("/lib/systemd/system/cocalc-cloudflared.service"))
  );
}

function projectHostRuntimeRoot(opts: {
  desired: JsonRecord;
  facts: JsonRecord;
}): string | undefined {
  const bundleRoot = stringOrUndefined(
    opts.desired.project_host_bundle?.root ??
      opts.facts.project_host_bundle_root,
  );
  if (bundleRoot) {
    return basename(bundleRoot) === "bundles"
      ? dirname(bundleRoot)
      : bundleRoot;
  }
  return stringOrUndefined(opts.facts.bootstrap_root);
}

function makeItem(opts: {
  key: string;
  label: string;
  desired?: string | boolean | number | null;
  installed?: string | boolean | number | null;
  status?: HostBootstrapLifecycleItemStatus;
  message?: string;
}): HostBootstrapLifecycleItem {
  const desired = opts.desired;
  const installed = opts.installed;
  const status =
    opts.status ??
    (() => {
      if (desired == null && installed == null) return "unknown";
      if (desired == null) return "unknown";
      if (installed == null) return "missing";
      return desired === installed ? "match" : "drift";
    })();
  return {
    key: opts.key,
    label: opts.label,
    ...(desired !== undefined ? { desired } : {}),
    ...(installed !== undefined ? { installed } : {}),
    status,
    ...(opts.message ? { message: opts.message } : {}),
  };
}

function compareNumericVersionLike(
  desired: unknown,
  installed: unknown,
): number | undefined {
  if (typeof desired !== "string" || typeof installed !== "string") {
    return undefined;
  }
  const desiredTrimmed = desired.trim();
  const installedTrimmed = installed.trim();
  if (!/^\d+$/.test(desiredTrimmed) || !/^\d+$/.test(installedTrimmed)) {
    return undefined;
  }
  const desiredValue = BigInt(desiredTrimmed);
  const installedValue = BigInt(installedTrimmed);
  if (installedValue === desiredValue) return 0;
  return installedValue > desiredValue ? 1 : -1;
}

function makeBundleItem(opts: {
  key: string;
  label: string;
  desired?: string | boolean | number | null;
  installed?: string | boolean | number | null;
}): HostBootstrapLifecycleItem {
  const versionComparison = compareNumericVersionLike(
    opts.desired,
    opts.installed,
  );
  if (versionComparison != null && versionComparison >= 0) {
    return makeItem({
      ...opts,
      status: "match",
      ...(versionComparison > 0
        ? { message: "installed bundle is newer than desired" }
        : {}),
    });
  }
  return makeItem(opts);
}

function buildBootstrapLifecycleItems(opts: {
  bootstrapDir: string;
  desired: JsonRecord;
  installedState: JsonRecord;
  facts: JsonRecord;
}): HostBootstrapLifecycleItem[] {
  const desired = opts.desired;
  const installedState = opts.installedState;
  const facts = opts.facts;
  const runtimeVersions = getSoftwareVersions();
  const desiredBootstrap = desired.bootstrap ?? {};
  const installedBootstrap = installedState.bootstrap ?? {};
  const desiredBootstrapSha = shortSha(
    stringOrUndefined(desiredBootstrap.sha256),
  );
  const desiredBootstrapSelector = stringOrUndefined(desiredBootstrap.selector);
  const installedBootstrapSha =
    shortSha(currentBootstrapSha256(opts.bootstrapDir)) ??
    shortSha(stringOrUndefined(installedBootstrap.sha256));
  const installedBootstrapSelector = stringOrUndefined(
    installedBootstrap.selector,
  );
  const desiredBootstrapId = desiredBootstrapSha ?? desiredBootstrapSelector;
  const installedBootstrapId = desiredBootstrapSha
    ? (installedBootstrapSha ?? installedBootstrapSelector)
    : (installedBootstrapSelector ??
      desiredBootstrapSelector ??
      installedBootstrapSha);

  const items: HostBootstrapLifecycleItem[] = [
    makeItem({
      key: "bootstrap",
      label: "Bootstrap script",
      desired: desiredBootstrapId,
      installed: installedBootstrapId,
    }),
    makeBundleItem({
      key: "project_host_bundle",
      label: "Project host bundle",
      desired: nonEmptyValue(desired.project_host_bundle?.version),
      installed:
        nonEmptyValue(runtimeVersions.project_host) ??
        nonEmptyValue(installedState.installed?.project_host_bundle_version),
    }),
    makeBundleItem({
      key: "project_bundle",
      label: "Project bundle",
      desired: nonEmptyValue(desired.project_bundle?.version),
      installed:
        nonEmptyValue(runtimeVersions.project_bundle) ??
        nonEmptyValue(installedState.installed?.project_bundle_version),
    }),
    makeBundleItem({
      key: "tools_bundle",
      label: "Tools bundle",
      desired: nonEmptyValue(desired.tools_bundle?.version),
      installed:
        nonEmptyValue(runtimeVersions.tools) ??
        nonEmptyValue(installedState.installed?.tools_bundle_version),
    }),
    makeItem({
      key: "helper_schema",
      label: "Helper scripts",
      desired: nonEmptyValue(desired.helper_schema_version),
      installed: nonEmptyValue(installedState.helper_schema_version),
    }),
    makeItem({
      key: "runtime_wrappers",
      label: "Runtime wrappers",
      desired: nonEmptyValue(desired.runtime_wrapper_version),
      installed: nonEmptyValue(installedState.runtime_wrapper_version),
    }),
  ];
  const runtimeRoot = projectHostRuntimeRoot({ desired, facts });
  if (runtimeRoot) {
    const projectHostWrapperPath = join(runtimeRoot, "bin", "project-host");
    const projectHostCtlPath = join(runtimeRoot, "bin", "ctl");
    items.push(
      makeItem({
        key: "project_host_wrapper",
        label: "Project-host wrapper",
        desired: true,
        installed: existsSync(projectHostWrapperPath),
        status: existsSync(projectHostWrapperPath) ? "match" : "missing",
        message: projectHostWrapperPath,
      }),
    );
    items.push(
      makeItem({
        key: "project_host_ctl",
        label: "Project-host ctl helper",
        desired: true,
        installed: existsSync(projectHostCtlPath),
        status: existsSync(projectHostCtlPath) ? "match" : "missing",
        message: projectHostCtlPath,
      }),
    );
  }

  const cloudflaredEnabled = desired.cloudflared?.enabled === true;
  items.push(
    makeItem({
      key: "cloudflared",
      label: "Cloudflared binary",
      desired: cloudflaredEnabled,
      installed: cloudflaredEnabled ? cloudflaredBinaryPresent() : undefined,
      status: cloudflaredEnabled
        ? cloudflaredBinaryPresent()
          ? "match"
          : "missing"
        : "disabled",
      message: cloudflaredEnabled
        ? cloudflaredBinaryPresent()
          ? "cloudflared binary present"
          : "cloudflared enabled but binary missing"
        : "cloudflared disabled for this host",
    }),
  );
  items.push(
    makeItem({
      key: "cloudflared_service",
      label: "Cloudflared service",
      desired: cloudflaredEnabled,
      installed: cloudflaredEnabled ? cloudflaredServicePresent() : undefined,
      status: cloudflaredEnabled
        ? cloudflaredServicePresent()
          ? "match"
          : "missing"
        : "disabled",
      message: cloudflaredEnabled
        ? cloudflaredServicePresent()
          ? "cloudflared service helpers present"
          : "cloudflared enabled but service helpers missing"
        : "cloudflared disabled for this host",
    }),
  );

  return items;
}

function buildSummary(opts: {
  items: HostBootstrapLifecycleItem[];
  current_operation?: string;
  last_reconcile_result?: string;
  last_error?: string;
}): {
  summary_status: HostBootstrapLifecycle["summary_status"];
  summary_message?: string;
  drift_count: number;
} {
  const driftCount = opts.items.filter(
    (item) => item.status === "drift" || item.status === "missing",
  ).length;
  const currentOperation = `${opts.current_operation ?? ""}`.trim();
  const lastReconcileResult = `${opts.last_reconcile_result ?? ""}`
    .trim()
    .toLowerCase();
  if (currentOperation === "reconcile") {
    return {
      summary_status: "reconciling",
      summary_message: "host software reconcile in progress",
      drift_count: driftCount,
    };
  }
  if (lastReconcileResult === "error") {
    return {
      summary_status: "error",
      summary_message:
        `${opts.last_error ?? ""}`.trim() || "last reconcile failed",
      drift_count: driftCount,
    };
  }
  if (driftCount > 0) {
    return {
      summary_status: "drifted",
      summary_message:
        driftCount === 1
          ? "1 drift item detected"
          : `${driftCount} drift items detected`,
      drift_count: driftCount,
    };
  }
  if (opts.items.length === 0) {
    return {
      summary_status: "unknown",
      summary_message: "bootstrap lifecycle state not available",
      drift_count: 0,
    };
  }
  return {
    summary_status: "in_sync",
    summary_message: "desired and installed software are aligned",
    drift_count: 0,
  };
}

export function getBootstrapLifecycle(): HostBootstrapLifecycle | undefined {
  const bootstrapDir = resolveBootstrapDir();
  if (!bootstrapDir) return undefined;
  const desired = readJson(join(bootstrapDir, "bootstrap-desired-state.json"));
  const installedState = readJson(join(bootstrapDir, "bootstrap-state.json"));
  const facts = readJson(join(bootstrapDir, "bootstrap-host-facts.json"));
  if (!desired && !installedState && !facts) return undefined;

  const items = buildBootstrapLifecycleItems({
    bootstrapDir,
    desired: desired ?? {},
    installedState: installedState ?? {},
    facts: facts ?? {},
  });
  const summary = buildSummary({
    items,
    current_operation: stringOrUndefined(installedState?.current_operation),
    last_reconcile_result: stringOrUndefined(
      installedState?.last_reconcile_result,
    ),
    last_error: stringOrUndefined(installedState?.last_error),
  });

  return {
    bootstrap_dir: bootstrapDir,
    desired_recorded_at: stringOrUndefined(desired?.recorded_at),
    installed_recorded_at: stringOrUndefined(installedState?.recorded_at),
    current_operation: stringOrUndefined(installedState?.current_operation),
    last_provision_result: stringOrUndefined(
      installedState?.last_provision_result,
    ),
    last_provision_started_at: stringOrUndefined(
      installedState?.last_provision_started_at,
    ),
    last_provision_finished_at: stringOrUndefined(
      installedState?.last_provision_finished_at,
    ),
    last_reconcile_result: stringOrUndefined(
      installedState?.last_reconcile_result,
    ),
    last_reconcile_started_at: stringOrUndefined(
      installedState?.last_reconcile_started_at,
    ),
    last_reconcile_finished_at: stringOrUndefined(
      installedState?.last_reconcile_finished_at,
    ),
    last_error: stringOrUndefined(installedState?.last_error),
    summary_status: summary.summary_status,
    ...(summary.summary_message
      ? { summary_message: summary.summary_message }
      : {}),
    drift_count: summary.drift_count,
    items,
  };
}
