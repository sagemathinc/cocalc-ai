/*
Benchmark rustic project-backup repo layouts on a remote host over SSH.

This is aimed at the architectural question:

  - one repo per project
  - one shared repo per region
  - sharded shared repos per region

The harness measures the operations that matter most for CoCalc:

  - backup latency for one target project after unrelated snapshots exist
  - `rustic snapshots --filter-host project-...`
  - current CoCalc wrapper validation behavior (`snapshots --json` then find id)
  - direct exact-id lookup using `rustic snapshots <id> --json`
  - `rustic repoinfo --json`

The synthetic dataset is intentionally small so the measurements emphasize
metadata/index behavior and scaling with unrelated snapshots, not raw network or
bulk throughput.
*/

import { spawn } from "node:child_process";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:cloud:smoke-runner:project-backup-rustic");

export type RusticScaleLayout =
  | { kind: "per-project" }
  | { kind: "shared" }
  | { kind: "sharded"; shard_count: number };

export type RusticScaleBenchmarkOptions = {
  host: string;
  user?: string;
  sudo_user?: string;
  port?: number;
  identity?: string;
  workdir?: string;
  layouts?: RusticScaleLayout[];
  project_counts?: number[];
  snapshots_per_project?: number;
  common_file_count?: number;
  common_file_size_bytes?: number;
  target_project_index?: number;
  log?: (event: {
    step: string;
    status: "start" | "ok" | "failed";
    message?: string;
  }) => void;
};

export type RusticScaleMeasurement = {
  layout_kind: "per-project" | "shared" | "sharded";
  shard_count: number;
  project_count: number;
  snapshots_per_project: number;
  repo_count: number;
  total_snapshots: number;
  target_project: string;
  target_snapshot_id: string;
  timings_ms: Record<string, number>;
  outputs: {
    filter_host_snapshot_count: number;
    wrapper_all_snapshot_count: number;
    all_snapshots_stdout_bytes: number;
  };
  error?: string;
};

export type RusticScaleBenchmarkResult = {
  ok: boolean;
  host: string;
  user: string;
  port: number;
  workdir: string;
  python_version?: string;
  rustic_version?: string;
  started_at: string;
  finished_at: string;
  layouts: RusticScaleLayout[];
  project_counts: number[];
  snapshots_per_project: number;
  measurements: RusticScaleMeasurement[];
  error?: string;
};

type RemoteOptions = {
  workdir: string;
  layouts: RusticScaleLayout[];
  project_counts: number[];
  snapshots_per_project: number;
  common_file_count: number;
  common_file_size_bytes: number;
  target_project_index: number;
};

function sshTarget({ user, host }: { user: string; host: string }): string {
  return `${user}@${host}`;
}

