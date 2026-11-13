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
  // machine.metadata.* fields of a create-host request, nested under
  // `machine` (frontend/hosts/providers/registry.ts buildCreatePayload)
  "cpu",
  "ram_gb",
  "self_host_kind",
  "self_host_mode",
  "self_host_ssh_target",
  "key",
  "op_id",
  "port",
  "project_host_id",
  "source_host_id",
] as const;

// Directories never scanned: dependencies, build output (dist, dist-release,
// dist-types, dist-ts, build, .next), coverage, and tests (which hold the
// negative controls themselves).
const SKIPPED_DIRECTORIES =
  /^(node_modules|dist|dist-[a-z]+|build|\.next|coverage|__tests__|test)$/;
// Package roots never scanned: only dependencies and build output (a package
// named "test" is scanned; test directories inside packages are not).
const SKIPPED_PACKAGES =
  /^(node_modules|dist|dist-[a-z]+|build|\.next|coverage)$/;
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.test(entry.name)) continue;
      out.push(...sourceFiles(path));
    } else if (
      SOURCE_FILE.test(entry.name) &&
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

const PACKAGES = join(__dirname, "..", "..", "..");

// Every package is scanned (security-audit 2748, ops0 2735): a bay write can
// live outside server/database (hub/servers/app/self-host-connector.ts).
export function scannedPackageRoots(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !SKIPPED_PACKAGES.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

function projectHostSources(): Array<{ file: string; text: string }> {
  const packages = PACKAGES;
  const out: Array<{ file: string; text: string }> = [];
  for (const root of scannedPackageRoots()) {
    for (const file of sourceFiles(join(packages, root))) {
      const text = readFileSync(file, "utf8");
      if (/project_hosts/i.test(text)) {
        out.push({ file: relative(packages, file), text });
      }
    }
  }
  return out;
}

// Top-level project_hosts.metadata keys written by code in any package that
// mentions project_hosts, in the detected forms.
export function writtenProjectHostMetadataKeys(): Set<string> {
  const keys = new Set<string>();
  for (const { text } of projectHostSources()) {
    for (const key of metadataKeysWrittenIn(text)) keys.add(key);
  }
  return keys;
}

// Every SQL template, in any package's code that mentions project_hosts
// (any case), that may write project_hosts.metadata. Over-inclusively, every
// string or template literal that
// - mentions project_hosts (any case, schema prefix or quoting) and metadata,
//   reads included; or
// - mentions project_hosts and UPDATE or INSERT and has a `${...}`: a
//   statement whose SET or VALUES part is built in code (vanta, ops0 2735
//   G2a), e.g. `UPDATE project_hosts SET ${sets.join(", ")}`; or
// - assigns NEW.metadata or `metadata :=` (a trigger body, G2c).
// The whole string or template literal is taken (including VALUES, ON
// CONFLICT and WHERE parts), whitespace-normalized and hashed; each must be
// listed in REVIEWED_METADATA_WRITE_TEMPLATES, so a new or changed write
// fails the test until it is reviewed. The fragments that builders push into
// dynamic statements are pinned by function body in
// REVIEWED_METADATA_BUILDERS. Limits: a `${...}` interpolation is hashed as
// its source text, not its runtime value; SQL built by concatenating
// separate strings is seen piece by piece; a builder outside the named list
// is seen only through its statement's pin; the file prefilter reads raw
// text, so a name written with escapes (`project\x5fhosts`) skips the file.
// The keys such a write sets in code come from the manual inventory
// (BAY_OWNED_METADATA_KEYS).
export function metadataWriteTemplates(): Array<{
  file: string;
  sha256: string;
  text: string;
}> {
  return projectHostSources().flatMap(({ file, text }) =>
    metadataWriteTemplatesIn(file, text),
  );
}

// The metadata write templates in one source text (see metadataWriteTemplates).
export function metadataWriteTemplatesIn(
  file: string,
  text: string,
): Array<{ file: string; sha256: string; text: string }> {
  const out: Array<{ file: string; sha256: string; text: string }> = [];
  {
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
      // Over-inclusive on purpose (ops0 2728): any literal that mentions
      // project_hosts (any schema prefix or quoting) and metadata, case-folded
      // with quotes removed, is pinned; reads are pinned too.
      const folded = sql.toLowerCase().replace(/["`]/g, "");
      const table = folded.includes("project_hosts");
      const selected =
        (table && folded.includes("metadata")) ||
        (table && /\b(update|insert)\b/.test(folded) && sql.includes("${")) ||
        /\bnew\.metadata\b|\bmetadata\s*:=/.test(folded);
      if (!selected) continue;
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
// template (comment = what the template does). A new or changed selected
// template fails the test until it is reviewed. The comparison is a MULTISET
// (sorted lists, counts included): a template that occurs twice in a file is
// listed twice, so a third copy also fails.
export const REVIEWED_METADATA_WRITE_TEMPLATES: readonly string[] = [
  // schema (mentions project_hosts and metadata): CREATE TABLE IF NOT EXISTS project_host_metrics_samples ( host_i
  "database/postgres/project-host-metrics.ts#4dcd82e3e69b4c58340a7336e809327aaa13f81053ec123d740650453714fa37",
  // READ (pinned because detection is over-inclusive): WITH relevant_hosts AS ( SELECT h.id, h.name FROM project_hosts
  "database/postgres/project-host-metrics.ts#633760eba352cbfde4a81f4c6fea16692dfb940615c4245063b6a8bc9cde4076",
  // schema (mentions project_hosts and metadata): CREATE TABLE IF NOT EXISTS project_host_runtime_deployments ( sc
  "database/postgres/project-host-runtime-deployments.ts#658c7eede05b6ac311b99ee92db6c29db3684870498d093448d92c3954b0f52e",
  // WRITE: insert: INSERT INTO project_hosts (id, bay_id, name, region, public_url,
  "database/postgres/project-hosts.ts#0ab6e94214cc544aa1dc2802d88a159757ec166eded3d55b3c9b55bee28161bc",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set( COALESCE(metadata
  "database/postgres/project-hosts.ts#a86776df0338fd5d1798bd2bde1786300f76175358e64ddd6f58933f55846030",
  // TRIGGER (G2c): the desired_state guard logs to cloud_vm_log; reads OLD/NEW.metadata->desired_state
  "database/postgres/schema/project-host-desired-state.ts#15f2d2c016e053a0fb216207b05e821631ba1ef6cb1c61b6e8493d04ccf47258",
  // TRIGGER (G2c): the desired_state guard reverts an unversioned change: NEW.metadata := jsonb_set(..., '{desired_state}', OLD ...) or - 'desired_state'
  "database/postgres/schema/project-host-desired-state.ts#90f56eb6c7f72d0ee2dd04a8729b87484c148b6a8a3d0bf65c762295e5308e5f",
  // TRIGGER (G2c): CREATE OR REPLACE FUNCTION project_hosts_guard_desired_state; body ${onUnversionedChange} (pinned above, and desiredStateGuardFunctionSql in REVIEWED_METADATA_BUILDERS)
  "database/postgres/schema/project-host-desired-state.ts#bcf4c58053a76e07c397e3687dc5e7e400282417f8e9285ffb7af7bda250125f",
  // schema: CREATE TRIGGER (desired_state guard) BEFORE UPDATE ON project_hosts
  "database/postgres/schema/project-host-desired-state.ts#e469a68ffeab29cccade1cc0a02970932e077522fc4c9210a46ba80025c7571b",
  // READ (pinned because detection is over-inclusive): proxy route lookup, project -> project_hosts incl. metadata
  "hub/proxy/project-host.ts#8e9bf79004c41f85f7db351c3ecfd65e3281d81dc6b7588fe1422db13a4a8687",
  // READ (pinned because detection is over-inclusive): proxy route lookup by host id incl. metadata
  "hub/proxy/project-host.ts#c49b51129b254379fd36e0dfaaab361a8214398760f12691b15b264cb5ce1c0f",
  // READ (pinned because detection is over-inclusive): self-host hosts of a connector (metadata->>'owner')
  "hub/servers/app/self-host-connector.ts#a2d7947f1dd3a36ad29235490a236ed47cdf3ba77696def981f7a54ee8df7edc",
  // WRITE whole object (maybeAutoStartHost): metadata=$4 = the row read above with self_host updated and bootstrap removed
  "hub/servers/app/self-host-connector.ts#c0b5d44e693f9e6eab5982d3e8c6db598e518643b9e43333e83bc4dce57cd13a",
  // READ (pinned because detection is over-inclusive): SELECT metadata->'agent_rpc_report'->>'version' AS version, meta
  "server/agents/rpc.ts#d00c12d810ea16b9399c53b38030abe9152adc1ea44968671a1e4f5a5121e8c2",
  // READ (pinned because detection is over-inclusive): SELECT metadata #>> '{machine,zone}' AS zone FROM project_hosts
  "server/bay-backup/index.ts#718a29be3d3092f54cf69d0f131a21da040b216aa39b9244592862fa8ddc9d01",
  // READ (pinned because detection is over-inclusive): SELECT id, name, metadata FROM project_hosts WHERE deleted IS NU
  "server/cloud/cloudflare-teardown.ts#3bd503f61df04c073f07de6cfa835820de97d84cd9023dd5dec54715a500dca5",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set( jsonb_set( jsonb_
  "server/cloud/db.ts#fe322cbcf23fa323e5b458d64d6cc5961bc7c677e47eeae8e37da696a092a4de",
  // READ (pinned because detection is over-inclusive): SELECT DISTINCT metadata->'content_dns'->>'domain' AS domain FRO
  "server/cloud/host-content-dns.ts#589da91b4165206842d9e208bfc9e11e158d3ea82ac79c1c8d3689a5a58b8ed6",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set(COALESCE(metadata,
  "server/cloud/host-content-dns.ts#d9ec4504581fc9ca972fb351bdd4f3023744bab86cb4b84c1f5a3cc639e83b4b",
  // READ (pinned because detection is over-inclusive): SELECT status, deleted, COALESCE(bay_id, $2) AS bay_id, metadata
  "server/cloud/host-content-dns.ts#dc5628d45ede68600c8ab32e65668d443a1eeb30307dd73a4d06ea756a90370f",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, metadata FROM project_hosts WHERE id
  "server/cloud/host-content-dns.ts#f24a625916eae7b36089dacbd688f73789b863a6df5e141cdb175c5da7899f4b",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = COALESCE(metadata, '{}'::jso
  "server/cloud/host-content-dns.ts#f307e5d7991677fbecb93d62ec0f3fa75c42b9bdefc5169fd47b45b733346b3f",
  // READ (pinned because detection is over-inclusive): SELECT id FROM project_hosts WHERE deleted IS NULL AND status='r
  "server/cloud/host-dns-reconciliation.ts#2b2c5ca7b9bcaf9bdb630636245597440dacf066e14e94748ac5812c825ffe3b",
  // WRITE: keys visible in the SQL: WITH updated AS ( UPDATE project_hosts SET metadata=jsonb_set( C
  "server/cloud/host-dns-reconciliation.ts#6a0a8374186a710b4690eb4108c2f71ec5f2488ef10f4586871683db9912aec1",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/cloud/host-dns-reconciliation.ts#75e60b5930ec823bf1ceb8c9550c0af759e265a56ccd6711aa3e994f18bf78a5",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( jsonb_set( COALESCE
  "server/cloud/host-dns-reconciliation.ts#8f3b7c8815c10b9f151ee94fd76aa1f9a7996e7769f609fb725c098e16e5d49d",
  // READ (pinned because detection is over-inclusive): WITH active AS ( SELECT id, name, metadata FROM project_hosts WH
  "server/cloud/host-dns-reconciliation.ts#c231558fee76715b7c2913d026bea4357ff140ab84d31ff4545db055452510be",
  // READ (pinned because detection is over-inclusive): SELECT id, name, region, status, bay_id, ssh_server, metadata FR
  "server/cloud/host-dns-reconciliation.ts#d31a211c363336e315b0a6f94a20645217742bd679c4d0eaf60efebd024473f7",
  // WRITE, dynamic SET list built in code (may include the whole metadata object from code): manual inventory: UPDATE project_hosts SET ${[...sets, "updated=NOW()"].join(", ")
  "server/cloud/host-work.ts#0838ee0556648489f709ac7e824133c5535f61abfa3a94d5c7c297809d47d8ec",
  // DYNAMIC WRITE (G2a): SET from buildHostUpdate (metadata via metadataPatchAssignment); in transitionAndQueueRecoveryStart
  "server/cloud/host-work.ts#228ba4a0407c4689bd89fafc4e7dd370949bfb7983a55ed47611a7d5c5d61532",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set(metadata, '{spot_r
  "server/cloud/host-work.ts#92b4e368305bf0a08159dd7fc78ee9894ef6923057d9b1e9f3ee3c7c4ab9241e",
  // DYNAMIC WRITE (G2a): SET from buildHostUpdate (metadata via metadataPatchAssignment); in updateHostRow
  "server/cloud/host-work.ts#d9fcc7bf68699e8381e646623b6e8d6515a5d38b194e86b61a36896449867606",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set(COALESCE(metadata, '
  "server/cloud/public-route.ts#010d0158551ad3064218de2dd25ca2667aaf03e90739a12d8b1e594c715c2ea1",
  // READ (pinned because detection is over-inclusive): SELECT id, name, region, status, public_url, internal_url, ssh_s
  "server/cloud/public-route.ts#b16c9a64b3871afc5e8d21c8071de63e6b719977b9cd61e672129a1acf8b5852",
  // DYNAMIC WRITE (G2a): SET from updateHostFromProviderSnapshot (metadata = jsonb_set chain over '{runtime}', '{spot_recovery_state}')
  "server/cloud/reconcile.ts#567bec5628f56c47f7d32c57bc825345d31cd5829542446c08aa97381d7c1d5a",
  // READ (pinned because detection is over-inclusive): SELECT id, name, status, deleted, metadata FROM project_hosts WH
  "server/cloud/reconcile.ts#89a768e34d7d458ba7c224d6ad977f27715f4dd43b35b4136068be36e4074e53",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, last_seen, metadata FROM project_hos
  "server/cloud/reconcile.ts#a56ff2eb85d9c23adf9c3e04fee407f7627f1a5f11d9015a934d2369be902095",
  // READ (pinned because detection is over-inclusive): SELECT id, name, status, region, metadata, maintenance, public_u
  "server/cloud/reconcile.ts#c7ba7b9e9652856d10e98faf01e5c15fc0680f4eaed461926e52cc64b559aa5f",
  // READ (pinned because detection is over-inclusive): SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='ru
  "server/cloud/reconcile.ts#e0cce0cfb883cf6040dd64b243b47daf6dcaac20635cfa22cf14b8a997888eeb",
  // READ (pinned because detection is over-inclusive): SELECT id, metadata, last_seen FROM project_hosts WHERE deleted
  "server/cloud/rootfs-prepull.ts#54eb45aceabf1743e8d7af06f13ba46199cb6db79be193a239ee7091bc094c82",
  // READ (pinned because detection is over-inclusive): SELECT public_url, internal_url, metadata FROM project_hosts WHE
  "server/cloud/smoke-runner/project-host.ts#123bb1bfe0a93a2840f97ce277b3f05330db0c5bc0decfd93dec905e922f6c37",
  // READ (pinned because detection is over-inclusive): SELECT status, metadata FROM project_hosts WHERE id=$1 AND delet
  "server/cloud/smoke-runner/project-host.ts#186ba459093b7d359a9600f3f168616ad559a17b8ca2313e23eceae753c29407",
  // READ (pinned because detection is over-inclusive): SELECT name, region, metadata FROM project_hosts WHERE id=$1 AND
  "server/cloud/smoke-runner/project-host.ts#26c11449bbc2f0ffaa570d24fa382a64c1d54e86062cccf6b3e501d81f46407d",
  // READ (pinned because detection is over-inclusive): SELECT name, status, metadata FROM project_hosts WHERE id=$1 AND
  "server/cloud/smoke-runner/project-host.ts#33898f3b5f0479da4ee0558c3a2eaf946dda8d4a1becae7f6f6c8492e180f8be",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/cloud/smoke-runner/self-host.ts#f0c3c8a22489bdb6ae7e2a98f20511369b299f3702f8ebc4834744fc1b883bd0",
  // READ (pinned because detection is over-inclusive): SELECT id, metadata FROM project_hosts WHERE metadata->'runtime'
  "server/cloud/worker.ts#2155dd0a7b24c3a3213cfdba6bcfeabc6df50e4859582a5c0d66cae85c1c99b5",
  // READ (pinned because detection is over-inclusive): SELECT id AS host_id, name, bay_id, region, status, last_seen, n
  "server/conat/api/admin-db.ts#3d2a5976a2b7f72af7d0e381b218d8bfc5e1d5ee4bce74ae9155c63628512563",
  // READ (pinned because detection is over-inclusive): SELECT status, deleted, metadata FROM project_hosts WHERE id=$1
  "server/conat/api/hosts-bootstrap-reconcile.ts#fa779cd1b7917aa5a097dbd26e3134d99204adeab9524bd02abd5cb8d76be73a",
  // WRITE: insert: INSERT INTO project_hosts (id, name, region, status, metadata, c
  "server/conat/api/hosts-cloud-lifecycle.ts#5dd89212ba88c2c7cb669193fc4120a421af78bfb98e928dc1ea903a9ffd6de8",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, u
  "server/conat/api/hosts-cloud-lifecycle.ts#c0b5d44e693f9e6eab5982d3e8c6db598e518643b9e43333e83bc4dce57cd13a",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, u
  "server/conat/api/hosts-cloud-lifecycle.ts#c0b5d44e693f9e6eab5982d3e8c6db598e518643b9e43333e83bc4dce57cd13a",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, $
  "server/conat/api/hosts-cloud-lifecycle.ts#d7536d40339daf05a656e69a61565ed88429ff4bb8073dea7a3fe0cb4162d8ea",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, $
  "server/conat/api/hosts-cloud-lifecycle.ts#d7536d40339daf05a656e69a61565ed88429ff4bb8073dea7a3fe0cb4162d8ea",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, $
  "server/conat/api/hosts-cloud-lifecycle.ts#d7536d40339daf05a656e69a61565ed88429ff4bb8073dea7a3fe0cb4162d8ea",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/api/hosts-cloud-lifecycle.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/api/hosts-cloud-lifecycle.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT id, bay_id, name, public_url, internal_url, ssh_server, m
  "server/conat/api/hosts-connection-auth.ts#579ac642f5b1ea8eb92a0f54440906fee752e0282fc94e625c24c1e22dc6a46f",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/conat/api/hosts-project-host-rollbacks.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW()
  "server/conat/api/hosts-project-host-rollbacks.ts#99c47f72ba917d07d6853d63b8ae8a88d0f2a5f1227fb7bbc31c7044dfa6abaf",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET status=$2, metadata=(jsonb_set(COALESCE
  "server/conat/api/hosts.ts#0e3c5ee740435b2f828f70f1ca92b1d727ff42f0bfcd6e2e94cec8d9e009897c",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, metadata FROM project_hosts WHERE id
  "server/conat/api/hosts.ts#1a28e00b9774dd90971292e0f104328a77cbd8a58411eedd20496e740a46a744",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, metadata FROM project_hosts WHERE id
  "server/conat/api/hosts.ts#1a28e00b9774dd90971292e0f104328a77cbd8a58411eedd20496e740a46a744",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/conat/api/hosts.ts#1b24d4930de2c14cd88056ae805aa65775e712f552e70090e7014f0822fccff8",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/conat/api/hosts.ts#1b24d4930de2c14cd88056ae805aa65775e712f552e70090e7014f0822fccff8",
  // READ (pinned because detection is over-inclusive): SELECT id, metadata, tier, deleted, starred_by FROM project_host
  "server/conat/api/hosts.ts#495e367f90d3b5325df161f5315b736c7eb0f284a255c24778ed5654b9f959e3",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set(metadata - 'machin
  "server/conat/api/hosts.ts#4bdff3b951a1fbc3b701d6c6f87f9e6d9c25e658fcd680a3e8d65dac38b15676",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = metadata - 'machine_change_p
  "server/conat/api/hosts.ts#4e084d1222b2f77825ce285cb9ec24c44e601def0515ebcf7f1d1cbfc121e9bd",
  // READ (pinned because detection is over-inclusive): SELECT region, metadata FROM project_hosts WHERE id=$1 AND delet
  "server/conat/api/hosts.ts#57643962c9ccef794b5aa528ebf39f9fbcaee4e313532ee0ede1f61f28a99029",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() W
  "server/conat/api/hosts.ts#766a56b06329a1453d14212f1d6a3bfc3903c5ccd4a709644696fda653915865",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() W
  "server/conat/api/hosts.ts#766a56b06329a1453d14212f1d6a3bfc3903c5ccd4a709644696fda653915865",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set( jsonb_set( jsonb_
  "server/conat/api/hosts.ts#76f01c50207c8ad12e3d9605c310d2f1bdfe8f197d4b8a8e63fde3f6c0a460da",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW()
  "server/conat/api/hosts.ts#99c47f72ba917d07d6853d63b8ae8a88d0f2a5f1227fb7bbc31c7044dfa6abaf",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW()
  "server/conat/api/hosts.ts#99c47f72ba917d07d6853d63b8ae8a88d0f2a5f1227fb7bbc31c7044dfa6abaf",
  // READ (pinned because detection is over-inclusive): (metadata->>'owner' = $1::text OR EXISTS ( SELECT 1 FROM project
  "server/conat/api/hosts.ts#9ed3027363a1a51b0f70dc512d1c14a7633b58496d276673545f9ed6e386084f",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET status=$2, public_url=NULL, internal_ur
  "server/conat/api/hosts.ts#bee52af18ccd5dc30737155f59ade94b1625c20fc5d796573b8424b3d07f83cb",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set(COALESCE(metadata,
  "server/conat/api/hosts.ts#ccdfef18b77f13b8dbfefd0da6b11459bf34b0786e2afa225d5868da766ac679",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set( COALESCE(metadata
  "server/conat/api/hosts.ts#db24445d54292f78baa3d7512cb4b4858059b84a710584f63188ee1165f7ec27",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/api/hosts.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT h.public_url, h.internal_url, h.metadata FROM project_hos
  "server/conat/api/project-api-relay.ts#25b5321e2adbe70359edb2a28b26236ab3e766f19a7ed8cf29cb6a34a3c7f163",
  // READ (pinned because detection is over-inclusive): SELECT COALESCE(bay_id, $2) AS bay_id, deleted, metadata FROM pr
  "server/conat/api/project-content-url.ts#13d2fe277e38b2fd271873401020292281f08a9ec2decefaef6b8d12a5d36384",
  // READ (pinned because detection is over-inclusive): SELECT id, metadata, last_seen FROM project_hosts WHERE id=$1 AN
  "server/conat/api/system.ts#e86343074401c5ee84ce6b4fccc3f0f7063afe6e3ff056c375e95393c39b4ed6",
  // READ (pinned because detection is over-inclusive): SELECT status, metadata FROM project_hosts WHERE id=$1 AND delet
  "server/conat/host-registry.ts#186ba459093b7d359a9600f3f168616ad559a17b8ca2313e23eceae753c29407",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/conat/host-registry.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
  // READ (pinned because detection is over-inclusive): SELECT status, last_seen, metadata FROM project_hosts WHERE id=$
  "server/conat/host-registry.ts#5e48d4a7827592aa7ab706042bfd938bf21be2a8da5b6478746502028e1cab1e",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set(COALESCE(metadata, '
  "server/conat/host-registry.ts#67636f5567a8b610d058c3d2d60f97b81069a8102f13154c55063206a7e90619",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/conat/host-registry.ts#744587298aaa93d1036be81e66d432753f330e8bb133efdae29f6fbfd1951529",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET status='starting', last_seen=NULL, meta
  "server/conat/host-registry.ts#7debb80fcd0df58b0be279ec2e232daab2d49cf07dbb2cbc76d985ad334fa8e3",
  // READ (pinned because detection is over-inclusive): SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND delet
  "server/conat/host-registry.ts#bf6bb2c5ea5e0e5a6f113c469cf6a68ae13711ba2a98aabf4aeb9ea7eb263473",
  // READ (pinned because detection is over-inclusive): SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND delet
  "server/conat/host-registry.ts#bf6bb2c5ea5e0e5a6f113c469cf6a68ae13711ba2a98aabf4aeb9ea7eb263473",
  // READ (pinned because detection is over-inclusive): SELECT metadata, capacity FROM project_hosts WHERE id=$1 AND del
  "server/conat/host-registry.ts#cb76ba89038220cee5637815c1b09834b5d162598e4bda5554b9c5bd8a47aeee",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/host-registry.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/host-registry.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/host-registry.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/host-registry.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/conat/host-registry.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT id, metadata FROM project_hosts WHERE id=$1 AND deleted I
  "server/conat/host-status.ts#41d8e5f7bbfe380fe004cfee5ee8929eedf8988589c1e2e1d848cede35a7e6de",
  // READ (pinned because detection is over-inclusive): SELECT projects.host_id, COALESCE(projects.owning_bay_id, $2) AS
  "server/conat/project-host-assignment.ts#11a7f53bb5ddd3c1a43dbfb2ed8e316f44ed074bf27ac39870ef9f90ef9eefc9",
  // READ (pinned because detection is over-inclusive): SELECT projects.host_id, project_hosts.id AS resolved_host_id, C
  "server/conat/route-project.ts#a4ab55d7bee7db1bde1808b0d2f4c3abcd84f2c6190a3bcb389f32009d502b29",
  // READ (pinned because detection is over-inclusive): SELECT project_hosts.id AS resolved_host_id, COALESCE(project_ho
  "server/conat/route-project.ts#d56d85c4b5f5e1327defa04fc020a96ed3884012668f5605c9870078c5eef5d6",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, last_seen, metadata, public_url FROM
  "server/hosts/availability.ts#0165bbadeab0d9989a4a14068882f9bdc0f3f3eb959d9c9bd526f3d4e23ec8a7",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, last_seen, metadata, public_url FROM
  "server/hosts/availability.ts#06085fa81b7db43f06cffb5ecf0f78ee7cf3076218faa08e70ec0c29db79d588",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, last_seen, metadata FROM project_hos
  "server/hosts/availability.ts#3cbc8069941769b15dcabcc8202f15a0edba76d0a9df5382b8c4575f3f42bbff",
  // READ (pinned because detection is over-inclusive): SELECT h.id, h.status, h.deleted, h.last_seen, h.metadata, h.pub
  "server/hosts/availability.ts#41a876c86ae96de06cdb09a856202bf391060c49382a7852032c23a9ac7c9940",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, last_seen, metadata, public_url, int
  "server/hosts/availability.ts#5420bcdb25a2387cb22cd1906bf35dc359b634dc42745fd06bd70934db734b21",
  // READ (pinned because detection is over-inclusive): SELECT last_seen, metadata FROM project_hosts WHERE id=$1 LIMIT
  "server/hosts/availability.ts#58d4ac58098da1fa2895621d48caff04b059ca57e76656a4adeb7d6b1f7255a9",
  // READ (pinned because detection is over-inclusive): SELECT h.id, h.name, h.status, h.deleted, h.last_seen, h.metadat
  "server/hosts/availability.ts#7874059322b9db9baacfc37bb1399595faf492bec2b63fe925ffb1aee2346e24",
  // READ (pinned because detection is over-inclusive): SELECT id, status, deleted, last_seen, metadata FROM project_hos
  "server/hosts/availability.ts#a56ff2eb85d9c23adf9c3e04fee407f7627f1a5f11d9015a934d2369be902095",
  // READ (pinned because detection is over-inclusive): SELECT h.id, h.name, h.status, h.deleted, h.last_seen, h.metadat
  "server/hosts/availability.ts#f52735779c7764b438aa3d19838a8fa07d9e7c1001368b0d25b127b8366d1005",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set(COALESCE(metadata,
  "server/hosts/desired-state.ts#af39d76416af7923939dea6133a594d8bf3a02bb92db43f8276b64839d4a387c",
  // WRITE: keys visible in the SQL: SELECT metadata->>'desired_state' AS desired_state, desired_stat
  "server/hosts/desired-state.ts#ffded3c8891df156cc8df3319de6f79d69a17682e5ed7934181cf7ae12d1c9f1",
  // READ (pinned because detection is over-inclusive): SELECT id, name, metadata->'host_integrity' AS integrity, metada
  "server/hosts/host-integrity-health.ts#4800a90146c4fc7d8911172a06a27bc1e777b1e39e47eec995458bb9d608ccc1",
  // READ (pinned because detection is over-inclusive): SELECT id AS host_id, name AS host_name, metadata->'metrics'->'c
  "server/hosts/kernel-hardening-health.ts#4428d73dd9847a65e5d24b47f2b70ebd9d1909cab1ebfdedccaa690eb39b2c69",
  // DYNAMIC (G2a; ${FENCED_STATES_SQL} in WHERE): writes the maintenance column, not metadata
  "server/hosts/maintenance.ts#b4a468e5c2347ca07d0a8512bba9b456576136a4a58810907167704a42da3c80",
  // READ (pinned because detection is over-inclusive): SELECT id, name, region, public_url, status, last_seen, metadata
  "server/hosts/runtime-maintenance.ts#1b1518036e1000264da3d0860ac65efb28e666d7f5122d6f371fb5ada3cb9667",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#2ccd7062a2e1b0b34d57caa14f54119dd613859446b30f11f0a0591a595c380d",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#308edd67b760b2b42c1c1071bfc26a8b4ea8bb6bda579d2277a9ca4eead49b5b",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#326a0ee8a3eab59a536ae59ece86a54fdb7d8b7a1a9276b68378e90f7b127d20",
  // WRITE: keys visible in the SQL: WITH fleet_lock AS ( SELECT pg_try_advisory_xact_lock($8::bigint
  "server/hosts/runtime-maintenance.ts#427bd2755c1740198f66f28dd6b1d1259d231688f930eb7c222d31d01bb07632",
  // WRITE: keys visible in the SQL: UPDATE project_hosts AS target SET metadata=jsonb_set( jsonb_set
  "server/hosts/runtime-maintenance.ts#50f5d0dedbab7df547946820009172979dc27d2172808c658fb7dbd535f1a713",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#5c74c2d1b59942ef23b6f34c9fc80061e8e2ab8b22e7b80293194b41ed9911a3",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#78fe5ba344558195b12297da294967c2716338d145881a5da2b1fa6c3e8da9af",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#a15ab1c18f6b4b902ac0c4b899bfa8ee26bf0cdf5deba58925e76a9c3b7bc5b5",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#a879a40e5124fc4766075c8a10deff6f011008f158804005e6e954f03f12514c",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata=jsonb_set( COALESCE(metadata,
  "server/hosts/runtime-maintenance.ts#cc0b6af4cc99e1985704af7b4871ca23528adde913b467ec0ecd18d2f096adf8",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set( COALESCE(metadata
  "server/hosts/runtime-transition.ts#6760bf4fa7f8cf95c0a49979da605ad7204f00bc547f12449c77fab90d175e25",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set( jsonb_set( COALES
  "server/hosts/runtime-transition.ts#f2037c531c30a08ee4f870055eac76d5205da49661ac52c7f2f1f01b7acb8c64",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, ${BUMP_DESIRED_STATE_GENER
  "server/hosts/start-worker.ts#3bfacbd091c9f841af2f15e468791faea8e20804fe99a0777512db9fad29d2e4",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, ${BUMP_DESIRED_STATE_GENER
  "server/hosts/start-worker.ts#3bfacbd091c9f841af2f15e468791faea8e20804fe99a0777512db9fad29d2e4",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, region=COALESCE($3, region
  "server/hosts/start-worker.ts#780580083a93289bf6b5941350448051cd100a34192dc05ea793ca392038c6a1",
  // READ (pinned because detection is over-inclusive): SELECT id, status, metadata, maintenance, deleted, last_seen FRO
  "server/hosts/start-worker.ts#a7847be8d71ea2607eba234405a649f40261f019e880c88e1d81033dcd91e5b9",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET status='deprovisioning', metadata = jso
  "server/hosts/start-worker.ts#c304c2e8858f79a719e620e40d3d85db3499ec787d35069eac936cb0533fb523",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/hosts/start-worker.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/hosts/start-worker.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT id, name, jsonb_build_object( 'runtime_synthetic_probe',
  "server/hosts/synthetic-probe-health.ts#988b5431a497c899ee955fc91284ac8163861e691553ac53020eb5286fb44f7e",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/launchpad/onprem-sshd.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
  // READ (pinned because detection is over-inclusive): SELECT 1 FROM project_hosts WHERE deleted IS NULL AND ( ( (metad
  "server/launchpad/onprem-sshd.ts#80058f0fbcd03fd1d874bcef4f007c13dbaed87564cfeeb3daee25698ac3b063",
  // READ (pinned because detection is over-inclusive): SELECT id AS host_id, COALESCE(metadata->'self_host'->>'http_tun
  "server/launchpad/onprem-sshd.ts#b8d5ed58d0ce30b696eaf028afc62bbaebd9a5e455d634af473ac1135c872c43",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/launchpad/onprem-sshd.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT i.legacy_project_id, i.project_id::TEXT AS project_id, le
  "server/legacy-migration/scan-account-environment.ts#64b1307f32947e4147e7477bf2682cad8c8e3f1403db344c1cd8dbdbc81608ff",
  // READ (pinned because detection is over-inclusive): SELECT id::text AS id, metadata, capacity FROM project_hosts WHE
  "server/lro/project-host-defaults.ts#d01824569f47d69224abd344962e8501493190358376a29d1fc5fa92e91e27e3",
  // READ (pinned because detection is over-inclusive): SELECT project_hosts.tier, project_hosts.metadata FROM projects
  "server/membership/managed-cpu-scope.ts#57de6da7de07dbb673f50c679c27a480107ab667e04ed0949faec61481929b79",
  // READ (pinned because detection is over-inclusive): SELECT tier, metadata FROM project_hosts WHERE id=$1 AND deleted
  "server/membership/managed-cpu-scope.ts#b728f97bf2a833366a5989a8cba71de5a54b1c9fbb0f80d20193cdec8ac9679f",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 LIMIT 1
  "server/project-backup/index.ts#56b49d003ce0ad1552a5d516d424973e05b8b8aed2c60ba362608cc23211b48f",
  // READ (pinned because detection is over-inclusive): SELECT region, metadata FROM project_hosts WHERE id=$1 AND delet
  "server/project-backup/index.ts#57643962c9ccef794b5aa528ebf39f9fbcaee4e313532ee0ede1f61f28a99029",
  // READ (pinned because detection is over-inclusive): SELECT id, metadata FROM project_hosts WHERE id=$1 AND deleted I
  "server/project-host/access.ts#41d8e5f7bbfe380fe004cfee5ee8929eedf8988589c1e2e1d848cede35a7e6de",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/project-host/auto-grow.ts#7cea44fd6bd1b91978ccad88ac2f9638f0f51e1cc07b9b0b40bea5b3b79d08aa",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/project-host/auto-grow.ts#7cea44fd6bd1b91978ccad88ac2f9638f0f51e1cc07b9b0b40bea5b3b79d08aa",
  // READ (pinned because detection is over-inclusive): SELECT id, name, region, status, metadata, maintenance FROM proj
  "server/project-host/auto-grow.ts#90bfeffca7a1fb791bb32545ba9be32b1af91e192a6038e7fa8a0f01abdca51e",
  // READ (pinned because detection is over-inclusive): SELECT id, bay_id, name, region, public_url, internal_url, ssh_s
  "server/project-host/control.ts#26ed05fd88347453942118f9ce75d263fe49cc2f6811a78756df608b545a4bc1",
  // READ (pinned because detection is over-inclusive): SELECT id, bay_id, name, region, public_url, internal_url, ssh_s
  "server/project-host/control.ts#9603937be86b4c7743e42d9a6d6be94479caa53dd4a82513a7c2f45f46487e20",
  // READ (pinned because detection is over-inclusive): SELECT r.*, h.public_url, h.metadata, h.status AS host_status, h
  "server/project-host/exam.ts#61d9b19287f3f357cb3ea3deaf9820983e1fc9e5eb483a09c03cd83bc3e073e7",
  // READ (pinned because detection is over-inclusive): SELECT c.*, h.id, h.name, h.status, h.public_url, h.metadata, (h
  "server/project-host/exam.ts#7e4e87b2e5c69ab0a3de2205e2e92642687f2ef31ec49a31fdfe70e7ad93408d",
  // READ (pinned because detection is over-inclusive): SELECT id, bay_id, name, region, public_url, internal_url, ssh_s
  "server/project-host/rehome.ts#995ad969e6f69dae394af1d7bd9a92c9a61d61417cd46dfc0e94a79ab4e677ed",
  // WRITE: insert: INSERT INTO project_hosts (id, bay_id, name, region, public_url,
  "server/project-host/rehome.ts#adb3250c592827b30ae6ae7e1a2213f25d629e637e49beb2a21d0fd58e87e076",
  // READ (pinned because detection is over-inclusive): SELECT tier, metadata FROM project_hosts WHERE id=$1 AND deleted
  "server/project-host/run-quota.ts#f380be538f685bb97d9245dc454dc7c473ae806d440846916e22b840bfa4928f",
  // READ (pinned because detection is over-inclusive): SELECT id, name, region, status, metadata, maintenance FROM proj
  "server/project-host/spend-maintenance.ts#3022d094b42729156b96bf959619c0567fde6c3ce909b66276646aa41b506acb",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = metadata #- '{billing,enforc
  "server/project-host/spend-maintenance.ts#52146903eb35de1ac8bdbae5d7e80266d9639196802889cdb017ca634eb8d978",
  // WRITE: keys visible in the SQL: UPDATE project_hosts SET metadata = jsonb_set( metadata, '{billi
  "server/project-host/spend-maintenance.ts#5c5238b67f8e30d656c8eec20456196c0c57d0ee74ba688b0927ee0c611d17d7",
  // DYNAMIC WRITE (G2a): SET from writeHostBillingChanges (metadata patch: - removed keys || set keys, via metadataPatch)
  "server/project-host/spend-maintenance.ts#f63da0295e6a2c1ac9bf977db3e1af1dcfde4e02f79691e5fdb7ea14389cd1e7",
  // READ (pinned because detection is over-inclusive): SELECT p.project_id, p.host_id, p.last_backup, COALESCE((to_json
  "server/projects/maintenance-status.ts#a0606d6a6d406b426f199c5ff465d64f04abf049b59ca26a1cc9962eee4423d2",
  // READ (pinned because detection is over-inclusive): SELECT h.id AS host_id, h.last_seen AS host_last_seen, h.metadat
  "server/projects/maintenance-status.ts#e0e3728894277dfd69de4004830f6239634e1ff3cb0c3c8517d6b3406cfaacba",
  // READ (pinned because detection is over-inclusive): SELECT id, region, metadata, tier FROM project_hosts WHERE statu
  "server/projects/move-worker.ts#b811551e312f99cf67efeb9b452103f0b08772493d89979d17e54811a6fcc501",
  // READ (pinned because detection is over-inclusive): SELECT id::text AS id, name, region, metadata FROM project_hosts
  "server/projects/rootfs-publish-worker.ts#1b9ea6c48028ade5146eff6bff5fe7a892339d984d44230daa36862350c5b61c",
  // READ (pinned because detection is over-inclusive): SELECT p.state, h.metadata ->> 'host_session_started_at' AS host
  "server/projects/start-lro-cleanup.ts#5faf9c54d6a81fab82413259b8058aa1de398261cf7163d62b6f092a187fe339",
  // READ (pinned because detection is over-inclusive): SELECT p.*, projects.title AS project_title, projects.host_id, p
  "server/public-directory-shares/index.ts#6668bc1e97aa971625b0a88db6d014bb4ea4347aa8e2d336bc3272e1263b84cf",
  // READ (pinned because detection is over-inclusive): SELECT h.id, h.name, h.metadata->>'owner' AS owner, h.metadata#>
  "server/purchases/billing-exposure-health.ts#a8c1728245669d082fe61a3ba2811d7580a8b75260fdc6ee15ecc45e7ccf4a00",
  // READ (pinned because detection is over-inclusive): SELECT id, name, metadata->>'owner' AS owner, metadata#>>'{billi
  "server/purchases/billing-exposure-health.ts#bb45f913367638626ca0b22f049ce4cfcb1252d9e4b8e277a75dbc49980a45fc",
  // READ (pinned because detection is over-inclusive): SELECT region, metadata FROM project_hosts WHERE id=$1
  "server/rootfs/releases.ts#27919b2143a3c723e0fcaba7a9c4c5833bdb77b940c62aedb75e88f67d5be647",
  // READ (pinned because detection is over-inclusive): SELECT id, name, region, metadata FROM project_hosts WHERE id=$1
  "server/self-host/connector-tokens.ts#5312ebb9943051e3872f2d55c75b33fd53e0bdc5fa93ad21b03d50979fdef507",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() W
  "server/self-host/connector-tokens.ts#766a56b06329a1453d14212f1d6a3bfc3903c5ccd4a709644696fda653915865",
  // WRITE: whole metadata object from code (manual inventory): UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1
  "server/self-host/ssh-target.ts#21c942a5f40b70bf4b67454271ddda366ee36eff68fb38b0a1b097a0c23e7cd5",
  // READ (pinned because detection is over-inclusive): SELECT id, metadata, status FROM project_hosts WHERE deleted IS
  "server/self-host/ssh-target.ts#819237ad9cabdafb9847c9fe07fe400797dee2442a6667d6b6db68fdb8d799c9",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/self-host/ssh-target.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
  // READ (pinned because detection is over-inclusive): SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NU
  "server/self-host/ssh-target.ts#f0da99d059b70f67cbea32db1c0ceb6b6c8d1abb196cc28a0025d158fc538d86",
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

// Builders whose SQL fragments are pushed into a dynamic project_hosts
// statement (ops0 2735 G2b, 2737), and the desired_state trigger body (G2c):
// "file#function", with the sha256 of the whitespace-normalized source of
// that function (the builder, or the function holding the statement that
// consumes its fragments). A changed body fails the test until it is
// re-reviewed; a removed or renamed function fails as "missing".
export function namedFunctionTexts(
  file: string,
  text: string,
  name: string,
): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    let found: ts.Node | undefined;
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      found = node;
    }
    if (found) out.push(found.getText(source).split(/\s+/).join(" ").trim());
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function metadataBuilderId(
  file: string,
  text: string,
  name: string,
): string {
  const bodies = namedFunctionTexts(file, text, name);
  if (bodies.length !== 1) {
    return `${file}#${name}#${bodies.length === 0 ? "missing" : "duplicate"}`;
  }
  return `${file}#${name}#${createHash("sha256").update(bodies[0]).digest("hex")}`;
}

// The current ids of the functions named in REVIEWED_METADATA_BUILDERS.
export function metadataBuilderIds(): string[] {
  return REVIEWED_METADATA_BUILDERS.map((id) => {
    const [file, name] = id.split("#");
    return metadataBuilderId(
      file,
      readFileSync(join(PACKAGES, file), "utf8"),
      name,
    );
  }).sort();
}

export const REVIEWED_METADATA_BUILDERS: readonly string[] = [
  // desired_state trigger body (G2c): reverts an unversioned change of metadata.desired_state
  "database/postgres/schema/project-host-desired-state.ts#desiredStateGuardFunctionSql#8befff8aa0f2be623af0c3fdf34c99ef52331356a3ae4d127306d2b2b17bf96b",
  // host work: SET list from an updates object; metadata as a patch against the loaded snapshot (else `metadata=$n`, the whole object)
  "server/cloud/host-work.ts#buildHostUpdate#578e124902cb73fa189e5aaf768f33a9a564f3282e8ac68b74bf6ae334c46fad",
  // host work recovery: consumes buildHostUpdate inside the recovery transaction
  "server/cloud/host-work.ts#transitionAndQueueRecoveryStart#40b9bb4821af7e0de74b3282f8fc73a22002c34904a7df491edb48365565674b",
  // host work: consumes buildHostUpdate in UPDATE project_hosts SET ${sets.join(", ")}
  "server/cloud/host-work.ts#updateHostRow#d26f2f0bb664a873185a96ceb3cdb0d90346a60cdc3140eb96e0f26d5536e624",
  // host work: consumes buildHostUpdate, unless desired_state is stopped
  "server/cloud/host-work.ts#updateHostRowUnlessStopped#c8e92e90c3aa51984725555c32591ff662620f6552b2773f3d2153796513049d",
  // provider reconcile: jsonb_set chain over '{runtime}' and '{spot_recovery_state}', consumed by its UPDATE
  "server/cloud/reconcile.ts#updateHostFromProviderSnapshot#d4383552877d9110a57278eff412d326b95b8ab07000dedbce5e01507f5cc22b",
  // the top-level keys changed or removed relative to the row a writer read (set / remove)
  "server/hosts/metadata-patch.ts#metadataPatch#550334ec5484fdd2953bb12a65cd9dde6587e321e336933fbfa2c1d19a4645f7",
  // the SET fragment `metadata = (COALESCE(metadata, '{}') - $remove::text[]) || $set::jsonb`
  "server/hosts/metadata-patch.ts#metadataPatchAssignment#2af1b2de2e3d3596faeca4ab07d1961aeb398cdc9d354094b6e122ade415b52b",
  // billing pass: pushes the metadata patch (and status, desired_state generation) into UPDATE project_hosts SET ${sets.join(", ")}
  "server/project-host/spend-maintenance.ts#writeHostBillingChanges#786722804ac74077cc4c1885e4c860e924c629706d012931d7001df40b3c2620",
];
