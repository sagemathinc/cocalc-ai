#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SRC_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    [
      "Usage: node scripts/dev/host-density-smoke.mjs [options]",
      "",
      "Options:",
      "  --host <name>                 Host id or name to target (default: host1)",
      "  --ssh-target <target>         SSH target for host sampling (default: same as --host)",
      "  --tier <n>                    Target started-project count tier (repeatable)",
      "  --tiers <a,b,c>               Comma-separated target tiers",
      "  --provision-count <n>         Precreate this many inactive projects before starting tiers",
      "  --create-batch-size <n>       Concurrent creates per batch (default: 1)",
      "  --batch-size <n>              Concurrent starts/stops/deletes per batch (default: 1)",
      "  --timeout <ms>                Root CLI/RPC timeout in milliseconds (default: 120000)",
      "  --network-sample-seconds <n>  Per-sample network interval in seconds (default: 20)",
      "  --settle-seconds <n>          Wait time before each host sample (default: 10)",
      "  --prefix <name>               Project title prefix (default: density-canary)",
      "  --rootfs-image <image>        Runtime RootFS image to assign to created projects",
      "  --rootfs-image-id <id>        Managed RootFS catalog entry id to record",
      "  --cleanup-existing            Stop + delete existing prefix-matching host projects, then exit",
      "  --keep-projects               Leave created projects in place on success/failure",
      "  --active-terminal             Keep one terminal session alive per started project",
      "  --no-active-terminal          Disable active terminal sessions",
      "  --terminal-hold-seconds <n>   Sleep time for active terminals (default: 1800)",
      "  --exec-smoke                  Run project exec verification at each tier",
      "  --no-exec-smoke               Disable project exec verification",
      "  --help                        Show this help",
      "",
      "This creates disposable projects pinned to one host, starts them in",
      "batches up to each requested tier, samples host load/network/process",
      "state over SSH, and then stops + soft-deletes the projects by default.",
      "",
      "Example:",
      "  pnpm --dir src smoke:host-density -- \\",
      "    --host host1 \\",
      "    --ssh-target host \\",
      "    --provision-count 1000 \\",
      "    --tiers 5,10,25 \\",
      "    --create-batch-size 10 \\",
      "    --batch-size 5",
    ].join("\n"),
  );
  process.exit(code);
}

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    usageAndExit(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    hostName: "host1",
    sshTarget: "",
    tiers: [],
    provisionCount: 0,
    createBatchSize: 1,
    batchSize: 1,
    timeoutMs: 120_000,
    networkSampleSeconds: 20,
    settleSeconds: 10,
    prefix: "density-canary",
    rootfsImage: "",
    rootfsImageId: "",
    cleanupExisting: false,
    keepProjects: false,
    activeTerminal: false,
    terminalHoldSeconds: 1800,
    execSmoke: false,
  };

  const pushTier = (raw) => {
    const value = parsePositiveInt(raw, "--tier");
    options.tiers.push(value);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--host" && next) {
      options.hostName = next;
      i += 1;
    } else if (arg === "--ssh-target" && next) {
      options.sshTarget = next;
      i += 1;
    } else if (arg === "--tier" && next) {
      pushTier(next);
      i += 1;
    } else if (arg === "--tiers" && next) {
      for (const part of next.split(",")) {
        if (part.trim()) {
          pushTier(part.trim());
        }
      }
      i += 1;
    } else if (arg === "--provision-count" && next) {
      options.provisionCount = parsePositiveInt(next, "--provision-count");
      i += 1;
    } else if (arg === "--create-batch-size" && next) {
      options.createBatchSize = parsePositiveInt(next, "--create-batch-size");
      i += 1;
    } else if (arg === "--batch-size" && next) {
      options.batchSize = parsePositiveInt(next, "--batch-size");
      i += 1;
    } else if (arg === "--timeout" && next) {
      options.timeoutMs = parsePositiveInt(next, "--timeout");
      i += 1;
    } else if (arg === "--network-sample-seconds" && next) {
      options.networkSampleSeconds = parsePositiveInt(
        next,
        "--network-sample-seconds",
      );
      i += 1;
    } else if (arg === "--settle-seconds" && next) {
      options.settleSeconds = parsePositiveInt(next, "--settle-seconds");
      i += 1;
    } else if (arg === "--prefix" && next) {
      options.prefix = next.trim();
      i += 1;
    } else if (arg === "--rootfs-image" && next) {
      options.rootfsImage = next;
      i += 1;
    } else if (arg === "--rootfs-image-id" && next) {
      options.rootfsImageId = next;
      i += 1;
    } else if (arg === "--cleanup-existing") {
      options.cleanupExisting = true;
    } else if (arg === "--keep-projects") {
      options.keepProjects = true;
    } else if (arg === "--active-terminal") {
      options.activeTerminal = true;
    } else if (arg === "--no-active-terminal") {
      options.activeTerminal = false;
    } else if (arg === "--terminal-hold-seconds" && next) {
      options.terminalHoldSeconds = parsePositiveInt(
        next,
        "--terminal-hold-seconds",
      );
      i += 1;
    } else if (arg === "--exec-smoke") {
      options.execSmoke = true;
    } else if (arg === "--no-exec-smoke") {
      options.execSmoke = false;
    } else if (arg === "--help") {
      usageAndExit("", 0);
    } else {
      usageAndExit(`unknown argument: ${arg}`);
    }
  }

  if (!options.prefix.trim()) {
    usageAndExit("--prefix must not be empty");
  }
  if (options.cleanupExisting && options.keepProjects) {
    usageAndExit("--cleanup-existing cannot be combined with --keep-projects");
  }
  if (!options.tiers.length) {
    options.tiers = [5, 10];
  }
  options.tiers = [...new Set(options.tiers)].sort((a, b) => a - b);
  if (!options.sshTarget.trim()) {
    options.sshTarget = options.hostName;
  }
  return options;
}