function remotePythonProgram(opts: RemoteOptions): string {
  const optionsJson = JSON.stringify(opts);
  return `
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

OPTIONS = json.loads(${JSON.stringify(optionsJson)})
RUSTIC = "/opt/cocalc/tools/current/rustic"
PASSWORD = "cocalc-rustic-bench"
ENV = os.environ.copy()
ENV["RUSTIC_NO_PROGRESS"] = "true"
ENV["RUSTIC_LOG_LEVEL"] = "error"


def run(cmd, *, cwd=None, check=True):
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        env=ENV,
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"command failed rc={proc.returncode}: {' '.join(cmd)}\\n"
            f"stdout={proc.stdout[:2000]}\\n"
            f"stderr={proc.stderr[:2000]}"
        )
    return proc


def timed(cmd, *, cwd=None):
    start = time.perf_counter()
    proc = run(cmd, cwd=cwd)
    end = time.perf_counter()
    return proc, (end - start) * 1000.0


def rustic_cmd(repo_path):
    return [RUSTIC, "-r", f"local:{repo_path}", "--password", PASSWORD]


def init_repo(repo_path):
    repo_path.mkdir(parents=True, exist_ok=True)
    config_file = repo_path / "config"
    if config_file.exists():
        return
    run(rustic_cmd(repo_path) + ["init"])


def list_repo_dirs(root):
    if not root.exists():
        return []
    return sorted([path for path in root.rglob("*") if path.is_dir() and (path / "config").exists()])


def flatten_snapshot_groups(parsed):
    if not isinstance(parsed, list):
        return []
    snapshots = []
    for group in parsed:
        if isinstance(group, dict) and isinstance(group.get("snapshots"), list):
            snapshots.extend(group["snapshots"])
        elif isinstance(group, list) and len(group) >= 2 and isinstance(group[1], list):
            snapshots.extend(group[1])
    return snapshots


def project_name(index):
    return f"project-{index:05d}"


def shard_index(name, shard_count):
    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % shard_count


def repo_path_for(layout, name, repos_root):
    kind = layout["kind"]
    if kind == "per-project":
        return repos_root / kind / name
    if kind == "shared":
        return repos_root / kind / "region"
    if kind == "sharded":
        shard = shard_index(name, int(layout["shard_count"]))
        return repos_root / kind / f"shard-{shard:02d}"
    raise RuntimeError(f"unsupported layout {kind}")


def prepare_common_payload(fixtures_root, count, size_bytes):
    fixtures_root.mkdir(parents=True, exist_ok=True)
    payload = (b"0123456789abcdef" * ((size_bytes // 16) + 1))[:size_bytes]
    for idx in range(count):
        path = fixtures_root / f"common-{idx:02d}.bin"
        if not path.exists():
            path.write_bytes(payload)


def materialize_project(project_root, name, fixtures_root):
    if project_root.exists():
        shutil.rmtree(project_root)
    project_root.mkdir(parents=True, exist_ok=True)
    for fixture in sorted(fixtures_root.glob("common-*.bin")):
        shutil.copyfile(fixture, project_root / fixture.name)
    (project_root / "notes.txt").write_text(
        f"project={name}\\nseed=baseline\\n",
        encoding="utf-8",
    )


def mutate_project(project_root, snapshot_round):
    with (project_root / "notes.txt").open("a", encoding="utf-8") as out:
        out.write(f"round={snapshot_round}\\n")


def backup_project(repo_path, project_root, name):
    cmd = rustic_cmd(repo_path) + [
        "backup",
        "--json",
        "--no-scan",
        "--host",
        name,
        str(project_root),
    ]
    proc = run(cmd)
    return json.loads(proc.stdout)


def latest_snapshot_for_host(repo_path, host_name):
    proc = run(
        rustic_cmd(repo_path) + [
            "snapshots",
            "--json",
            "--filter-host",
            host_name,
        ]
    )
    parsed = json.loads(proc.stdout or "[]")
    snapshots = flatten_snapshot_groups(parsed)
    snapshots.sort(key=lambda entry: entry.get("time", ""))
    if not snapshots:
        raise RuntimeError(f"no snapshots found for {host_name} in {repo_path}")
    return snapshots[-1]["id"], len(snapshots)


def measure_repo(repo_path, target_host, target_snapshot_id, target_project_root):
    result = {
        "timings_ms": {},
        "outputs": {
            "filter_host_snapshot_count": 0,
            "wrapper_all_snapshot_count": 0,
            "all_snapshots_stdout_bytes": 0,
        },
    }

    proc, ms = timed(
        rustic_cmd(repo_path) + [
            "snapshots",
            "--json",
            "--filter-host",
            target_host,
        ]
    )
    parsed = json.loads(proc.stdout or "[]")
    filtered = flatten_snapshot_groups(parsed)
    result["timings_ms"]["snapshots_filter_host"] = ms
    result["outputs"]["filter_host_snapshot_count"] = len(filtered)

    proc, ms = timed(rustic_cmd(repo_path) + ["snapshots", "--json"])
    parsed = json.loads(proc.stdout or "[]")
    flattened = flatten_snapshot_groups(parsed)
    found = next((snap for snap in flattened if snap.get("id") == target_snapshot_id), None)
    if found is None:
        raise RuntimeError(f"target snapshot {target_snapshot_id} not found in wrapper scan")
    result["timings_ms"]["snapshot_lookup_wrapper_scan"] = ms
    result["outputs"]["wrapper_all_snapshot_count"] = len(flattened)
    result["outputs"]["all_snapshots_stdout_bytes"] = len(proc.stdout.encode("utf-8"))

    proc, ms = timed(
        rustic_cmd(repo_path) + ["snapshots", "--json", target_snapshot_id]
    )
    parsed = json.loads(proc.stdout or "[]")
    direct = flatten_snapshot_groups(parsed)
    if not any(snap.get("id") == target_snapshot_id for snap in direct):
        raise RuntimeError(f"direct snapshot lookup failed for {target_snapshot_id}")
    result["timings_ms"]["snapshot_lookup_direct_id"] = ms

    _, ms = timed(rustic_cmd(repo_path) + ["repoinfo", "--json"])
    result["timings_ms"]["repoinfo"] = ms

    mutate_project(target_project_root, 999999)
    _, ms = timed(
        rustic_cmd(repo_path) + [
            "backup",
            "--json",
            "--no-scan",
            "--host",
            target_host,
            str(target_project_root),
        ]
    )
    result["timings_ms"]["backup_after_change"] = ms
    return result


def repo_count_for_layout(layout, project_names):
    if layout["kind"] == "per-project":
        return len(project_names)
    if layout["kind"] == "shared":
        return 1 if project_names else 0
    shards = {shard_index(name, int(layout["shard_count"])) for name in project_names}
    return len(shards)


def benchmark_layout(layout, project_count, base_root):
    projects_root = base_root / "projects"
    repos_root = base_root / "repos"
    fixtures_root = base_root / "fixtures"
    prepare_common_payload(
        fixtures_root,
        int(OPTIONS["common_file_count"]),
        int(OPTIONS["common_file_size_bytes"]),
    )
    if projects_root.exists():
        shutil.rmtree(projects_root)
    if repos_root.exists():
        shutil.rmtree(repos_root)
    projects_root.mkdir(parents=True, exist_ok=True)
    repos_root.mkdir(parents=True, exist_ok=True)

    project_names = [project_name(i) for i in range(project_count)]
    snapshots_per_project = int(OPTIONS["snapshots_per_project"])

    for name in project_names:
        materialize_project(projects_root / name, name, fixtures_root)

    for name in project_names:
        repo_path = repo_path_for(layout, name, repos_root)
        init_repo(repo_path)
        project_root = projects_root / name
        for snapshot_round in range(snapshots_per_project):
            if snapshot_round:
                mutate_project(project_root, snapshot_round)
            backup_project(repo_path, project_root, name)

    target_idx = min(int(OPTIONS["target_project_index"]), project_count - 1)
    target_host = project_names[target_idx]
    target_repo = repo_path_for(layout, target_host, repos_root)
    target_snapshot_id, filtered_count = latest_snapshot_for_host(target_repo, target_host)
    measurements = measure_repo(
        target_repo,
        target_host,
        target_snapshot_id,
        projects_root / target_host,
    )
    measurements["outputs"]["filter_host_snapshot_count"] = filtered_count
    return {
        "layout_kind": layout["kind"],
        "shard_count": int(layout.get("shard_count") or 1),
        "project_count": project_count,
        "snapshots_per_project": snapshots_per_project,
        "repo_count": repo_count_for_layout(layout, project_names),
        "total_snapshots": project_count * snapshots_per_project,
        "target_project": target_host,
        "target_snapshot_id": target_snapshot_id,
        **measurements,
    }


def main():
    workdir = Path(OPTIONS["workdir"]).resolve()
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    result = {
        "ok": True,
        "python_version": sys.version.split()[0],
        "rustic_version": "",
        "measurements": [],
    }
    try:
        result["rustic_version"] = run([RUSTIC, "--version"]).stdout.strip()
        for layout in OPTIONS["layouts"]:
            for project_count in OPTIONS["project_counts"]:
                scenario_root = workdir / f"{layout['kind']}-count-{project_count}"
                if scenario_root.exists():
                    shutil.rmtree(scenario_root)
                scenario_root.mkdir(parents=True, exist_ok=True)
                try:
                    measurement = benchmark_layout(layout, int(project_count), scenario_root)
                except Exception as err:
                    measurement = {
                        "layout_kind": layout["kind"],
                        "shard_count": int(layout.get("shard_count") or 1),
                        "project_count": int(project_count),
                        "snapshots_per_project": int(OPTIONS["snapshots_per_project"]),
                        "repo_count": 0,
                        "total_snapshots": int(project_count) * int(OPTIONS["snapshots_per_project"]),
                        "target_project": "",
                        "target_snapshot_id": "",
                        "timings_ms": {},
                        "outputs": {
                            "filter_host_snapshot_count": 0,
                            "wrapper_all_snapshot_count": 0,
                            "all_snapshots_stdout_bytes": 0,
                        },
                        "error": str(err),
                    }
                    result["ok"] = False
                result["measurements"].append(measurement)
    except Exception as err:
        result["ok"] = False
        result["error"] = str(err)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
`;
}

