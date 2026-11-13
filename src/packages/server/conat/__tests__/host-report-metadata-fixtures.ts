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

// Every SQL template in server/database code that writes
// project_hosts.metadata: an UPDATE of project_hosts that assigns metadata,
// or an INSERT into project_hosts that names the metadata column. The whole
// string or template literal is taken (including VALUES, ON CONFLICT and
// WHERE parts), whitespace-normalized and hashed; each must be listed in
// REVIEWED_METADATA_WRITE_TEMPLATES, so a new or changed write fails the
// test until it is reviewed. Limits: a `${...}` interpolation is hashed as
// its source text, not its runtime value; SQL built by concatenating
// separate strings is seen piece by piece. The keys such a write sets in code
// come from the manual inventory (BAY_OWNED_METADATA_KEYS).
export function metadataWriteTemplates(): Array<{
  file: string;
  sha256: string;
  text: string;
}> {
  const out: Array<{ file: string; sha256: string; text: string }> = [];
  for (const { file, text } of projectHostSources()) {
    // String and template literals as the TypeScript parser sees them, so a
    // stray quote or backtick in a comment cannot shift the boundaries.
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const literals: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        literals.push(node.text);
      } else if (ts.isTemplateExpression(node)) {
        // The template's source, with each ${...} as written.
        literals.push(node.getText(source).slice(1, -1));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const body of literals) {
      const sql = body.split(/\s+/).join(" ").trim();
      const update =
        /\bUPDATE\s+project_hosts\b/i.test(sql) &&
        /\bSET\b[\s\S]*\bmetadata\s*=/i.test(sql);
      const insert = /\bINSERT\s+INTO\s+project_hosts\b[^)]*\bmetadata\b/i.test(
        sql,
      );
      if (!update && !insert) continue;
      out.push({
        file,
        sha256: createHash("sha256").update(sql).digest("hex"),
        text: sql,
      });
    }
  }
  return out;
}

export function metadataWriteTemplateIds(): string[] {
  return metadataWriteTemplates()
    .map(({ file, sha256 }) => `${file}#${sha256}`)
    .sort();
}

