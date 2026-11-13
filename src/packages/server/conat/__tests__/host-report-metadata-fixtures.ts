/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared by host-report-metadata.test.ts and host-registry.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  buildHostBaseMetadata,
  buildHostReportMetadata,
} from "../../../project-host/host-report-payload";

// Top-level metadata keys the bay writes. writtenProjectHostMetadataKeys()
// below finds the ones written in the detected SQL forms (see
// metadataKeysWrittenIn) in server/database code that touches project_hosts;
// the enumeration test fails if it finds one that is not listed here, and
// wholeMetadataWriterFiles() fails closed on any new file that writes the
// whole metadata object. Not detected: keys set in code before such a
// whole-object write, e.g. an object literal over a metadata spread
// (`{ ...metadata, bootstrap: ... }`, cloud/host-work.ts); bootstrap and
// reconcile below are listed from a manual check of that form.
// The rest come from manual traces (security-audit's 076 reader trace, host
// create and provider reconcile). The allow-list drops every non-host key
// whether or not it is listed. None may come from a host report.
export const BAY_OWNED_METADATA_KEYS = [
  "admin_reopen_reservation",
  "billing",
  "bootstrap",
  "cloud_provider",
  "desired_pricing_model",
  "cloudflare_tunnel",
  "content_dns",
  "desired_state",
  "dns",
  "dns_reconciliation",
  "effective_pricing_model",
  "interruption_restore_policy",
  "ip_address",
  "last_action",
  "last_action_at",
  "last_action_error",
  "last_action_status",
  "legacy_migration_disabled_reason",
  "local",
  "machine",
  "machine_change_pending",
  "planned_project_host_transition",
  "pricing_model",
  "provider",
  "public_ip",
  "public_route",
  "public_route_auto_recovery",
  "public_route_incidents",
  "public_route_probe",
  "public_url",
  "reconcile",
  "renewal_interval",
  "resources",
  "restart_recovery",
  "runtime",
  "runtime_auto_recovery",
  "runtime_deployments",
  "runtime_synthetic_probe",
  "self_host",
  "shutdown_notice",
  "spot_recovery_policy",
  "spot_recovery_state",
  "storage_admission_mode",
] as const;

// A report produced by the real project-host assembly
// (project-host/host-report-payload.ts, which master.ts calls), from
// deterministic inputs at the sizes the project-host code allows where it
// bounds them (placement: at most 128 cached images, master.ts
// PLACEMENT_ROOTFS_CACHE_LIMIT; cloudflared: at most 16 connections,
// cloudflared-diagnostics.ts) and generous sizes where it does not. See the
// PR's size table.
export function hostReportFixture(): Record<string, unknown> {
  const base = buildHostBaseMetadata({
    runnerId: "runner-1",
    host_session_id: "8d6f0c2e-1d4b-4a8e-9f7a-2c3b4d5e6f70",
    host_boot_id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
    host_session_started_at: "2026-11-13T00:00:00.000Z",
    host_boot_started_at: "2026-11-12T00:00:00.000Z",
    host_cpu_count: 64,
    host_ram_gb: 256,
  });
  const iso = "2026-11-13T00:00:00.000Z";
  return buildHostReportMetadata({
    base,
    cloudflared: {
      captured_at: iso,
      expected_version: "2026.10.0",
      version: "2026.10.0",
      version_drift: false,
      pid: 1234,
      process_elapsed_s: 86400,
      ready_status: 200,
      ready_connections: 4,
      connector_id: "c0nnect0r-0000-0000-0000-000000000000",
      configured_protocol: "quic",
      observed_protocols: ["quic"],
      protocols: ["quic"],
      protocol_source: "observed",
      edge_addresses: Array.from({ length: 16 }, (_, i) => `198.41.192.${i}`),
    },
    host_uptime_s: 86400,
    currentMetrics: {
      collected_at: iso,
      cpu_percent: 97.5,
      load_1: 63.1,
      load_5: 60.2,
      load_15: 58.9,
      memory_total_bytes: 274877906944,
      memory_used_bytes: 247390116249,
      memory_available_bytes: 27487790695,
      memory_used_percent: 90,
      swap_total_bytes: 0,
      swap_used_bytes: 0,
      kernel_sysctls: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`fs.sysctl_${i}`, 1048576]),
      ),
      resource_pressure: {
        zone: "pressure",
        findings: Array.from({ length: 200 }, (_, i) => ({
          project_id: `00000000-0000-4000-8000-${`${i}`.padStart(12, "0")}`,
          reason: "inotify_watches",
          value: 262144,
          limit: 131072,
        })),
      },
      io_containment: {
        policy_mode: "enforce",
        capabilities: ["io.max", "io.weight", "io.pressure"],
        projects: Array.from({ length: 200 }, (_, i) => ({
          project_id: `00000000-0000-4000-8000-${`${i}`.padStart(12, "0")}`,
          read_bps: 1048576,
          write_bps: 1048576,
          full_avg10: 1.5,
        })),
      },
      storage_admission: { mode: "enforce", state: "normal", state_since: iso },
      conat_persist: { streams: 5000, bytes: 1099511627776, open: 1200 },
    },
    pressureState: {
      zone: "pressure",
      reason: "memory_used_percent>=80",
      evaluated_at_ms: 1794540000000,
      candidate_count: 200,
      recent_pressure_stop_count: 30,
      last_action_status: "stopped",
      last_action_reason: "memory_used_percent>=80,priority:0,idle_ms:1",
    },
    placementSnapshot: {
      observed_at: iso,
      cached_rootfs_images: Array.from(
        { length: 128 },
        (_, i) =>
          `docker.io/sagemathinc/rootfs-image-${i}:2026.11.12-${"x".repeat(60)}`,
      ),
      rootfs_cache_truncated: true,
    },
    bootstrapLifecycle: {
      phase: "ready",
      updated_at: iso,
      error: "e".repeat(4096),
    },
    host_agent: {
      project_host: { last_known_good_version: "20261112T035749Z-bd0131eb" },
      status: "ok",
    },
    runtime_health: { ready: true, status: "ok", error: "r".repeat(4096) },
    acp_worker_health: { ok: true, oldest_queued_at: 1794540000000 },
    bees: { state: "running", workers: 8 },
    host_integrity: {
      ok: true,
      checks: Array.from({ length: 50 }, (_, i) => ({
        name: `check-${i}`,
        ok: true,
      })),
    },
    runtime_uid_mode: {
      mode: "separate",
      reason: "configured",
      sidecars: true,
    },
    observed_components: Array.from({ length: 20 }, (_, i) => ({
      component: `component-${i}`,
      state: "running",
      version: "20261112T035749Z-bd0131eb",
      detail: "d".repeat(512),
    })),
    rootfs_scanner: { state: "ready", version: "0.56.0" },
    software: {
      project_host: "20261112T035749Z-bd0131eb",
      project_bundle: "20261112T035845Z-bd0131eb",
      tools: "20261106T054333Z-a4ea4605",
    },
    software_inventory: Array.from({ length: 12 }, (_, i) => ({
      artifact: `artifact-${i}`,
      current_version: "20261112T035749Z-bd0131eb",
      current_build_id: "b".repeat(40),
      installed_versions: Array.from({ length: 20 }, (_, j) => `v${j}`),
    })),
    agent_rpc_report_version: 4,
    content_origin_domain: "content.cocalc.example",
  });
}