async function runRemotePython({
  host,
  user,
  sudo_user,
  port,
  identity,
  script,
}: {
  host: string;
  user: string;
  sudo_user?: string;
  port: number;
  identity?: string;
  script: string;
}): Promise<string> {
  const args = ["-o", "BatchMode=yes"];
  if (identity) {
    args.push("-i", identity);
  }
  if (port !== 22) {
    args.push("-p", `${port}`);
  }
  args.push(sshTarget({ user, host }));
  if (sudo_user) {
    args.push("sudo", "-u", sudo_user, "python3", "-");
  } else {
    args.push("python3", "-");
  }
  const child = spawn("ssh", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(script);
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(
      `ssh remote benchmark failed with code ${code}: ${stderr || stdout}`,
    );
  }
  if (stderr.trim()) {
    logger.debug("project-backup rustic scale remote stderr", { stderr });
  }
  return stdout;
}

export async function runProjectBackupRusticScaleBenchmark(
  opts: RusticScaleBenchmarkOptions,
): Promise<RusticScaleBenchmarkResult> {
  const user = opts.user ?? "ubuntu";
  const sudo_user = opts.sudo_user;
  const port = opts.port ?? 22;
  const workdir =
    opts.workdir ??
    `/tmp/cocalc-project-backup-rustic-scale-${Date.now().toString(36)}`;
  const layouts =
    opts.layouts ??
    ([
      { kind: "per-project" },
      { kind: "shared" },
      { kind: "sharded", shard_count: 16 },
    ] satisfies RusticScaleLayout[]);
  const project_counts = opts.project_counts ?? [1, 64, 256, 512];
  const snapshots_per_project = opts.snapshots_per_project ?? 3;
  const common_file_count = opts.common_file_count ?? 4;
  const common_file_size_bytes = opts.common_file_size_bytes ?? 128 * 1024;
  const target_project_index = opts.target_project_index ?? 0;
  const started = new Date();
  const result: RusticScaleBenchmarkResult = {
    ok: false,
    host: opts.host,
    user,
    port,
    workdir,
    started_at: started.toISOString(),
    finished_at: started.toISOString(),
    layouts,
    project_counts,
    snapshots_per_project,
    measurements: [],
  };

  opts.log?.({
    step: "project-backup-rustic-scale",
    status: "start",
    message: `host=${opts.host} layouts=${layouts.length} counts=${project_counts.join(",")}`,
  });

  try {
    const stdout = await runRemotePython({
      host: opts.host,
      user,
      sudo_user,
      port,
      identity: opts.identity,
      script: remotePythonProgram({
        workdir,
        layouts,
        project_counts,
        snapshots_per_project,
        common_file_count,
        common_file_size_bytes,
        target_project_index,
      }),
    });
    const parsed = JSON.parse(stdout.trim());
    result.ok = !!parsed?.ok;
    result.python_version = parsed?.python_version;
    result.rustic_version = parsed?.rustic_version;
    result.measurements = Array.isArray(parsed?.measurements)
      ? parsed.measurements
      : [];
    result.error = parsed?.error ? `${parsed.error}` : undefined;
    opts.log?.({
      step: "project-backup-rustic-scale",
      status: result.ok ? "ok" : "failed",
      message: `measurements=${result.measurements.length}`,
    });
  } catch (err) {
    result.ok = false;
    result.error = `${err}`;
    opts.log?.({
      step: "project-backup-rustic-scale",
      status: "failed",
      message: result.error,
    });
  } finally {
    result.finished_at = new Date().toISOString();
  }

  return result;
}
