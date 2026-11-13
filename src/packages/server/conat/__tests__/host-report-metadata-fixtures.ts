/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared by host-report-metadata.test.ts and host-registry.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
// metadataStatements() fails closed on any statement whose keys it cannot
// see. Not detected: keys set in code before such a
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

// Every UPDATE/INSERT of project_hosts that touches metadata. A statement is
// classified only when its metadata keys are all visible in a detected form:
// it writes at least one detected key and has no parameter-supplied part (a
// `|| $N` merge, a jsonb_set path from `ARRAY[$N]`, or a whole-object
// `metadata = $N`), which could write any key. Every other statement must be
// listed in REVIEWED_METADATA_STATEMENTS by file and the sha256 of its
// whitespace-normalized text, so any change to it needs a new review.
export function metadataStatementClassified(sql: string): boolean {
  const parameterPart =
    /\|\|\s*(?:COALESCE\(\s*)?\$\d+/.test(sql) ||
    /ARRAY\[\s*\$\d+/.test(sql) ||
    /\bmetadata\s*=\s*(?:\$\d+|COALESCE\(\s*\$\d+)/.test(sql) ||
    /^\s*INSERT/i.test(sql);
  return metadataKeysWrittenIn(sql).size > 0 && !parameterPart;
}

export function metadataStatements(): Array<{
  file: string;
  sha256: string;
  text: string;
  classified: boolean;
}> {
  const out: Array<{
    file: string;
    sha256: string;
    text: string;
    classified: boolean;
  }> = [];
  for (const { file, text } of projectHostSources()) {
    for (const statement of text.matchAll(
      /(?:UPDATE\s+project_hosts\b[\s\S]*?(?:WHERE|RETURNING|`|;)|INSERT\s+INTO\s+project_hosts\b[\s\S]*?(?:VALUES|SELECT|`|;))/gi,
    )) {
      const sql = statement[0].split(/\s+/).join(" ");
      if (!/\bmetadata\b/.test(sql)) continue;
      out.push({
        file,
        sha256: createHash("sha256").update(sql).digest("hex"),
        text: sql,
        classified: metadataStatementClassified(sql),
      });
    }
  }
  return out;
}

export function unclassifiedMetadataStatements(): string[] {
  return metadataStatements()
    .filter(({ classified }) => !classified)
    .map(({ file, sha256 }) => `${file}#${sha256}`)
    .sort();
}

// Reviewed for 076 by file and exact statement hash (whitespace-normalized);
// a changed or new statement fails the test until it is reviewed again.
export const REVIEWED_METADATA_STATEMENTS: readonly string[] = [
  // a bay-side insert of a new or rehomed host (no host report)
  "server/conat/api/hosts-cloud-lifecycle.ts#5624d089b9aad8c2f7193a614b9cc09b15dad4afd844ebc4193f1c9df68d50a2",
  "server/project-host/rehome.ts#376437c537233dc224b77681407c3598022830d40d8a963c3802eb24c45a7ea8",
  // a parameter merged into ONE bay-owned subtree (its path is literal); cannot set another top-level key
  "server/cloud/host-dns-reconciliation.ts#4004b84f8783f4a685444a36f62249e2ec028f8b066d89cdb8d033fe99f5d914",
  "server/conat/host-registry.ts#e1753a0b8c9e476fd201fb5cec136c26afd50c2f1843654e315565d9bd3892b2",
  // jsonb_set with a path chosen by bay code (no host report)
  "database/postgres/project-hosts.ts#bb76d941ba157d55c73d0b7ac6c6ae382f69bd4b5f16b3f70bd7a019772cda0e",
  "server/cloud/public-route.ts#5cc1b0c0ee00d93b388217d95d7918511edf8e6fc5f1c67c3d0a15067e226999",
  // the bay's read-modify-write of the whole metadata object (keys set in code; listed in BAY_OWNED_METADATA_KEYS by manual check)
  "server/conat/api/hosts-cloud-lifecycle.ts#2c429b7441156a413bbbaa04eecb61145fa935f4f68d3ba87bc2bd063f0362ec",
  "server/conat/api/hosts-cloud-lifecycle.ts#2c429b7441156a413bbbaa04eecb61145fa935f4f68d3ba87bc2bd063f0362ec",
  "server/conat/api/hosts-cloud-lifecycle.ts#2c429b7441156a413bbbaa04eecb61145fa935f4f68d3ba87bc2bd063f0362ec",
  "server/conat/api/hosts-cloud-lifecycle.ts#6f216e9b79a30bf7c581cd88189034d2f76aa1040d68f14bd443a3d9be955daa",
  "server/conat/api/hosts-cloud-lifecycle.ts#6f216e9b79a30bf7c581cd88189034d2f76aa1040d68f14bd443a3d9be955daa",
  "server/conat/api/hosts-project-host-rollbacks.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  "server/conat/api/hosts-project-host-rollbacks.ts#90d0b097fb2b2b4513988ae01873c1a044c2dfe2e6484c9a9db9e671d725931e",
  "server/conat/api/hosts.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  "server/conat/api/hosts.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  "server/conat/api/hosts.ts#6be39f00941fa3ee8d848b1324d629b085b11ca9f5d025704fcdbe2fcd58dec5",
  "server/conat/api/hosts.ts#90d0b097fb2b2b4513988ae01873c1a044c2dfe2e6484c9a9db9e671d725931e",
  "server/conat/api/hosts.ts#90d0b097fb2b2b4513988ae01873c1a044c2dfe2e6484c9a9db9e671d725931e",
  "server/conat/api/hosts.ts#b22ac8f052ac48eb692978dcfe60224da14babcbb5442b42a73a8bea29500e74",
  "server/conat/api/hosts.ts#b22ac8f052ac48eb692978dcfe60224da14babcbb5442b42a73a8bea29500e74",
  "server/conat/host-registry.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  "server/hosts/start-worker.ts#9b766fe4d66ab8e45e344a96683b9497f498e29cda11c5eeb69688dc9271ec8e",
  "server/hosts/start-worker.ts#e172036149302da35dc713f1f0f997567b6cc3161913fd0c33f66331f0f0efdc",
  "server/hosts/start-worker.ts#e172036149302da35dc713f1f0f997567b6cc3161913fd0c33f66331f0f0efdc",
  "server/launchpad/onprem-sshd.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  "server/project-host/auto-grow.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  "server/project-host/auto-grow.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  "server/self-host/connector-tokens.ts#b22ac8f052ac48eb692978dcfe60224da14babcbb5442b42a73a8bea29500e74",
  "server/self-host/ssh-target.ts#13f44ca740c7049384c19aa1b25918380a40210dba67c8dcb5bb352fb0e06d06",
  // upsertProjectHost: the merge #156 guards (host reports pass sanitizeHostReport first) and the bay's own upserts
  "database/postgres/project-hosts.ts#83c41f18afec85d38dabe14e1ea0682da730aff1915113f64f6ac68aa68e6d55",
];

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
