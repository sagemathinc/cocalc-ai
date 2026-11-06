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
import type {
  HostIntegrityDetection,
  HostIntegrityStatus,
} from "@cocalc/conat/hub/api/hosts";

const logger = getLogger("project-host:host-integrity");

export const HOST_INTEGRITY_STATUS_PATH =
  "/var/lib/cocalc-host-integrity/status.json";
export const REBOOT_REQUIRED_PATH = "/var/run/reboot-required";
// The watcher rewrites its status at least every 15 s.
const STALE_MS = 2 * 60_000;
const MAX_FINDINGS = 20;
const MAX_CONFIG_CHANGES = 20;
const MAX_INVENTORY = 50;

let latest: HostIntegrityStatus | undefined;

function iso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1 };
const MAX_UNREADABLE = 8;
const MAX_PROGRAMS = 10;

// A count from the watcher: a finite number that isn't negative, else 0
// (JSON can't spell Infinity, but 1e999 parses to it).
function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Program paths from the watcher's counts: absolute, plain characters only.
function programCounts(value: unknown): Record<string, number> | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const entries = Object.entries(value)
    .filter(([path]) => /^\/[A-Za-z0-9/_.+-]{1,127}$/.test(path))
    .map(([path, n]) => [path, count(n)] as [string, number])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_PROGRAMS);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// A short label from the watcher (a state, mode or class), or undefined.
function word(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9:_ .-]{1,64}$/.test(value)
    ? value
    : undefined;
}

function total(value: unknown): number {
  if (value == null || typeof value !== "object") return 0;
  return Object.values(value).reduce<number>((sum, n) => sum + count(n), 0);
}

// What the watcher checks, from the fields newer watchers write; undefined
// for older ones.
function detection(raw: any): HostIntegrityDetection | undefined {
  const keys = [
    "runtime_uid_mode",
    "rule2",
    "rule3",
    "ranges_state",
    "hardening",
  ];
  if (!keys.some((key) => raw?.[key] != null)) return undefined;
  const rule3 =
    raw?.rule3 != null && typeof raw.rule3 === "object" ? raw.rule3 : undefined;
  const problems = raw?.hardening?.problems;
  return {
    runtime_uid_mode: word(raw?.runtime_uid_mode),
    runtime_user_in_container: word(raw?.rule2),
    exec_monitor: rule3
      ? {
          state: word(rule3.state) ?? "unknown",
          marked: count(rule3.marked),
          lost: count(rule3.lost_events) + count(rule3.malformed_records),
          unattributed: total(rule3.unattributed),
          ...(programCounts(rule3.unattributed)
            ? { unattributed_programs: programCounts(rule3.unattributed) }
            : {}),
        }
      : undefined,
    ranges_state: word(raw?.ranges_state),
    layout_problems:
      problems != null && typeof problems === "object"
        ? Object.values(problems as Record<string, unknown>).reduce<number>(
            (sum, counts) => sum + total(counts),
            0,
          )
        : undefined,
  };
}

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
  const detected = detection(raw);
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
      ...(word(f?.uid_class) ? { uid_class: word(f.uid_class) } : {}),
      ...(Array.isArray(f?.unreadable)
        ? {
            unreadable: f.unreadable
              .filter(
                (name: unknown) =>
                  typeof name === "string" && /^[a-z]{1,16}$/.test(name),
              )
              .slice(0, MAX_UNREADABLE),
          }
        : {}),
      ...(count(f?.affected) > 0 ? { affected: count(f.affected) } : {}),
    })),
    finding_count: findings.length,
    config_changes: changes.slice(0, MAX_CONFIG_CHANGES).map((c: any) => ({
      path: `${c?.path ?? ""}`,
      first_seen: iso(c?.first_seen),
      last_seen: iso(c?.last_seen),
    })),
    config_change_count: changes.length,
    config_baseline_at: iso(raw?.config?.baseline_at),
    inventory: Object.fromEntries(
      Object.entries(inventory)
        .map(([key, count]) => [key, Number(count) || 0] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_INVENTORY),
    ),
    ...(detected ? { detection: detected } : {}),
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
