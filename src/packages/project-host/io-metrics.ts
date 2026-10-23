import type {
  HostIoContainmentMetrics,
  HostIoProjectMetrics,
} from "@cocalc/conat/hub/api/hosts";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROJECT_POOL = "/sys/fs/cgroup/cocalc-project-pool";
const RUNTIME_STORAGE = "/usr/local/sbin/cocalc-runtime-storage";
const MAX_LEAVES_PER_SAMPLE = 32;
const TOP_PROJECTS = 10;

type IoCounters = {
  readBytes: number;
  writeBytes: number;
  readIos: number;
  writeIos: number;
};

type TimedCounters = IoCounters & { at: number };

type PrivilegedStatus = Omit<
  HostIoContainmentMetrics,
  | "collected_at"
  | "top_projects"
  | "sampled_project_count"
  | "total_project_count"
  | "stale_project_count"
  | "truncated"
>;

const previousLeaves = new Map<string, TimedCounters>();
let previousPrivilegedStatus: PrivilegedStatus | undefined;
let leafCursor = 0;

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function parseIoStat(raw: string): IoCounters {
  const counters: IoCounters = {
    readBytes: 0,
    writeBytes: 0,
    readIos: 0,
    writeIos: 0,
  };
  for (const line of raw.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (!fields[0]?.includes(":")) continue;
    for (const field of fields.slice(1)) {
      const [key, text] = field.split("=", 2);
      const value = finite(text);
      if (value == null) continue;
      if (key === "rbytes") counters.readBytes += value;
      if (key === "wbytes") counters.writeBytes += value;
      if (key === "rios") counters.readIos += value;
      if (key === "wios") counters.writeIos += value;
    }
  }
  return counters;
}

export function parseIoPressure(raw: string): {
  somePercent?: number;
  fullPercent?: number;
  // full avg60
  fullAvg60Percent?: number;
  someTotal?: number;
  fullTotal?: number;
} {
  const result: ReturnType<typeof parseIoPressure> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const kind = fields.shift();
    const values = new Map(
      fields.map((field) => field.split("=", 2) as [string, string]),
    );
    if (kind === "some") {
      result.somePercent = finite(values.get("avg10"));
      result.someTotal = finite(values.get("total"));
    }
    if (kind === "full") {
      result.fullPercent = finite(values.get("avg10"));
      result.fullAvg60Percent = finite(values.get("avg60"));
      result.fullTotal = finite(values.get("total"));
    }
  }
  return result;
}

function rates(
  previous: TimedCounters | undefined,
  current: TimedCounters,
): Omit<HostIoProjectMetrics, "project_id" | "sampled_at"> {
  if (!previous || current.at <= previous.at) return {};
  const seconds = (current.at - previous.at) / 1000;
  const rate = (next: number, before: number) =>
    Math.max(0, Math.round((next - before) / seconds));
  return {
    read_bytes_per_second: rate(current.readBytes, previous.readBytes),
    write_bytes_per_second: rate(current.writeBytes, previous.writeBytes),
    read_iops: rate(current.readIos, previous.readIos),
    write_iops: rate(current.writeIos, previous.writeIos),
  };
}

async function readPrivilegedStatus(): Promise<PrivilegedStatus> {
  const { stdout } = await execFileAsync(
    "/usr/bin/sudo",
    ["-n", RUNTIME_STORAGE, "project-io-status"],
    { timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function privilegedStatusFailure(
  previous: PrivilegedStatus | undefined,
  error: unknown,
): PrivilegedStatus {
  const message = `${error}`;
  if (previous) {
    return {
      ...previous,
      capability: "unsupported",
      capability_reason: message,
      last_reconcile_error: message,
    };
  }
  return {
    policy_mode: "invalid",
    mountpoint: "/mnt/cocalc",
    capability: "unsupported",
    capability_reason: message,
    pool_cgroup: PROJECT_POOL,
    devices: [],
    last_reconcile_error: message,
  };
}

async function sampleLeaves(now: number): Promise<{
  projects: HostIoProjectMetrics[];
  sampled: number;
  total: number;
}> {
  const entries = (await readdir(PROJECT_POOL, { withFileTypes: true })).filter(
    (entry) =>
      entry.isDirectory() && /^project-[0-9a-f-]{36}$/u.test(entry.name),
  );
  const currentProjectIds = new Set(
    entries.map((entry) => entry.name.slice("project-".length)),
  );
  for (const projectId of previousLeaves.keys()) {
    if (!currentProjectIds.has(projectId)) previousLeaves.delete(projectId);
  }
  if (entries.length === 0) return { projects: [], sampled: 0, total: 0 };
  const count = Math.min(MAX_LEAVES_PER_SAMPLE, entries.length);
  const selected = Array.from(
    { length: count },
    (_, offset) => entries[(leafCursor + offset) % entries.length],
  );
  leafCursor = (leafCursor + count) % entries.length;
  const projects = await Promise.all(
    selected.map(async (entry): Promise<HostIoProjectMetrics | undefined> => {
      try {
        const project_id = entry.name.slice("project-".length);
        const counters = parseIoStat(
          await readFile(join(PROJECT_POOL, entry.name, "io.stat"), "utf8"),
        );
        const current = { ...counters, at: now };
        const previous = previousLeaves.get(project_id);
        previousLeaves.set(project_id, current);
        return {
          project_id,
          sampled_at: new Date(now).toISOString(),
          ...rates(previous, current),
        };
      } catch {
        return undefined;
      }
    }),
  );
  return {
    projects: projects
      .filter((value): value is HostIoProjectMetrics => value != null)
      .sort(
        (a, b) =>
          (b.read_bytes_per_second ?? 0) +
          (b.write_bytes_per_second ?? 0) -
          ((a.read_bytes_per_second ?? 0) + (a.write_bytes_per_second ?? 0)),
      )
      .slice(0, TOP_PROJECTS),
    sampled: selected.length,
    total: entries.length,
  };
}

export async function readIoContainmentMetrics(): Promise<HostIoContainmentMetrics> {
  const now = Date.now();
  let status: Awaited<ReturnType<typeof readPrivilegedStatus>>;
  try {
    status = await readPrivilegedStatus();
    previousPrivilegedStatus = status;
  } catch (err) {
    status = privilegedStatusFailure(previousPrivilegedStatus, err);
    return {
      ...status,
      collected_at: new Date(now).toISOString(),
      top_projects: [],
      sampled_project_count: 0,
      total_project_count: 0,
      stale_project_count: 0,
      truncated: false,
    };
  }
  try {
    const leaves = await sampleLeaves(now);
    return {
      ...status,
      collected_at: new Date(now).toISOString(),
      top_projects: leaves.projects,
      sampled_project_count: leaves.sampled,
      total_project_count: leaves.total,
      stale_project_count: Math.max(0, leaves.total - leaves.sampled),
      truncated: leaves.total > leaves.sampled,
    };
  } catch (err) {
    return {
      ...status,
      collected_at: new Date(now).toISOString(),
      top_projects: [],
      sampled_project_count: 0,
      total_project_count: 0,
      stale_project_count: 0,
      truncated: true,
      sampling_error: `${err}`,
    };
  }
}

export const __test__ = {
  parseIoPressure,
  parseIoStat,
  privilegedStatusFailure,
  rates,
};
