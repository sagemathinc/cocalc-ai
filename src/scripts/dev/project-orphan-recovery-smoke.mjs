#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SRC_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const PODMAN_DB_PATH =
  "/mnt/cocalc/data/containers/rootless/cocalc-host/storage/db.sql";
const HOST_LOG_PATH = "/mnt/cocalc/data/log";

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    [
      "Usage: node scripts/dev/project-orphan-recovery-smoke.mjs --project <project-id> [options]",
      "",
      "Options:",
      "  --project <id>              Project id to exercise",
      "  --host <name>              Expected host name and default SSH target (default: host2)",
      "  --ssh-target <target>      Explicit SSH target (default: same as --host)",
      "  --timeout <ms>             Root CLI/RPC timeout in milliseconds (default: 120000)",
      "  --yes-destructive          Required; this edits the host's rootless podman DB",
      "  --keep-db-backup           Leave the DB backup file on the host after success",
      "  --help                     Show this help",
      "",
      "This is a destructive local smoke for the conmon/libpod orphan recovery path.",
      "It deliberately deletes one live container's libpod DB rows on the target",
      "host, verifies podman loses sight of the container while conmon stays live,",
      "then requires the normal routed project stop/start path to recover cleanly.",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    projectId: "",
    hostName: "host2",
    sshTarget: "",
    timeoutMs: 120_000,
    yesDestructive: false,
    keepDbBackup: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--project" && next) {
      options.projectId = next;
      i += 1;
    } else if (arg === "--host" && next) {
      options.hostName = next;
      i += 1;
    } else if (arg === "--ssh-target" && next) {
      options.sshTarget = next;
      i += 1;
    } else if (arg === "--timeout" && next) {
      options.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--yes-destructive") {
      options.yesDestructive = true;
    } else if (arg === "--keep-db-backup") {
      options.keepDbBackup = true;
    } else if (arg === "--help") {
      usageAndExit("", 0);
    } else {
      usageAndExit(`unknown argument: ${arg}`);
    }
  }

  if (!options.projectId.trim()) {
    usageAndExit("--project is required");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    usageAndExit("--timeout must be a positive number");
  }
  if (!options.yesDestructive) {
    usageAndExit("--yes-destructive is required");
  }
  if (!options.sshTarget.trim()) {
    options.sshTarget = options.hostName;
  }
  return options;
}

