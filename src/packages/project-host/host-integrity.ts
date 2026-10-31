/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

/*
Host integrity for the heartbeat: the root watcher's status (installed by host
bootstrap as cocalc-host-integrity.service) and whether a reboot is pending to
apply updates (e.g. a new kernel). The watcher's findings carry no command
lines, environment or file contents; this only trims and passes them on.
*/

import { readFile, stat } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import type { HostIntegrityStatus } from "@cocalc/conat/hub/api/hosts";

const logger = getLogger("project-host:host-integrity");

export const HOST_INTEGRITY_STATUS_PATH =
  "/var/lib/cocalc-host-integrity/status.json";
export const REBOOT_REQUIRED_PATH = "/var/run/reboot-required";
// The watcher rewrites its status at least every 15 s.
const STALE_MS = 2 * 60_000;
const MAX_FINDINGS = 20;
const MAX_CONFIG_CHANGES = 20;
const MAX_INVENTORY = 50;
const MAX_ARTIFACT_EVENTS = 20;

let latest: HostIntegrityStatus | undefined;

function iso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1 };

// Most severe, then newest first, so the caps keep what matters.
function worstNewestFirst(items: unknown): any[] {
  if (!Array.isArray(items)) return [];
  const rank = (item: any) => SEVERITY_RANK[`${item?.severity}`] ?? 2;
  const seen = (item: any) => Date.parse(item?.last_seen) || 0;
  return [...items].sort((a, b) => rank(a) - rank(b) || seen(b) - seen(a));
}

async function rebootRequiredSince(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function readHostIntegrity({
  statusPath = HOST_INTEGRITY_STATUS_PATH,
  rebootPath = REBOOT_REQUIRED_PATH,
  now = Date.now(),
}: {
  statusPath?: string;
  rebootPath?: string;
  now?: number;
} = {}): Promise<HostIntegrityStatus> {
  const reboot_required_since = await rebootRequiredSince(rebootPath);
  let raw: any;
  try {
    raw = JSON.parse(await readFile(statusPath, "utf8"));
  } catch (err: any) {
    return {
      watcher: err?.code === "ENOENT" ? "missing" : "unreadable",
      observed_at: new Date(now).toISOString(),
      reboot_required_since,
    };
  }
  const heartbeat_at = iso(raw?.heartbeat_at);
  const stale =
    heartbeat_at == null || now - Date.parse(heartbeat_at) > STALE_MS;
  const findings = worstNewestFirst(raw?.findings);
  const changes = worstNewestFirst(raw?.config?.changes);
  const inventory =
    raw?.inventory && typeof raw.inventory === "object" ? raw.inventory : {};
  return {
    watcher: stale ? "stale" : "running",
    observed_at: new Date(now).toISOString(),
    schema: typeof raw?.schema === "string" ? raw.schema : undefined,
    heartbeat_at,
    started_at: iso(raw?.started_at),
    scans: Number(raw?.scans) || 0,
    errors: Number(raw?.errors) || 0,
    findings: findings.slice(0, MAX_FINDINGS).map((f: any) => ({
      rule: `${f?.rule ?? ""}`,
      severity: `${f?.severity ?? ""}`,
      comm: `${f?.comm ?? ""}`,
      exe: `${f?.exe ?? ""}`,
      uids: Array.isArray(f?.uids) ? f.uids.map(Number) : [],
      userns: `${f?.userns ?? ""}`,
      parents: Array.isArray(f?.parents) ? f.parents.map(String) : [],
      first_seen: iso(f?.first_seen),
      last_seen: iso(f?.last_seen),
      count: Number(f?.count) || 0,
    })),
    finding_count: findings.length,
    config_changes: changes.slice(0, MAX_CONFIG_CHANGES).map((c: any) => ({
      path: `${c?.path ?? ""}`,
      first_seen: iso(c?.first_seen),
      last_seen: iso(c?.last_seen),
    })),
    config_change_count: changes.length,
    artifact_events: (Array.isArray(raw?.artifact_events)
      ? raw.artifact_events
      : []
    )
      .slice(-MAX_ARTIFACT_EVENTS)
      .map((e: any) => ({
        at: iso(e?.at),
        action: `${e?.action ?? ""}`,
        kind: e?.kind != null ? `${e.kind}` : undefined,
        version: e?.version != null ? `${e.version}` : undefined,
        result: e?.result != null ? `${e.result}` : undefined,
      })),
    config_baseline_at: iso(raw?.config?.baseline_at),
    inventory: Object.fromEntries(
      Object.entries(inventory)
        .map(([key, count]) => [key, Number(count) || 0] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_INVENTORY),
    ),
    reboot_required_since,
  };
}

// Refreshed before each heartbeat; read by the (synchronous) payload builder.
export async function refreshHostIntegrity(): Promise<void> {
  try {
    latest = await readHostIntegrity();
  } catch (err) {
    logger.debug("unable to read host integrity status", { err: `${err}` });
  }
}

export function getHostIntegrity(): HostIntegrityStatus | undefined {
  return latest;
}