// Hub-written keys that are also host-owned by decision (ops0 2703): the host
// reports its observed software; the bay's rollback write is provisional.
export const SHARED_HOST_OWNED_METADATA_KEYS = ["software"] as const;

// Matches of the enumeration patterns that are not project_hosts.metadata keys.
// Matches in other tables or contexts (same files) that are not
// project_hosts.metadata keys.
export const NOT_METADATA_KEY_MATCHES = [
  "key",
  "op_id",
  "port",
  "project_host_id",
  "source_host_id",
] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "__tests__", "test"].includes(entry.name)) {
        continue;
      }
      out.push(...sourceFiles(path));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.includes(".test.")
    ) {
      out.push(path);
    }
  }
  return out;
}

// The metadata keys a piece of source text writes, in the detected forms:
// jsonb_set paths (also over COALESCE(metadata, '{}'::jsonb)), `- 'key'`,
// `#- '{key,...}'`, `metadata.key =` and `|| jsonb_build_object('key', ...)`.
export function metadataKeysWrittenIn(text: string): Set<string> {
  const keys = new Set<string>();
  const add = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) keys.add(match[1]);
  };
  add(/jsonb_set\(\s*(?:[^'()]|'\{\}'|\((?:[^'()]|'\{\}')*\))*?,\s*'\{(\w+)/g);
  add(/-\s*'(\w+)'/g);
  add(/#-\s*'\{(\w+)/g);
  add(/\bmetadata\.(\w+)\s*=(?!=)/g);
  for (const call of text.matchAll(/\|\|\s*jsonb_build_object\(([^()]*)\)/g)) {
    for (const match of call[1].matchAll(/'(\w+)'\s*,/g)) keys.add(match[1]);
  }
  return keys;
}

function projectHostSources(): Array<{ file: string; text: string }> {
  const packages = join(__dirname, "..", "..", "..");
  const out: Array<{ file: string; text: string }> = [];
  for (const root of ["server", "database"]) {
    for (const file of sourceFiles(join(packages, root))) {
      const text = readFileSync(file, "utf8");
      if (text.includes("project_hosts")) {
        out.push({ file: relative(packages, file), text });
      }
    }
  }
  return out;
}

// Top-level project_hosts.metadata keys written by server and database code
// in the detected forms.
export function writtenProjectHostMetadataKeys(): Set<string> {
  const keys = new Set<string>();
  for (const { text } of projectHostSources()) {
    for (const key of metadataKeysWrittenIn(text)) keys.add(key);
  }
  return keys;
}