// Reviewed for 076 by file and the sha256 of the whole whitespace-normalized
// template (comment = what the template writes). A new or changed metadata
// write fails the test until it is reviewed and listed here.
export const REVIEWED_METADATA_WRITE_TEMPLATES: readonly string[] = [
  // insert: INSERT INTO project_hosts (id, bay_id, name, region, public_url, inter
  "database/postgres/project-hosts.ts#0ab6e94214cc544aa1dc2802d88a159757ec166eded3d55b3c9b55bee28161bc",
  // jsonb_set with a bay-chosen path: UPDATE project_hosts SET metadata = jsonb_set( COALESCE(metadata, '{}'
  "database/postgres/project-hosts.ts#a86776df0338fd5d1798bd2bde1786300f76175358e64ddd6f58933f55846030",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set( jsonb_set( jsonb_set( j
  "server/cloud/db.ts#fe322cbcf23fa323e5b458d64d6cc5961bc7c677e47eeae8e37da696a092a4de",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set(COALESCE(metadata, '{}':
  "server/cloud/host-content-dns.ts#d9ec4504581fc9ca972fb351bdd4f3023744bab86cb4b84c1f5a3cc639e83b4b",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = COALESCE(metadata, '{}'::jsonb) -
  "server/cloud/host-content-dns.ts#f307e5d7991677fbecb93d62ec0f3fa75c42b9bdefc5169fd47b45b733346b3f",
  // literal paths / key removals (keys visible in the SQL): WITH updated AS ( UPDATE project_hosts SET metadata=jsonb_set( COALESC
  "server/cloud/host-dns-reconciliation.ts#6a0a8374186a710b4690eb4108c2f71ec5f2488ef10f4586871683db9912aec1",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/cloud/host-dns-reconciliation.ts#75e60b5930ec823bf1ceb8c9550c0af759e265a56ccd6711aa3e994f18bf78a5",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( jsonb_set( COALESCE(metad
  "server/cloud/host-dns-reconciliation.ts#8f3b7c8815c10b9f151ee94fd76aa1f9a7996e7769f609fb725c098e16e5d49d",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set(metadata, '{spot_recover
  "server/cloud/host-work.ts#92b4e368305bf0a08159dd7fc78ee9894ef6923057d9b1e9f3ee3c7c4ab9241e",
  // jsonb_set with a bay-chosen path: UPDATE project_hosts SET metadata=jsonb_set(COALESCE(metadata, '{}'::j
  "server/cloud/public-route.ts#010d0158551ad3064218de2dd25ca2667aaf03e90739a12d8b1e594c715c2ea1",
  // insert: INSERT INTO project_hosts (id, name, region, status, metadata, created
  "server/conat/api/hosts-cloud-lifecycle.ts#5dd89212ba88c2c7cb669193fc4120a421af78bfb98e928dc1ea903a9ffd6de8",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated
  "server/conat/api/hosts-cloud-lifecycle.ts#c0b5d44e693f9e6eab5982d3e8c6db598e518643b9e43333e83bc4dce57cd13a",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated
  "server/conat/api/hosts-cloud-lifecycle.ts#c0b5d44e693f9e6eab5982d3e8c6db598e518643b9e43333e83bc4dce57cd13a",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, ${BUMP_
  "server/conat/api/hosts-cloud-lifecycle.ts#d7536d40339daf05a656e69a61565ed88429ff4bb8073dea7a3fe0cb4162d8ea",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, ${BUMP_
  "server/conat/api/hosts-cloud-lifecycle.ts#d7536d40339daf05a656e69a61565ed88429ff4bb8073dea7a3fe0cb4162d8ea",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, ${BUMP_
  "server/conat/api/hosts-cloud-lifecycle.ts#d7536d40339daf05a656e69a61565ed88429ff4bb8073dea7a3fe0cb4162d8ea",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/conat/api/hosts-project-host-rollbacks.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW() WHERE
  "server/conat/api/hosts-project-host-rollbacks.ts#99c47f72ba917d07d6853d63b8ae8a88d0f2a5f1227fb7bbc31c7044dfa6abaf",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET status=$2, metadata=(jsonb_set(COALESCE(metad
  "server/conat/api/hosts.ts#0e3c5ee740435b2f828f70f1ca92b1d727ff42f0bfcd6e2e94cec8d9e009897c",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/conat/api/hosts.ts#1b24d4930de2c14cd88056ae805aa65775e712f552e70090e7014f0822fccff8",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/conat/api/hosts.ts#1b24d4930de2c14cd88056ae805aa65775e712f552e70090e7014f0822fccff8",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set(metadata - 'machine_chan
  "server/conat/api/hosts.ts#4bdff3b951a1fbc3b701d6c6f87f9e6d9c25e658fcd680a3e8d65dac38b15676",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = metadata - 'machine_change_pending
  "server/conat/api/hosts.ts#4e084d1222b2f77825ce285cb9ec24c44e601def0515ebcf7f1d1cbfc121e9bd",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() WHERE i
  "server/conat/api/hosts.ts#766a56b06329a1453d14212f1d6a3bfc3903c5ccd4a709644696fda653915865",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() WHERE i
  "server/conat/api/hosts.ts#766a56b06329a1453d14212f1d6a3bfc3903c5ccd4a709644696fda653915865",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set( jsonb_set( jsonb_set( j
  "server/conat/api/hosts.ts#76f01c50207c8ad12e3d9605c310d2f1bdfe8f197d4b8a8e63fde3f6c0a460da",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW() WHERE
  "server/conat/api/hosts.ts#99c47f72ba917d07d6853d63b8ae8a88d0f2a5f1227fb7bbc31c7044dfa6abaf",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW() WHERE
  "server/conat/api/hosts.ts#99c47f72ba917d07d6853d63b8ae8a88d0f2a5f1227fb7bbc31c7044dfa6abaf",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET status=$2, public_url=NULL, internal_url=NULL
  "server/conat/api/hosts.ts#bee52af18ccd5dc30737155f59ade94b1625c20fc5d796573b8424b3d07f83cb",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set(COALESCE(metadata, '{}':
  "server/conat/api/hosts.ts#ccdfef18b77f13b8dbfefd0da6b11459bf34b0786e2afa225d5868da766ac679",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set( COALESCE(metadata, '{}'
  "server/conat/api/hosts.ts#db24445d54292f78baa3d7512cb4b4858059b84a710584f63188ee1165f7ec27",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/conat/host-registry.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set(COALESCE(metadata, '{}'::j
  "server/conat/host-registry.ts#67636f5567a8b610d058c3d2d60f97b81069a8102f13154c55063206a7e90619",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/conat/host-registry.ts#744587298aaa93d1036be81e66d432753f330e8bb133efdae29f6fbfd1951529",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET status='starting', last_seen=NULL, metadata=j
  "server/conat/host-registry.ts#7debb80fcd0df58b0be279ec2e232daab2d49cf07dbb2cbc76d985ad334fa8e3",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set(COALESCE(metadata, '{}':
  "server/hosts/desired-state.ts#af39d76416af7923939dea6133a594d8bf3a02bb92db43f8276b64839d4a387c",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#2ccd7062a2e1b0b34d57caa14f54119dd613859446b30f11f0a0591a595c380d",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#308edd67b760b2b42c1c1071bfc26a8b4ea8bb6bda579d2277a9ca4eead49b5b",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#326a0ee8a3eab59a536ae59ece86a54fdb7d8b7a1a9276b68378e90f7b127d20",
  // literal paths / key removals (keys visible in the SQL): WITH fleet_lock AS ( SELECT pg_try_advisory_xact_lock($8::bigint) AS a
  "server/hosts/runtime-maintenance.ts#427bd2755c1740198f66f28dd6b1d1259d231688f930eb7c222d31d01bb07632",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts AS target SET metadata=jsonb_set( jsonb_set( COAL
  "server/hosts/runtime-maintenance.ts#50f5d0dedbab7df547946820009172979dc27d2172808c658fb7dbd535f1a713",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#5c74c2d1b59942ef23b6f34c9fc80061e8e2ab8b22e7b80293194b41ed9911a3",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#78fe5ba344558195b12297da294967c2716338d145881a5da2b1fa6c3e8da9af",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#a15ab1c18f6b4b902ac0c4b899bfa8ee26bf0cdf5deba58925e76a9c3b7bc5b5",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#a879a40e5124fc4766075c8a10deff6f011008f158804005e6e954f03f12514c",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata, '{}'::
  "server/hosts/runtime-maintenance.ts#cc0b6af4cc99e1985704af7b4871ca23528adde913b467ec0ecd18d2f096adf8",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set( COALESCE(metadata, '{}'
  "server/hosts/runtime-transition.ts#6760bf4fa7f8cf95c0a49979da605ad7204f00bc547f12449c77fab90d175e25",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set( jsonb_set( COALESCE(met
  "server/hosts/runtime-transition.ts#f2037c531c30a08ee4f870055eac76d5205da49661ac52c7f2f1f01b7acb8c64",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, ${BUMP_DESIRED_STATE_GENERATION}
  "server/hosts/start-worker.ts#3bfacbd091c9f841af2f15e468791faea8e20804fe99a0777512db9fad29d2e4",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, ${BUMP_DESIRED_STATE_GENERATION}
  "server/hosts/start-worker.ts#3bfacbd091c9f841af2f15e468791faea8e20804fe99a0777512db9fad29d2e4",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, region=COALESCE($3, region), upd
  "server/hosts/start-worker.ts#780580083a93289bf6b5941350448051cd100a34192dc05ea793ca392038c6a1",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET status='deprovisioning', metadata = jsonb_set
  "server/hosts/start-worker.ts#c304c2e8858f79a719e620e40d3d85db3499ec787d35069eac936cb0533fb523",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/launchpad/onprem-sshd.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/project-host/auto-grow.ts#7cea44fd6bd1b91978ccad88ac2f9638f0f51e1cc07b9b0b40bea5b3b79d08aa",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/project-host/auto-grow.ts#7cea44fd6bd1b91978ccad88ac2f9638f0f51e1cc07b9b0b40bea5b3b79d08aa",
  // insert: INSERT INTO project_hosts (id, bay_id, name, region, public_url, inter
  "server/project-host/rehome.ts#adb3250c592827b30ae6ae7e1a2213f25d629e637e49beb2a21d0fd58e87e076",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = metadata #- '{billing,enforcement,
  "server/project-host/spend-maintenance.ts#52146903eb35de1ac8bdbae5d7e80266d9639196802889cdb017ca634eb8d978",
  // literal paths / key removals (keys visible in the SQL): UPDATE project_hosts SET metadata = jsonb_set( metadata, '{billing,enf
  "server/project-host/spend-maintenance.ts#5c5238b67f8e30d656c8eec20456196c0c57d0ee74ba688b0927ee0c611d17d7",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() WHERE i
  "server/self-host/connector-tokens.ts#766a56b06329a1453d14212f1d6a3bfc3903c5ccd4a709644696fda653915865",
  // whole-object read-modify-write (keys set in code: manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND de
  "server/self-host/ssh-target.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
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