function shellQuote(value) {
  return `'${`${value ?? ""}`.replace(/'/g, `'\\''`)}'`;
}

function isUuid(value) {
  return UUID_RE.test(`${value ?? ""}`.trim());
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: SRC_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runCocalcJson(cocalcArgs) {
  const cmd = [
    "cd",
    shellQuote(SRC_ROOT),
    "&&",
    'eval "$(node ./scripts/dev/dev-env.js hub --no-start --shell)"',
    "&&",
    "cocalc",
    ...cocalcArgs.map(shellQuote),
  ].join(" ");
  const result = await spawnCapture("bash", ["-lc", cmd]);
  if (result.code !== 0) {
    throw new Error(
      [
        `cocalc exited with code ${result.code}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `unable to parse cocalc JSON output: ${err}\n${result.stdout}`,
    );
  }
  if (!parsed?.ok) {
    throw new Error(JSON.stringify(parsed, null, 2));
  }
  return parsed;
}

function sqlLiteral(value) {
  return `'${`${value ?? ""}`.replace(/'/g, "''")}'`;
}

async function resolveHostIdentifier(hostName) {
  const trimmed = `${hostName ?? ""}`.trim();
  if (!trimmed || isUuid(trimmed)) {
    return trimmed;
  }
  const sql =
    "select id from project_hosts where name = " +
    sqlLiteral(trimmed) +
    " order by case when status = 'running' then 0 else 1 end, id limit 1;";
  const cmd = [
    "cd",
    shellQuote(SRC_ROOT),
    "&&",
    'eval "$(node ./scripts/dev/dev-env.js hub --no-start --shell)"',
    "&&",
    "psql -Atqc",
    shellQuote(sql),
  ].join(" ");
  const result = await spawnCapture("bash", ["-lc", cmd]);
  if (result.code !== 0) {
    throw new Error(
      [
        `host id lookup exited with code ${result.code}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const id = `${result.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => isUuid(line));
  if (!id) {
    throw new Error(`unable to resolve host id for ${trimmed}`);
  }
  return id;
}

async function runSshCapture(sshTarget, remoteScript) {
  const result = await spawnCapture("ssh", [
    "-o",
    "BatchMode=yes",
    sshTarget,
    `bash -lc ${shellQuote(remoteScript)}`,
  ]);
  if (result.code !== 0) {
    throw new Error(
      [
        `ssh exited with code ${result.code}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

async function runRemoteJson({ sshTarget, script }) {
  const stdout = await runSshCapture(sshTarget, script);
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`unable to parse remote JSON: ${err}\n${stdout}`);
  }
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getData(result) {
  return result?.data ?? result;
}

function compactTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}

function parseTimestampMs(raw) {
  const value = Date.parse(`${raw ?? ""}`);
  return Number.isFinite(value) ? value : null;
}

function stepDurationMs(step) {
  const started = parseTimestampMs(step?.started_at);
  const finished = parseTimestampMs(step?.finished_at);
  if (started == null || finished == null) {
    return null;
  }
  return finished - started;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value == null) {
    return "n/a";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${(value / 1000).toFixed(1)}s`;
}

function formatGiBFromKb(value) {
  if (!Number.isFinite(value) || value == null) {
    return "n/a";
  }
  return `${(value / (1024 * 1024)).toFixed(1)}GiB`;
}

function normalizePhaseTimings(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0) {
      out[key] = numeric;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function summarizePhaseTimings(entries, field = "phase_timings_ms") {
  const phases = new Map();
  let projectCount = 0;
  for (const entry of entries ?? []) {
    const timings = normalizePhaseTimings(entry?.[field]);
    if (!timings) {
      continue;
    }
    projectCount += 1;
    for (const [phase, value] of Object.entries(timings)) {
      if (!phases.has(phase)) {
        phases.set(phase, []);
      }
      phases.get(phase).push(value);
    }
  }
  if (!projectCount || !phases.size) {
    return undefined;
  }
  const summary = {
    project_count: projectCount,
    phases: {},
  };
  for (const [phase, valuesRaw] of phases.entries()) {
    const values = [...valuesRaw].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const percentile = (p) => {
      if (!values.length) return null;
      const index = Math.max(
        0,
        Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1),
      );
      return values[index];
    };
    summary.phases[phase] = {
      count: values.length,
      total_ms: total,
      avg_ms: total / values.length,
      min_ms: values[0],
      p50_ms: percentile(50),
      p95_ms: percentile(95),
      max_ms: values[values.length - 1],
    };
  }
  return summary;
}

function summarizeNumericFields(entries, fields) {
  const summary = {};
  let hasValues = false;
  for (const field of fields) {
    const values = [];
    for (const entry of entries ?? []) {
      const numeric = Number(entry?.[field]);
      if (Number.isFinite(numeric) && numeric >= 0) {
        values.push(numeric);
      }
    }
    if (!values.length) {
      continue;
    }
    hasValues = true;
    values.sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const percentile = (p) => {
      const index = Math.max(
        0,
        Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1),
      );
      return values[index];
    };
    summary[field] = {
      count: values.length,
      total_ms: total,
      avg_ms: total / values.length,
      min_ms: values[0],
      p50_ms: percentile(50),
      p95_ms: percentile(95),
      max_ms: values[values.length - 1],
    };
  }
  return hasValues ? summary : undefined;
}

function formatPhaseStat(phaseSummary, phase) {
  const stats = phaseSummary?.phases?.[phase];
  if (!stats) return null;
  return `${phase}=avg:${formatDurationMs(stats.avg_ms)} p95:${formatDurationMs(stats.p95_ms)} max:${formatDurationMs(stats.max_ms)}`;
}

function formatNumericStat(summary, field, label = field) {
  const stats = summary?.[field];
  if (!stats) return null;
  return `${label}=avg:${formatDurationMs(stats.avg_ms)} p95:${formatDurationMs(stats.p95_ms)} max:${formatDurationMs(stats.max_ms)}`;
}

function formatPhaseStatEither(primary, primaryPhase, fallback, fallbackPhase) {
  return (
    formatPhaseStat(primary, primaryPhase) ??
    formatPhaseStat(fallback, fallbackPhase)
  );
}

function findStepByName(steps, name) {
  return steps.find((step) => step?.name === name);
}

function findTierStep(steps, prefix, tier) {
  return (
    findStepByName(steps, `${prefix}:tier_${tier}`) ??
    findStepByName(steps, `${prefix}:${tier}`)
  );
}

function resolveTierTiming({ tier, steps, activeTerminal }) {
  const createStep = findTierStep(steps, "project_create", tier);
  const startStep = findTierStep(steps, "project_start", tier);
  const terminalSpawnStep = findTierStep(steps, "project_terminal_spawn", tier);
  const terminalStateStep = findTierStep(steps, "project_terminal_state", tier);
  const settleStep = findTierStep(steps, "settle", tier);
  const sampleStep = findTierStep(steps, "sample", tier);

  const tierStartMs = [
    createStep,
    startStep,
    terminalSpawnStep,
    terminalStateStep,
    settleStep,
    sampleStep,
  ]
    .map((step) => parseTimestampMs(step?.started_at))
    .find((value) => value != null);

  const readyStep = activeTerminal
    ? (terminalStateStep ?? terminalSpawnStep ?? startStep)
    : startStep;
  const readyFinishedMs = parseTimestampMs(readyStep?.finished_at);
  const createdFinishedMs = parseTimestampMs(createStep?.finished_at);
  const startedFinishedMs = parseTimestampMs(startStep?.finished_at);
  const sampleFinishedMs = parseTimestampMs(sampleStep?.finished_at);

  return {
    create_duration_ms: stepDurationMs(createStep),
    start_duration_ms: stepDurationMs(startStep),
    terminal_spawn_duration_ms: stepDurationMs(terminalSpawnStep),
    terminal_state_duration_ms: stepDurationMs(terminalStateStep),
    settle_duration_ms: stepDurationMs(settleStep),
    sample_duration_ms: stepDurationMs(sampleStep),
    time_to_created_ms:
      tierStartMs != null && createdFinishedMs != null
        ? createdFinishedMs - tierStartMs
        : null,
    time_to_started_ms:
      tierStartMs != null && startedFinishedMs != null
        ? startedFinishedMs - tierStartMs
        : null,
    time_to_ready_ms:
      tierStartMs != null && readyFinishedMs != null
        ? readyFinishedMs - tierStartMs
        : null,
    time_to_sample_ms:
      tierStartMs != null && sampleFinishedMs != null
        ? sampleFinishedMs - tierStartMs
        : null,
  };
}

function printTierSummary({
  tier,
  timing,
  sample,
  startTimingSummary,
  phaseSummary,
  runnerPhaseSummary,
}) {
  const remote = sample?.remote ?? {};
  const loadavg = Array.isArray(remote?.loadavg)
    ? remote.loadavg.map((value) => Number(value).toFixed(2)).join(", ")
    : "n/a";
  const memUsed = formatGiBFromKb(remote?.mem_used_kb);
  const memAvail = formatGiBFromKb(remote?.mem_available_kb);
  const running = remote?.podman_running_project_count ?? "n/a";
  console.error(
    [
      `[host-density] tier ${tier} summary`,
      `create=${formatDurationMs(timing?.create_duration_ms)}`,
      `start=${formatDurationMs(timing?.start_duration_ms)}`,
      `ready=${formatDurationMs(timing?.time_to_ready_ms)}`,
      `sample=${formatDurationMs(timing?.time_to_sample_ms)}`,
      `running=${running}`,
      `load=${loadavg}`,
      `mem_used=${memUsed}`,
      `mem_available=${memAvail}`,
    ].join(" "),
  );
  const startTimingParts = [
    formatNumericStat(startTimingSummary, "queue_duration_ms", "queue"),
    formatNumericStat(startTimingSummary, "wait_duration_ms", "wait"),
    formatNumericStat(startTimingSummary, "duration_ms", "total_start"),
  ].filter(Boolean);
  if (startTimingParts.length > 0) {
    console.error(
      [`[host-density] tier ${tier} orchestration`, ...startTimingParts].join(
        " ",
      ),
    );
  }
  const phaseParts = [
    formatPhaseStat(phaseSummary, "prepare_config"),
    formatPhaseStat(phaseSummary, "cache_rootfs"),
    formatPhaseStat(phaseSummary, "runner_start"),
    formatPhaseStat(phaseSummary, "refresh_authorized_keys"),
    formatPhaseStat(phaseSummary, "total"),
  ].filter(Boolean);
  if (phaseParts.length > 0) {
    console.error(
      [`[host-density] tier ${tier} phases`, ...phaseParts].join(" "),
    );
  }
  const runnerPhaseParts = [
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.resolve_initial_paths",
      runnerPhaseSummary,
      "resolve_initial_paths",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.restore_backup",
      runnerPhaseSummary,
      "restore_backup",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.ensure_local_path",
      runnerPhaseSummary,
      "ensure_local_path",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.mount_rootfs",
      runnerPhaseSummary,
      "mount_rootfs",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.resolve_project_script",
      runnerPhaseSummary,
      "resolve_project_script",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.build_environment",
      runnerPhaseSummary,
      "build_environment",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.prepare_home",
      runnerPhaseSummary,
      "prepare_home",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.set_quota",
      runnerPhaseSummary,
      "set_quota",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.podman_run",
      runnerPhaseSummary,
      "podman_run",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.init_ssh_server",
      runnerPhaseSummary,
      "init_ssh_server",
    ),
    formatPhaseStatEither(
      phaseSummary,
      "runner_start.total",
      runnerPhaseSummary,
      "total",
    ),
  ].filter(Boolean);
  if (runnerPhaseParts.length > 0) {
    console.error(
      [`[host-density] tier ${tier} runner`, ...runnerPhaseParts].join(" "),
    );
  }
}

function projectTitle(prefix, runId, index) {
  return `${prefix}-${runId}-${String(index).padStart(3, "0")}`;
}

function summarizeHostGet(data) {
  const targets = Array.isArray(data?.runtime_status?.targets)
    ? data.runtime_status.targets.map((target) => ({
        target: `${target?.target ?? ""}`.trim(),
        version_state: `${target?.version_state ?? ""}`.trim(),
        runtime_state: `${target?.runtime_state ?? ""}`.trim(),
        running_versions: Array.isArray(target?.running_versions)
          ? target.running_versions
          : [],
      }))
    : [];
  return {
    host_id: `${data?.host_id ?? ""}`.trim(),
    name: `${data?.name ?? ""}`.trim(),
    status: `${data?.status ?? ""}`.trim(),
    size: `${data?.size ?? ""}`.trim(),
    pricing_model: `${data?.pricing_model ?? ""}`.trim(),
    public_ip: `${data?.public_ip ?? ""}`.trim(),
    ssh_server: `${data?.ssh_server ?? ""}`.trim(),
    bootstrap_status: `${data?.bootstrap?.status ?? ""}`.trim(),
    bootstrap_summary_status:
      `${data?.bootstrap_lifecycle?.summary_status ?? ""}`.trim(),
    bootstrap_drift_count: data?.bootstrap_lifecycle?.drift_count ?? null,
    version: `${data?.version ?? ""}`.trim(),
    project_bundle_version: `${data?.project_bundle_version ?? ""}`.trim(),
    tools_version: `${data?.tools_version ?? ""}`.trim(),
    project_host_last_known_good_version:
      `${data?.runtime_status?.repair_state?.project_host_last_known_good_version ?? ""}`.trim(),
    runtime_targets: targets,
  };
}

function remoteHostSampleScript({ sampleSeconds }) {
  return `
python3 - <<'PY'
import json, os, shutil, subprocess, time

sample_seconds = ${JSON.stringify(sampleSeconds)}

def read_default_iface():
    try:
        with open("/proc/net/route", "r", encoding="utf-8") as f:
            next(f, None)
            for line in f:
                parts = line.split()
                if len(parts) >= 11 and parts[1] == "00000000":
                    return parts[0]
    except Exception:
        return None
    return None

def read_net_bytes(iface):
    if not iface:
        return None
    try:
        with open("/proc/net/dev", "r", encoding="utf-8") as f:
            for line in f:
                if ":" not in line:
                    continue
                left, right = line.split(":", 1)
                if left.strip() != iface:
                    continue
                fields = right.split()
                if len(fields) < 16:
                    return None
                return {
                    "rx_bytes": int(fields[0]),
                    "tx_bytes": int(fields[8]),
                }
    except Exception:
        return None
    return None

def read_meminfo():
    values = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as f:
        for line in f:
            if ":" not in line:
                continue
            key, rest = line.split(":", 1)
            values[key.strip()] = int(rest.strip().split()[0])
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    free = values.get("MemFree")
    return {
        "mem_total_kb": total,
        "mem_available_kb": available,
        "mem_free_kb": free,
        "mem_used_kb": (total - available) if total and available else None,
    }

def run_text(command, timeout=10):
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except Exception as err:
        return {
            "ok": False,
            "code": None,
            "stdout": "",
            "stderr": str(err),
        }

iface = read_default_iface()
start = read_net_bytes(iface)
time.sleep(sample_seconds)
end = read_net_bytes(iface)
disk_target = "/mnt/cocalc/data" if os.path.exists("/mnt/cocalc/data") else "/"
disk = shutil.disk_usage(disk_target)
ps = run_text(["ps", "-eo", "args="], timeout=10)
ps_lines = ps["stdout"].splitlines()
conmon_main_count = 0
cloudflared_count = 0
project_host_count = 0
for line in ps_lines:
    if "cloudflared" in line:
      cloudflared_count += 1
    if "project-host" in line:
      project_host_count += 1
    if "conmon" in line and "project-" in line:
        if "--exec-attach" in line or "--exec-process-spec" in line:
            continue
        conmon_main_count += 1

podman_running = run_text(
    ["sudo", "-Hiu", "cocalc-host", "podman", "ps", "--format", "{{.Names}}"],
    timeout=15,
)
podman_all = run_text(
    ["sudo", "-Hiu", "cocalc-host", "podman", "ps", "-a", "--format", "{{.Names}}"],
    timeout=15,
)
podman_running_names = [
    line.strip()
    for line in podman_running["stdout"].splitlines()
    if line.strip()
]
podman_all_names = [
    line.strip()
    for line in podman_all["stdout"].splitlines()
    if line.strip()
]
project_running_names = [
    name for name in podman_running_names if name.startswith("project-")
]
project_all_names = [
    name for name in podman_all_names if name.startswith("project-")
]

result = {
    "sample_seconds": sample_seconds,
    "sampled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "host_hostname": os.uname().nodename,
    "cpu_count": os.cpu_count(),
    "loadavg": list(os.getloadavg()),
    "network_interface": iface,
    "network_start": start,
    "network_end": end,
    "network_delta": None,
    "disk_target": disk_target,
    "disk_total_bytes": disk.total,
    "disk_used_bytes": disk.used,
    "disk_free_bytes": disk.free,
    "conmon_main_count": conmon_main_count,
    "cloudflared_count": cloudflared_count,
    "project_host_process_count": project_host_count,
    "podman_running_project_count": len(project_running_names),
    "podman_all_project_count": len(project_all_names),
    "podman_running_names_preview": project_running_names[:20],
    "podman_all_names_preview": project_all_names[:20],
    "podman_running_error": None if podman_running["ok"] else podman_running["stderr"],
    "podman_all_error": None if podman_all["ok"] else podman_all["stderr"],
}
result.update(read_meminfo())
if start and end:
    result["network_delta"] = {
        "rx_bytes": end["rx_bytes"] - start["rx_bytes"],
        "tx_bytes": end["tx_bytes"] - start["tx_bytes"],
    }
print(json.dumps(result))
PY
`.trim();
}

async function sampleHostState({
  hostIdentifier,
  sshTarget,
  globalArgs,
  sampleSeconds,
}) {
  const [hostGetResult, remoteResult] = await Promise.allSettled([
    runCocalcJson([
      "--json",
      "--timeout",
      "10s",
      "--rpc-timeout",
      "10s",
      "host",
      "get",
      hostIdentifier,
    ]),
    runRemoteJson({
      sshTarget,
      script: remoteHostSampleScript({ sampleSeconds }),
    }),
  ]);
  if (remoteResult.status !== "fulfilled") {
    throw remoteResult.reason;
  }
  return {
    host_get:
      hostGetResult.status === "fulfilled"
        ? summarizeHostGet(getData(hostGetResult.value))
        : {
            error: `${hostGetResult.reason?.stack ?? hostGetResult.reason}`,
            host_identifier: hostIdentifier,
          },
    remote: remoteResult.value,
  };
}

async function createProject({
  index,
  runId,
  hostName,
  prefix,
  rootfsImage,
  rootfsImageId,
  globalArgs,
}) {
  const title = projectTitle(prefix, runId, index);
  const args = [...globalArgs, "project", "create", "--host", hostName];
  if (rootfsImage.trim()) {
    args.push("--rootfs-image", rootfsImage);
  }
  if (rootfsImageId.trim()) {
    args.push("--rootfs-image-id", rootfsImageId);
  }
  args.push(title);
  const startedAt = Date.now();
  const result = await runCocalcJson(args);
  const data = getData(result);
  return {
    index,
    project_id: `${data?.project_id ?? ""}`.trim(),
    title: `${data?.title ?? title}`.trim(),
    host_id: `${data?.host_id ?? ""}`.trim(),
    started: Boolean(data?.started),
    duration_ms: Date.now() - startedAt,
  };
}

async function listHostProjects({ hostIdentifier, globalArgs }) {
  const rows = [];
  let cursor;
  do {
    const args = [...globalArgs, "host", "projects", hostIdentifier, "--all"];
    if (cursor) {
      args.push("--cursor", cursor);
    }
    const result = await runCocalcJson(args);
    const pageRows = Array.isArray(result?.data?.rows) ? result.data.rows : [];
    rows.push(...pageRows);
    cursor = `${result?.data?.next_cursor ?? ""}`.trim() || undefined;
  } while (cursor);
  return rows;
}

async function listExistingCleanupProjects({
  hostIdentifier,
  prefix,
  globalArgs,
}) {
  const trimmedPrefix = `${prefix ?? ""}`.trim();
  const rows = await listHostProjects({ hostIdentifier, globalArgs });
  return rows
    .filter((row) => `${row?.title ?? ""}`.startsWith(trimmedPrefix))
    .map((row) => ({
      project_id: `${row?.project_id ?? ""}`.trim(),
      title: `${row?.title ?? ""}`.trim(),
      state: `${row?.state ?? ""}`.trim(),
      host_id: `${row?.host_id ?? hostIdentifier}`.trim(),
    }))
    .filter((row) => row.project_id);
}

async function startProject({ projectId, globalArgs }) {
  const startedAt = Date.now();
  const queued = await runCocalcJson([
    ...globalArgs,
    "project",
    "start",
    "-w",
    projectId,
  ]);
  const queueFinishedAt = Date.now();
  const queuedData = getData(queued);
  const opId = `${queuedData?.op_id ?? ""}`.trim();
  ensure(opId, `missing start op_id for ${projectId}`);
  const waited = await runCocalcJson([...globalArgs, "op", "wait", opId]);
  const waitedData = getData(waited);
  const status = `${waitedData?.status ?? ""}`.trim();
  if (status !== "succeeded") {
    throw new Error(
      `project start op ${opId} for ${projectId} finished with status=${status} error=${waitedData?.error ?? "unknown"}`,
    );
  }
  const resultSummary = waitedData?.result;
  const progressSummary = waitedData?.progress_summary;
  const phaseTimings =
    normalizePhaseTimings(resultSummary?.phase_timings_ms) ??
    normalizePhaseTimings(progressSummary?.phase_timings_ms);
  const runnerPhaseTimings =
    normalizePhaseTimings(resultSummary?.runner_phase_timings_ms) ??
    normalizePhaseTimings(progressSummary?.runner_phase_timings_ms);
  return {
    project_id: projectId,
    status,
    op_id: opId,
    queue_duration_ms: queueFinishedAt - startedAt,
    wait_duration_ms: Date.now() - queueFinishedAt,
    duration_ms: Date.now() - startedAt,
    phase_timings_ms: phaseTimings,
    runner_phase_timings_ms: runnerPhaseTimings,
  };
}

async function stopProject({ projectId, globalArgs }) {
  const startedAt = Date.now();
  const result = await runCocalcJson([
    ...globalArgs,
    "project",
    "stop",
    "-w",
    projectId,
    "--wait",
  ]);
  const data = getData(result);
  return {
    project_id: projectId,
    status: `${data?.status ?? ""}`.trim(),
    op_id: `${data?.op_id ?? ""}`.trim(),
    duration_ms: Date.now() - startedAt,
  };
}

async function deleteProject({ projectId, globalArgs }) {
  const startedAt = Date.now();
  const result = await runCocalcJson([
    ...globalArgs,
    "project",
    "delete",
    "-w",
    projectId,
  ]);
  return {
    project_id: projectId,
    ok: Boolean(result?.ok),
    duration_ms: Date.now() - startedAt,
  };
}

async function execSmoke({ projectId, globalArgs }) {
  const result = await runCocalcJson([
    ...globalArgs,
    "project",
    "exec",
    "-w",
    projectId,
    "--bash",
    "echo DENSITY_OK && hostname && nproc",
  ]);
  const data = getData(result);
  const stdout = `${data?.stdout ?? ""}`;
  ensure(
    stdout.includes("DENSITY_OK"),
    `project exec did not print DENSITY_OK for ${projectId}`,
  );
  return {
    project_id: projectId,
    exit_code: data?.exit_code ?? null,
    stdout: stdout.trim(),
    stderr: `${data?.stderr ?? ""}`.trim(),
  };
}

async function spawnActiveTerminal({
  projectId,
  terminalId,
  holdSeconds,
  globalArgs,
}) {
  const result = await runCocalcJson([
    ...globalArgs,
    "project",
    "terminal",
    "spawn",
    "-w",
    projectId,
    "--id",
    terminalId,
    "--bash",
    `echo DENSITY_ACTIVE; sleep ${holdSeconds}`,
  ]);
  const data = getData(result);
  return {
    project_id: projectId,
    id: `${data?.id ?? terminalId}`.trim(),
    pid: data?.pid ?? null,
    history: `${data?.history ?? ""}`,
  };
}

async function getTerminalState({ projectId, terminalId, globalArgs }) {
  const result = await runCocalcJson([
    ...globalArgs,
    "project",
    "terminal",
    "state",
    terminalId,
    "-w",
    projectId,
  ]);
  return {
    project_id: projectId,
    id: terminalId,
    state: `${getData(result) ?? ""}`.trim(),
  };
}

async function runInBatches(items, batchSize, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((item, batchIndex) => worker(item, i + batchIndex)),
    );
    const failures = settled
      .map((entry, idx) =>
        entry.status === "rejected"
          ? {
              item: batch[idx],
              error: `${entry.reason?.stack ?? entry.reason}`,
            }
          : null,
      )
      .filter(Boolean);
    if (failures.length > 0) {
      throw new Error(JSON.stringify({ failures }, null, 2));
    }
    for (const entry of settled) {
      results.push(entry.value);
    }
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hostIdentifier = await resolveHostIdentifier(options.hostName);
  const maxTier = Math.max(...options.tiers);
  const targetProvisionCount =
    options.provisionCount > 0 ? Math.max(options.provisionCount, maxTier) : 0;
  const timeoutSeconds = Math.ceil(options.timeoutMs / 1000);
  const globalArgs = [
    "--json",
    "--timeout",
    `${timeoutSeconds}s`,
    "--rpc-timeout",
    `${timeoutSeconds}s`,
  ];
  const runId = compactTimestamp();
  const createdProjects = [];
  const startedProjectIds = new Set();
  const startedProjectResults = new Map();
  const activeTerminals = new Map();
  const preprovision = {
    requested_count: options.provisionCount,
    effective_count: targetProvisionCount,
    created: [],
    sample: null,
    timing: null,
  };
  const tierResults = [];
  const steps = [];
  let baselineSample = null;
  let postCleanupSample = null;
  let failure = null;

  const runStep = async (name, fn) => {
    const startedAt = new Date().toISOString();
    console.error(`[host-density] ${name}: start`);
    try {
      const detail = await fn();
      const finishedAt = new Date().toISOString();
      steps.push({
        name,
        status: "ok",
        started_at: startedAt,
        finished_at: finishedAt,
        detail,
      });
      console.error(`[host-density] ${name}: ok`);
      return detail;
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const error = `${err?.stack ?? err}`;
      steps.push({
        name,
        status: "failed",
        started_at: startedAt,
        finished_at: finishedAt,
        error,
      });
      console.error(`[host-density] ${name}: failed\n${error}`);
      throw err;
    }
  };

  try {
    baselineSample = await runStep("sample:baseline", async () => {
      return await sampleHostState({
        hostIdentifier,
        sshTarget: options.sshTarget,
        globalArgs,
        sampleSeconds: options.networkSampleSeconds,
      });
    });

    if (options.cleanupExisting) {
      const existingProjects = await runStep(
        "project_list:cleanup_existing",
        async () => {
          return await listExistingCleanupProjects({
            hostIdentifier,
            prefix: options.prefix,
            globalArgs,
          });
        },
      );
      createdProjects.push(...existingProjects);
      for (const project of existingProjects) {
        if (project.state === "running" || project.state === "starting") {
          startedProjectIds.add(project.project_id);
        }
      }
      console.error(
        [
          "[host-density] cleanup-existing summary",
          `matched=${existingProjects.length}`,
          `running=${startedProjectIds.size}`,
          `opened=${existingProjects.length - startedProjectIds.size}`,
        ].join(" "),
      );
    } else if (targetProvisionCount > 0) {
      const createSpecs = [];
      for (
        let nextIndex = 1;
        nextIndex <= targetProvisionCount;
        nextIndex += 1
      ) {
        createSpecs.push(nextIndex);
      }
      preprovision.created = await runStep(
        `project_create:provisioned_${targetProvisionCount}`,
        async () => {
          return await runInBatches(
            createSpecs,
            options.createBatchSize,
            async (index) => {
              return await createProject({
                index,
                runId,
                hostName: hostIdentifier,
                prefix: options.prefix,
                rootfsImage: options.rootfsImage,
                rootfsImageId: options.rootfsImageId,
                globalArgs,
              });
            },
          );
        },
      );
      createdProjects.push(...preprovision.created);
      preprovision.timing = resolveTierTiming({
        tier: `provisioned_${targetProvisionCount}`,
        steps,
        activeTerminal: false,
      });
      console.error(
        [
          `[host-density] provisioned ${targetProvisionCount} summary`,
          `create=${formatDurationMs(preprovision.timing?.create_duration_ms)}`,
          `ready=${formatDurationMs(preprovision.timing?.time_to_created_ms)}`,
        ].join(" "),
      );

      if (options.settleSeconds > 0) {
        await runStep(
          `settle:provisioned_${targetProvisionCount}`,
          async () => {
            await sleep(options.settleSeconds * 1000);
            return { settle_seconds: options.settleSeconds };
          },
        );
      }

      preprovision.sample = await runStep(
        `sample:provisioned_${targetProvisionCount}`,
        async () => {
          return await sampleHostState({
            hostIdentifier,
            sshTarget: options.sshTarget,
            globalArgs,
            sampleSeconds: options.networkSampleSeconds,
          });
        },
      );
    }

    for (const tier of options.cleanupExisting ? [] : options.tiers) {
      const createSpecs = [];
      for (
        let nextIndex = createdProjects.length + 1;
        nextIndex <= tier;
        nextIndex += 1
      ) {
        createSpecs.push(nextIndex);
      }
      const createdThisTier = createSpecs.length
        ? await runStep(`project_create:tier_${tier}`, async () => {
            return await runInBatches(
              createSpecs,
              options.createBatchSize,
              async (index) => {
                return await createProject({
                  index,
                  runId,
                  hostName: hostIdentifier,
                  prefix: options.prefix,
                  rootfsImage: options.rootfsImage,
                  rootfsImageId: options.rootfsImageId,
                  globalArgs,
                });
              },
            );
          })
        : [];
      createdProjects.push(...createdThisTier);

      const toStart = createdProjects
        .slice(0, tier)
        .filter((project) => !startedProjectIds.has(project.project_id));

      const startedThisTier = toStart.length
        ? await runStep(`project_start:tier_${tier}`, async () => {
            return await runInBatches(
              toStart,
              options.batchSize,
              async (project) => {
                const started = await startProject({
                  projectId: project.project_id,
                  globalArgs,
                });
                startedProjectIds.add(project.project_id);
                startedProjectResults.set(project.project_id, started);
                return started;
              },
            );
          })
        : [];

      const activeTerminalResults = [];
      if (options.activeTerminal) {
        const toActivate = createdProjects
          .slice(0, tier)
          .filter((project) => !activeTerminals.has(project.project_id));

        if (toActivate.length > 0) {
          const spawnedTerminals = await runStep(
            `project_terminal_spawn:tier_${tier}`,
            async () => {
              return await runInBatches(
                toActivate,
                options.batchSize,
                async (project) => {
                  const terminalId = `density-${runId}-${project.project_id.slice(0, 8)}`;
                  const spawned = await spawnActiveTerminal({
                    projectId: project.project_id,
                    terminalId,
                    holdSeconds: options.terminalHoldSeconds,
                    globalArgs,
                  });
                  activeTerminals.set(project.project_id, spawned.id);
                  return spawned;
                },
              );
            },
          );
          activeTerminalResults.push(...spawnedTerminals);
        }

        const terminalChecks = await runStep(
          `project_terminal_state:tier_${tier}`,
          async () => {
            return await runInBatches(
              createdProjects.slice(0, tier),
              options.batchSize,
              async (project) => {
                const terminalId = activeTerminals.get(project.project_id);
                ensure(
                  terminalId,
                  `missing active terminal id for ${project.project_id}`,
                );
                const state = await getTerminalState({
                  projectId: project.project_id,
                  terminalId,
                  globalArgs,
                });
                ensure(
                  state.state === "running",
                  `terminal ${terminalId} for ${project.project_id} is ${state.state}`,
                );
                return state;
              },
            );
          },
        );
        activeTerminalResults.push(
          ...terminalChecks.map((entry) => ({
            ...entry,
            verified_running: true,
          })),
        );
      }

      if (options.settleSeconds > 0) {
        await runStep(`settle:tier_${tier}`, async () => {
          await sleep(options.settleSeconds * 1000);
          return { settle_seconds: options.settleSeconds };
        });
      }

      const sample = await runStep(`sample:tier_${tier}`, async () => {
        return await sampleHostState({
          hostIdentifier,
          sshTarget: options.sshTarget,
          globalArgs,
          sampleSeconds: options.networkSampleSeconds,
        });
      });

      const execResults = [];
      if (options.execSmoke) {
        const execTargets = [];
        if (createdProjects[0]) {
          execTargets.push(createdProjects[0].project_id);
        }
        const lastProject = createdProjects[tier - 1];
        if (lastProject && !execTargets.includes(lastProject.project_id)) {
          execTargets.push(lastProject.project_id);
        }
        for (const projectId of execTargets) {
          const execResult = await runStep(
            `project_exec:tier_${tier}:${projectId.slice(0, 8)}`,
            async () => {
              return await execSmoke({ projectId, globalArgs });
            },
          );
          execResults.push(execResult);
        }
      }

      const timing = resolveTierTiming({
        tier,
        steps,
        activeTerminal: options.activeTerminal,
      });
      const phaseTimingSummary = summarizePhaseTimings(startedThisTier);
      const startTimingSummary = summarizeNumericFields(startedThisTier, [
        "queue_duration_ms",
        "wait_duration_ms",
        "duration_ms",
      ]);
      const runnerPhaseTimingSummary = summarizePhaseTimings(
        startedThisTier,
        "runner_phase_timings_ms",
      );
      const cumulativePhaseTimingSummary = summarizePhaseTimings(
        createdProjects
          .slice(0, tier)
          .map((project) => startedProjectResults.get(project.project_id))
          .filter(Boolean),
      );
      const cumulativeStartTimingSummary = summarizeNumericFields(
        createdProjects
          .slice(0, tier)
          .map((project) => startedProjectResults.get(project.project_id))
          .filter(Boolean),
        ["queue_duration_ms", "wait_duration_ms", "duration_ms"],
      );
      const cumulativeRunnerPhaseTimingSummary = summarizePhaseTimings(
        createdProjects
          .slice(0, tier)
          .map((project) => startedProjectResults.get(project.project_id))
          .filter(Boolean),
        "runner_phase_timings_ms",
      );

      tierResults.push({
        tier,
        created_count: createdProjects.length,
        started_count: startedProjectIds.size,
        created_this_tier: createdThisTier,
        started_this_tier: startedThisTier,
        start_timing_summary: startTimingSummary,
        phase_timing_summary: phaseTimingSummary,
        runner_phase_timing_summary: runnerPhaseTimingSummary,
        cumulative_start_timing_summary: cumulativeStartTimingSummary,
        cumulative_phase_timing_summary: cumulativePhaseTimingSummary,
        cumulative_runner_phase_timing_summary:
          cumulativeRunnerPhaseTimingSummary,
        active_terminal: activeTerminalResults,
        sample,
        exec_smoke: execResults,
        timing,
      });
      printTierSummary({
        tier,
        timing,
        sample,
        startTimingSummary,
        phaseSummary: phaseTimingSummary,
        runnerPhaseSummary: runnerPhaseTimingSummary,
      });
    }
  } catch (err) {
    failure = `${err?.stack ?? err}`;
  }

  const cleanup = {
    keep_projects: options.keepProjects,
    stop_results: [],
    stop_errors: [],
    delete_results: [],
    delete_errors: [],
  };

  if (!options.keepProjects) {
    const started = createdProjects.filter((project) =>
      startedProjectIds.has(project.project_id),
    );
    for (let i = started.length - 1; i >= 0; i -= options.batchSize) {
      const batch = started
        .slice(Math.max(0, i - options.batchSize + 1), i + 1)
        .reverse();
      const settled = await Promise.allSettled(
        batch.map(async (project) => {
          return await stopProject({
            projectId: project.project_id,
            globalArgs,
          });
        }),
      );
      for (let j = 0; j < settled.length; j += 1) {
        const entry = settled[j];
        if (entry.status === "fulfilled") {
          cleanup.stop_results.push(entry.value);
        } else {
          cleanup.stop_errors.push({
            project_id: batch[j].project_id,
            error: `${entry.reason?.stack ?? entry.reason}`,
          });
        }
      }
    }

    for (let i = createdProjects.length - 1; i >= 0; i -= options.batchSize) {
      const batch = createdProjects
        .slice(Math.max(0, i - options.batchSize + 1), i + 1)
        .reverse();
      const settled = await Promise.allSettled(
        batch.map(async (project) => {
          return await deleteProject({
            projectId: project.project_id,
            globalArgs,
          });
        }),
      );
      for (let j = 0; j < settled.length; j += 1) {
        const entry = settled[j];
        if (entry.status === "fulfilled") {
          cleanup.delete_results.push(entry.value);
        } else {
          cleanup.delete_errors.push({
            project_id: batch[j].project_id,
            error: `${entry.reason?.stack ?? entry.reason}`,
          });
        }
      }
    }

    try {
      if (options.settleSeconds > 0) {
        await sleep(options.settleSeconds * 1000);
      }
      postCleanupSample = await sampleHostState({
        hostIdentifier,
        sshTarget: options.sshTarget,
        globalArgs,
        sampleSeconds: options.networkSampleSeconds,
      });
    } catch (err) {
      cleanup.post_cleanup_sample_error = `${err?.stack ?? err}`;
    }
  }

  const summary = {
    ok: failure == null,
    error: failure,
    run_id: runId,
    host_name: options.hostName,
    host_identifier: hostIdentifier,
    ssh_target: options.sshTarget,
    tiers: options.tiers,
    provision_count: options.provisionCount,
    create_batch_size: options.createBatchSize,
    batch_size: options.batchSize,
    timeout_ms: options.timeoutMs,
    network_sample_seconds: options.networkSampleSeconds,
    settle_seconds: options.settleSeconds,
    prefix: options.prefix,
    rootfs_image: options.rootfsImage || null,
    rootfs_image_id: options.rootfsImageId || null,
    cleanup_existing: options.cleanupExisting,
    keep_projects: options.keepProjects,
    active_terminal: options.activeTerminal,
    terminal_hold_seconds: options.terminalHoldSeconds,
    exec_smoke: options.execSmoke,
    baseline_sample: baselineSample,
    preprovision,
    tier_results: tierResults,
    created_projects: createdProjects,
    cleanup,
    post_cleanup_sample: postCleanupSample,
    steps,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failure != null) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`host density smoke failed: ${err?.stack ?? err}`);
  process.exit(1);
});