function shellQuote(value) {
  return `'${`${value ?? ""}`.replace(/'/g, `'\\''`)}'`;
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
    'eval "$(pnpm -s dev:hub:env)"',
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

function getData(result) {
  return result?.data ?? result;
}

function projectName(projectId) {
  return `project-${projectId}`;
}

function remoteInspectProjectScript({ projectId }) {
  return `
sudo python3 - <<'PY'
import json, re, subprocess
project_id = ${JSON.stringify(projectId)}
name = ${JSON.stringify(projectName(projectId))}
podman = subprocess.run(
    ['sudo', '-Hiu', 'cocalc-host', 'podman', 'ps', '-a', '--format', '{{.ID}}|{{.Names}}|{{.State}}'],
    capture_output=True,
    text=True,
    check=False,
)
podman_rows = []
for line in podman.stdout.splitlines():
    parts = line.strip().split('|')
    if len(parts) < 3:
        continue
    container_id, container_name, state = parts[:3]
    if container_name == name:
        podman_rows.append({
            'container_id': container_id,
            'name': container_name,
            'state': state,
        })
ps = subprocess.run(
    ['ps', '-eo', 'pid=,ppid=,args='],
    capture_output=True,
    text=True,
    check=False,
)
conmon_rows = []
pattern = re.compile(r'^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$')
for line in ps.stdout.splitlines():
    match = pattern.match(line)
    if not match:
        continue
    pid, ppid, args = int(match.group(1)), int(match.group(2)), match.group(3)
    if name not in args:
        continue
    if 'conmon' not in args:
        continue
    if '--exec-attach' in args or '--exec-process-spec' in args:
        continue
    conmon_rows.append({
        'pid': pid,
        'ppid': ppid,
        'args': args,
    })
print(json.dumps({
    'project_id': project_id,
    'project_name': name,
    'podman_rows': podman_rows,
    'podman_count': len(podman_rows),
    'conmon_rows': conmon_rows,
    'conmon_count': len(conmon_rows),
}))
PY
`.trim();
}

function remoteInjectOrphanScript({ projectId }) {
  return `
sudo python3 - <<'PY'
import json, shutil, sqlite3, time
project_id = ${JSON.stringify(projectId)}
name = ${JSON.stringify(projectName(projectId))}
path = ${JSON.stringify(PODMAN_DB_PATH)}
conn = sqlite3.connect(path)
cur = conn.cursor()
rows = cur.execute('select ID from ContainerConfig where Name=?', (name,)).fetchall()
if len(rows) != 1:
    raise SystemExit(json.dumps({
        'ok': False,
        'error': f'expected exactly one ContainerConfig row for {name}, got {len(rows)}',
    }))
container_id = rows[0][0]
backup_path = f"{path}.bak-orphan-{project_id[:8]}-{int(time.time())}"
shutil.copy2(path, backup_path)
cur.execute('BEGIN IMMEDIATE')
deleted = {
    'ContainerState': cur.execute('delete from ContainerState where ID=?', (container_id,)).rowcount,
    'ContainerConfig': cur.execute('delete from ContainerConfig where ID=?', (container_id,)).rowcount,
    'IDNamespace': cur.execute('delete from IDNamespace where ID=?', (container_id,)).rowcount,
}
conn.commit()
print(json.dumps({
    'ok': True,
    'project_id': project_id,
    'project_name': name,
    'container_id': container_id,
    'backup_path': backup_path,
    'deleted': deleted,
}))
PY
`.trim();
}

function remoteRemoveFileScript(pathToRemove) {
  return `sudo rm -f ${shellQuote(pathToRemove)}`;
}

function remoteFindFallbackLogScript({ projectId, sinceIso }) {
  return `
sudo python3 - <<'PY'
import json, os
base = ${JSON.stringify(HOST_LOG_PATH)}
project_id = ${JSON.stringify(projectId)}
since_iso = ${JSON.stringify(sinceIso)}
needles = [
    'forcing process kill via conmon fallback',
    project_id,
]
matches = []
def iter_files(path):
    if os.path.isfile(path):
        yield path
        return
    if not os.path.isdir(path):
        return
    for root, _dirs, files in os.walk(path):
        for name in files:
            yield os.path.join(root, name)
for path in iter_files(base):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            for line in handle:
                if not line.startswith('20'):
                    continue
                if line[:len(since_iso)] < since_iso:
                    continue
                if all(needle in line for needle in needles):
                    matches.append(line.rstrip())
    except Exception:
        pass
print(json.dumps({
    'count': len(matches),
    'matches': matches[-10:],
}))
PY
`.trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timeoutSeconds = Math.ceil(options.timeoutMs / 1000);
  const globalArgs = [
    "--json",
    "--timeout",
    `${timeoutSeconds}s`,
    "--rpc-timeout",
    `${timeoutSeconds}s`,
  ];
  const steps = [];
  let dbBackupPath = "";
  let injected = false;
  let stopCompleted = false;

  const runStep = async (name, fn) => {
    const startedAt = new Date().toISOString();
    console.error(`[project-orphan-recovery] ${name}: start`);
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
      console.error(`[project-orphan-recovery] ${name}: ok`);
      return detail;
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const message = `${err?.stack ?? err}`;
      steps.push({
        name,
        status: "failed",
        started_at: startedAt,
        finished_at: finishedAt,
        error: message,
      });
      console.error(`[project-orphan-recovery] ${name}: failed\n${message}`);
      throw err;
    }
  };

  try {
    const host = await runStep("host_get", async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "host",
        "get",
        options.hostName,
      ]);
      const data = getData(result);
      return {
        name: options.hostName,
        status: `${data?.status ?? ""}`.trim(),
        host_id: `${data?.host_id ?? data?.id ?? ""}`.trim(),
      };
    });
    ensure(
      host.status === "running",
      `host ${options.hostName} is not running`,
    );

    let project = await runStep("project_get:initial", async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "project",
        "get",
        "-w",
        options.projectId,
      ]);
      const data = getData(result);
      return {
        project_id: options.projectId,
        state: `${data?.state ?? ""}`.trim(),
        host_id: `${data?.host_id ?? ""}`.trim(),
      };
    });

    if (project.state !== "running") {
      await runStep("project_start:ensure_running", async () => {
        const result = await runCocalcJson([
          ...globalArgs,
          "project",
          "start",
          "-w",
          options.projectId,
          "--wait",
        ]);
        const data = getData(result);
        return {
          status: `${data?.status ?? ""}`.trim(),
          op_id: `${data?.op_id ?? ""}`.trim(),
        };
      });
      project = await runStep("project_get:running", async () => {
        const result = await runCocalcJson([
          ...globalArgs,
          "project",
          "get",
          "-w",
          options.projectId,
        ]);
        const data = getData(result);
        return {
          project_id: options.projectId,
          state: `${data?.state ?? ""}`.trim(),
          host_id: `${data?.host_id ?? ""}`.trim(),
        };
      });
    }

    ensure(project.state === "running", "project is not running before smoke");
    ensure(
      project.host_id === host.host_id,
      `project is on host_id=${project.host_id}, expected ${host.host_id}`,
    );

    const before = await runStep("remote_state:before", async () => {
      return await runRemoteJson({
        sshTarget: options.sshTarget,
        script: remoteInspectProjectScript({ projectId: options.projectId }),
      });
    });
    ensure(
      before.podman_count === 1,
      `expected exactly one podman row before injection, got ${before.podman_count}`,
    );
    ensure(
      before.conmon_count === 1,
      `expected exactly one main conmon tree before injection, got ${before.conmon_count}`,
    );

    const injectedState = await runStep("inject_orphan", async () => {
      const result = await runRemoteJson({
        sshTarget: options.sshTarget,
        script: remoteInjectOrphanScript({ projectId: options.projectId }),
      });
      ensure(result.ok, result.error ?? "remote orphan injection failed");
      dbBackupPath = `${result.backup_path ?? ""}`.trim();
      injected = true;
      return result;
    });

    const afterInject = await runStep("remote_state:after_inject", async () => {
      return await runRemoteJson({
        sshTarget: options.sshTarget,
        script: remoteInspectProjectScript({ projectId: options.projectId }),
      });
    });
    ensure(
      afterInject.podman_count === 0,
      `expected podman to lose the container after injection, got ${afterInject.podman_count} rows`,
    );
    ensure(
      afterInject.conmon_count === 1,
      `expected one live main conmon tree after injection, got ${afterInject.conmon_count}`,
    );

    const stopSinceIso = new Date().toISOString();
    const stopResult = await runStep("project_stop", async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "project",
        "stop",
        "-w",
        options.projectId,
        "--wait",
      ]);
      const data = getData(result);
      stopCompleted = true;
      return {
        status: `${data?.status ?? ""}`.trim(),
        op_id: `${data?.op_id ?? ""}`.trim(),
      };
    });
    ensure(
      stopResult.status === "opened",
      `expected stop to finish with status=opened, got ${stopResult.status}`,
    );

    const afterStop = await runStep("remote_state:after_stop", async () => {
      return await runRemoteJson({
        sshTarget: options.sshTarget,
        script: remoteInspectProjectScript({ projectId: options.projectId }),
      });
    });
    ensure(
      afterStop.podman_count === 0,
      `expected no podman rows after stop, got ${afterStop.podman_count}`,
    );
    ensure(
      afterStop.conmon_count === 0,
      `expected no conmon trees after stop, got ${afterStop.conmon_count}`,
    );

    const fallbackLog = await runStep("host_logs:fallback_check", async () => {
      return await runRemoteJson({
        sshTarget: options.sshTarget,
        script: remoteFindFallbackLogScript({
          projectId: options.projectId,
          sinceIso: stopSinceIso,
        }),
      });
    });
    ensure(
      Number(fallbackLog.count ?? 0) >= 1,
      "expected host logs to record the conmon fallback recovery path",
    );

    const startResult = await runStep("project_start", async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "project",
        "start",
        "-w",
        options.projectId,
        "--wait",
      ]);
      const data = getData(result);
      return {
        status: `${data?.status ?? ""}`.trim(),
        op_id: `${data?.op_id ?? ""}`.trim(),
      };
    });
    ensure(
      startResult.status === "succeeded",
      `expected start to succeed, got ${startResult.status}`,
    );

    const afterStartProject = await runStep(
      "project_get:after_start",
      async () => {
        const result = await runCocalcJson([
          ...globalArgs,
          "project",
          "get",
          "-w",
          options.projectId,
        ]);
        const data = getData(result);
        return {
          state: `${data?.state ?? ""}`.trim(),
          host_id: `${data?.host_id ?? ""}`.trim(),
        };
      },
    );
    ensure(
      afterStartProject.state === "running",
      `expected project to be running after restart, got ${afterStartProject.state}`,
    );
    ensure(
      afterStartProject.host_id === host.host_id,
      `project restarted on unexpected host_id=${afterStartProject.host_id}`,
    );

    const afterStart = await runStep("remote_state:after_start", async () => {
      return await runRemoteJson({
        sshTarget: options.sshTarget,
        script: remoteInspectProjectScript({ projectId: options.projectId }),
      });
    });
    ensure(
      afterStart.podman_count === 1,
      `expected exactly one podman row after restart, got ${afterStart.podman_count}`,
    );
    ensure(
      afterStart.conmon_count === 1,
      `expected exactly one main conmon tree after restart, got ${afterStart.conmon_count}`,
    );

    if (dbBackupPath && !options.keepDbBackup) {
      await runStep("cleanup_db_backup", async () => {
        await runSshCapture(
          options.sshTarget,
          remoteRemoveFileScript(dbBackupPath),
        );
        return { removed: dbBackupPath };
      });
      dbBackupPath = "";
    }

    const summary = {
      ok: true,
      project_id: options.projectId,
      host_name: options.hostName,
      ssh_target: options.sshTarget,
      timeout_ms: options.timeoutMs,
      keep_db_backup: options.keepDbBackup,
      before: {
        container_id: before.podman_rows?.[0]?.container_id ?? null,
        podman_count: before.podman_count,
        conmon_count: before.conmon_count,
      },
      injected: {
        container_id: injectedState.container_id,
        backup_path: injectedState.backup_path,
        deleted: injectedState.deleted,
      },
      after_inject: {
        podman_count: afterInject.podman_count,
        conmon_count: afterInject.conmon_count,
      },
      fallback_log_matches: fallbackLog.matches ?? [],
      after_start: {
        container_id: afterStart.podman_rows?.[0]?.container_id ?? null,
        podman_count: afterStart.podman_count,
        conmon_count: afterStart.conmon_count,
      },
      steps,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (err) {
    if (injected && !stopCompleted) {
      try {
        await runCocalcJson([
          ...globalArgs,
          "project",
          "stop",
          "-w",
          options.projectId,
          "--wait",
        ]);
      } catch {}
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(`project orphan recovery smoke failed: ${err?.stack ?? err}`);
  process.exit(1);
});
