/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared by host-report-metadata.test.ts and host-registry.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Top-level metadata keys the bay writes. writtenProjectHostMetadataKeys()
// below finds the ones written by jsonb_set paths, `- 'key'` and
// `metadata.key =` in server/database code that touches project_hosts; the
// enumeration test fails if it finds one that is not listed here. The rest
// come from manual traces (security-audit's 076 reader trace, host create and
// provider reconcile). None may come from a host report.
export const BAY_OWNED_METADATA_KEYS = [
  "admin_reopen_reservation",
  "billing",
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

// A report as a bd0131eb project-host sends it (project-host/master.ts
// basePayload.metadata + buildPayload metadata), with representative values.
export function hostReportFixture(): Record<string, unknown> {
  return {
    runnerId: "runner-1",
    host_session_id: "session-1",
    host_boot_id: "boot-1",
    host_session_started_at: "2026-11-13T00:00:00.000Z",
    host_boot_started_at: "2026-11-12T00:00:00.000Z",
    host_cpu_count: 8,
    host_ram_gb: 32,
    host_uptime_s: 1234,
    cloudflared_restart_supported: true,
    cloudflared_diagnostics_supported: true,
    cloudflared: { state: "ok", checked_at: "2026-11-13T00:00:00.000Z" },
    metrics: {
      current: {
        collected_at: "2026-11-13T00:00:00.000Z",
        memory_used_percent: 72.2,
        memory_total_bytes: 34359738368,
        io_containment: { policy_mode: "enforce", capabilities: ["io.max"] },
      },
    },
    pressure: { zone: "normal", evaluated_at_ms: 1, candidate_count: 0 },
    placement: {
      observed_at: "2026-11-13T00:00:00.000Z",
      cached_rootfs_images: ["img-a", "img-b"],
      rootfs_cache_truncated: false,
    },
    bootstrap_lifecycle: { phase: "ready" },
    host_agent: { project_host: { last_known_good_version: "v1" } },
    runtime_health: { ready: true, status: "ok" },
    acp_worker_health: { ok: true },
    bees: { state: "running" },
    host_integrity: { ok: true },
    runtime_uid_mode: { mode: "keep-id" },
    observed_components: [{ component: "acp-worker", state: "running" }],
    rootfs_scanner: { state: "ready" },
    software: { project_host: "v1", project_bundle: "b1", tools: "t1" },
    software_inventory: [{ artifact: "project-host", current_version: "v1" }],
    agent_rpc_report: { version: 1, project_host: "v1" },
    content_origin_domain: null,
  };
}

// Hub-written keys that are also host-owned by decision (ops0 2703): the host
// reports its observed software; the bay's rollback write is provisional.
export const SHARED_HOST_OWNED_METADATA_KEYS = ["software"] as const;

// Matches of the enumeration patterns that are not project_hosts.metadata keys.
export const NOT_METADATA_KEY_MATCHES = ["key", "port"] as const;

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

// Top-level project_hosts.metadata keys written by server and database code.
export function writtenProjectHostMetadataKeys(): Set<string> {
  const packages = join(__dirname, "..", "..", "..");
  const patterns = [
    /jsonb_set\(\s*[^']*?'\{(\w+)/g,
    /-\s*'(\w+)'/g,
    /\bmetadata\.(\w+)\s*=(?!=)/g,
  ];
  const keys = new Set<string>();
  for (const root of ["server", "database"]) {
    for (const file of sourceFiles(join(packages, root))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("project_hosts")) continue;
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) keys.add(match[1]);
      }
    }
  }
  return keys;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function metadataKeysOf(object: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const property of object.properties) {
    if (
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name)
    ) {
      keys.push(property.name.text);
    } else if (ts.isSpreadAssignment(property)) {
      const spread = unwrap(property.expression);
      if (ts.isConditionalExpression(spread)) {
        for (const branch of [spread.whenTrue, spread.whenFalse]) {
          const literal = unwrap(branch);
          if (!ts.isObjectLiteralExpression(literal)) {
            throw new Error(`unhandled spread branch: ${literal.getText()}`);
          }
          keys.push(...metadataKeysOf(literal));
        }
      } else if (/^\(?basePayload\.metadata\b/.test(spread.getText())) {
        // basePayload.metadata's own keys are collected separately.
      } else {
        throw new Error(`unhandled spread: ${spread.getText()}`);
      }
    } else {
      throw new Error(`unhandled property: ${property.getText()}`);
    }
  }
  return keys;
}

function metadataLiteral(
  object: ts.ObjectLiteralExpression,
): ts.ObjectLiteralExpression | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "metadata"
    ) {
      const value = unwrap(property.initializer);
      if (ts.isObjectLiteralExpression(value)) return value;
    }
  }
  return undefined;
}

// The metadata keys project-host/master.ts actually sends: basePayload's
// metadata plus the metadata buildPayload returns.
export function hostReportedKeysFromSource(): string[] {
  const path = join(__dirname, "..", "..", "..", "project-host", "master.ts");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const keys = new Set<string>();
  let found = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const init = unwrap(node.initializer);
      if (
        node.name.text === "basePayload" &&
        ts.isObjectLiteralExpression(init)
      ) {
        const metadata = metadataLiteral(init);
        if (metadata) {
          metadataKeysOf(metadata).forEach((key) => keys.add(key));
          found += 1;
        }
      }
      if (node.name.text === "buildPayload" && ts.isArrowFunction(init)) {
        const visitReturn = (inner: ts.Node) => {
          if (ts.isReturnStatement(inner) && inner.expression) {
            const value = unwrap(inner.expression);
            const metadata = ts.isObjectLiteralExpression(value)
              ? metadataLiteral(value)
              : undefined;
            if (metadata) {
              metadataKeysOf(metadata).forEach((key) => keys.add(key));
              found += 1;
            }
          }
          ts.forEachChild(inner, visitReturn);
        };
        visitReturn(init.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found !== 2) {
    throw new Error(
      `expected basePayload and buildPayload metadata, found ${found}`,
    );
  }
  return [...keys].sort();
}