// Files with an `UPDATE project_hosts` that writes the whole metadata object
// from a parameter (a read-modify-write in code, so no key is visible in the
// SQL). Their keys come from the manual inventory; a new such file must be
// reviewed and listed in REVIEWED_WHOLE_METADATA_WRITERS.
export function wholeMetadataWriterFiles(): string[] {
  const files = new Set<string>();
  for (const { file, text } of projectHostSources()) {
    for (const update of text.matchAll(
      /UPDATE\s+project_hosts\b([\s\S]*?)(?:WHERE|RETURNING|`)/gi,
    )) {
      if (/\bmetadata\s*=\s*(?:\$\d+|COALESCE\(\s*\$\d+)/.test(update[1])) {
        files.add(file);
      }
    }
  }
  return [...files].sort();
}

// Every UPDATE/INSERT of project_hosts that touches metadata must be
// classified: keys visible in a detected form, a whole-object parameter write
// (wholeMetadataWriterFiles), or listed here after review. Returns the
// statements that are none of these, as "file: first 60 chars".
export function unclassifiedMetadataStatements(): string[] {
  const out: string[] = [];
  for (const { file, text } of projectHostSources()) {
    for (const statement of text.matchAll(
      /(?:UPDATE\s+project_hosts\b[\s\S]*?(?:WHERE|RETURNING|`|;)|INSERT\s+INTO\s+project_hosts\b[\s\S]*?(?:VALUES|SELECT|`|;))/gi,
    )) {
      const sql = statement[0];
      if (!/\bmetadata\b/.test(sql)) continue;
      if (metadataKeysWrittenIn(sql).size > 0) continue;
      if (/\bmetadata\s*=\s*(?:\$\d+|COALESCE\(\s*\$\d+)/.test(sql)) continue;
      out.push(`${file}: ${sql.split(/\s+/).join(" ").slice(0, 60)}`);
    }
  }
  return out.sort();
}

// Reviewed by hand (076): a parameterized path or a trusted bay insert, never
// a host report.
export const REVIEWED_UNCLASSIFIED_METADATA_STATEMENTS = [
  // upsertProjectHost: the merge this PR guards (host reports reach it only
  // through sanitizeHostReport) and the bay's own upserts.
  "database/postgres/project-hosts.ts: INSERT INTO project_hosts (id, bay_id, name, region, public_",
  // setProjectHostMetadataKey-style helper: path from a bay caller.
  "database/postgres/project-hosts.ts: UPDATE project_hosts SET metadata = jsonb_set( COALESCE(meta",
  // public-route.ts: path is a bay-chosen public-route key.
  "server/cloud/public-route.ts: UPDATE project_hosts SET metadata=jsonb_set(COALESCE(metadat",
  // host create from the bay (cloud lifecycle) and rehome between bays.
  "server/conat/api/hosts-cloud-lifecycle.ts: INSERT INTO project_hosts (id, name, region, status, metadat",
  "server/project-host/rehome.ts: INSERT INTO project_hosts (id, bay_id, name, region, public_",
] as const;

export const REVIEWED_WHOLE_METADATA_WRITERS = [
  "server/conat/api/hosts-cloud-lifecycle.ts",
  "server/conat/api/hosts-project-host-rollbacks.ts",
  "server/conat/api/hosts.ts",
  "server/conat/host-registry.ts",
  "server/hosts/start-worker.ts",
  "server/launchpad/onprem-sshd.ts",
  "server/project-host/auto-grow.ts",
  "server/self-host/connector-tokens.ts",
  "server/self-host/ssh-target.ts",
] as const;

// master.ts must assemble the report with the pure builders, so that the
// fixture above is the real assembly: basePayload.metadata is a call to
// buildHostBaseMetadata and buildPayload's returned metadata a call to
// buildHostReportMetadata.
export function masterUsesReportBuilders(): boolean {
  const path = join(__dirname, "..", "..", "..", "project-host", "master.ts");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const calls = new Set<string>();
  const metadataCall = (object: ts.ObjectLiteralExpression) => {
    for (const property of object.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "metadata" &&
        ts.isCallExpression(property.initializer) &&
        ts.isIdentifier(property.initializer.expression)
      ) {
        return property.initializer.expression.text;
      }
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      if (
        node.name.text === "basePayload" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const call = metadataCall(node.initializer);
        if (call) calls.add(`basePayload:${call}`);
      }
      if (
        node.name.text === "buildPayload" &&
        ts.isArrowFunction(node.initializer)
      ) {
        const visitReturn = (inner: ts.Node) => {
          if (
            ts.isReturnStatement(inner) &&
            inner.expression &&
            ts.isObjectLiteralExpression(inner.expression)
          ) {
            const call = metadataCall(inner.expression);
            if (call) calls.add(`buildPayload:${call}`);
          }
          ts.forEachChild(inner, visitReturn);
        };
        visitReturn(node.initializer.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return (
    calls.size === 2 &&
    calls.has("basePayload:buildHostBaseMetadata") &&
    calls.has("buildPayload:buildHostReportMetadata")
  );
}
