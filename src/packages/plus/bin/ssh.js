#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseTarget(raw) {
  const m = raw.match(/^(.*?)(?::(\d+))?$/);
  if (!m) throw new Error(`Invalid target: ${raw}`);
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : null };
}

function usage() {
  console.log(`Usage:
  cocalc-plus ssh user@host[:port] [options]
  cocalc-plus ssh list
  cocalc-plus ssh status user@host[:port]
  cocalc-plus ssh stop user@host[:port]

Options:
  --local-port <n|auto>
  --remote-port <n|auto>
  --no-open
  --no-install
  --upgrade
  --forward-only
  --ssh-arg <arg>        (repeatable)
  --identity <file>
  --proxy-jump <host>
  --log-level <info|debug>

Examples:
  cocalc-plus ssh user@host
  cocalc-plus ssh list
  cocalc-plus ssh status user@host
  cocalc-plus ssh stop user@host
  cocalc-plus ssh user@host:2222 --identity ~/.ssh/id_ed25519
  cocalc-plus ssh user@host --proxy-jump jumpbox
  cocalc-plus ssh user@host --no-open --local-port 42800
`);
}

function popArg(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val;
}

function popFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function pickFreePort() {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function canBindPort(port) {
  const net = require("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

function buildSshArgs(opts) {
  const args = [];
  if (opts.port) {
    args.push("-p", String(opts.port));
  }
  if (opts.identity) {
    args.push("-i", opts.identity);
  }
  if (opts.proxyJump) {
    args.push("-J", opts.proxyJump);
  }
  for (const arg of opts.sshArgs) {
    args.push(arg);
  }
  return args;
}

function sshRun(opts, cmd, execOpts = {}) {
  const sshArgs = buildSshArgs(opts);
  const finalArgs = sshArgs.concat(execOpts.extraArgs || [], [opts.host, cmd]);
  return spawnSync("ssh", finalArgs, {
    encoding: "utf8",
    stdio: execOpts.inherit ? "inherit" : "pipe",
    timeout: execOpts.timeoutMs,
  });
}

function sshExec(opts, cmd, inherit = false) {
  const res = sshRun(opts, cmd, { inherit });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = res.stderr?.toString() ?? "";
    throw new Error(`ssh failed: ${stderr || res.status}`);
  }
  return (res.stdout || "").toString().trim();
}

function probeRemoteBin(opts, extraArgs = []) {
  const which = sshRun(opts, "command -v cocalc-plus", {
    timeoutMs: 5000,
    extraArgs,
  });
  if (which.error || which.status === 255) {
    return { status: "unreachable", path: "" };
  }
  if (which.status === 0) {
    return { status: "found", path: (which.stdout || "").toString().trim() };
  }
  const test = sshRun(opts, 'test -x "$HOME/.local/bin/cocalc-plus"', {
    timeoutMs: 5000,
    extraArgs,
  });
  if (test.error || test.status === 255) {
    return { status: "unreachable", path: "" };
  }
  if (test.status === 0) {
    return { status: "found", path: "$HOME/.local/bin/cocalc-plus" };
  }
  return { status: "missing", path: "$HOME/.local/bin/cocalc-plus" };
}

function openUrl(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function infoPathFor(target) {
  const hash = crypto.createHash("sha1").update(target).digest("hex");
  const baseDir = path.join(
    os.homedir(),
    ".local",
    "share",
    "cocalc-plus",
    "ssh",
  );
  return {
    hash,
    baseDir,
    localDir: path.join(baseDir, hash),
    remoteDir: `$HOME/.local/share/cocalc-plus/ssh/${hash}`,
  };
}

function registryPath() {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "cocalc-plus",
    "ssh",
    "registry.json",
  );
}

function loadRegistry() {
  const file = registryPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const obj = {};
      for (const entry of parsed) {
        if (entry?.target) obj[entry.target] = entry;
      }
      return obj;
    }
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return {};
}

function saveRegistry(registry) {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

function updateRegistry(target, data) {
  const registry = loadRegistry();
  registry[target] = { target, ...(registry[target] || {}), ...data };
  saveRegistry(registry);
}

async function listRegistry(withStatus) {
  const registry = loadRegistry();
  const entries = Object.values(registry);
  if (entries.length === 0) {
    console.log("No saved SSH targets.");
    return;
  }
  entries.sort((a, b) => {
    const av = a.lastUsed || "";
    const bv = b.lastUsed || "";
    return bv.localeCompare(av);
  });
  const header = withStatus
    ? ["Target", "Port", "Status", "Last Used"]
    : ["Target", "Port", "Last Used"];
  const targetWidth = Math.min(
    48,
    Math.max(header[0].length, ...entries.map((e) => String(e.target).length)),
  );
  const statusWidth = 10;
  console.log(
    withStatus
      ? `${header[0].padEnd(targetWidth)}  ${header[1].padEnd(6)}  ${header[2].padEnd(statusWidth)}  ${header[3]}`
      : `${header[0].padEnd(targetWidth)}  ${header[1].padEnd(6)}  ${header[2]}`,
  );
  for (const entry of entries) {
    const target = String(entry.target);
    const trimmed =
      target.length > targetWidth
        ? `${target.slice(0, Math.max(targetWidth - 3, 0))}...`
        : target;
    const port =
      entry.localPort != null ? String(entry.localPort) : "";
    const lastUsed = entry.lastUsed || "";
    let status = "";
    if (withStatus) {
      status = await getRemoteStatus(entry);
    }
    console.log(
      withStatus
        ? `${trimmed.padEnd(targetWidth)}  ${port.padEnd(6)}  ${status.padEnd(statusWidth)}  ${lastUsed}`
        : `${trimmed.padEnd(targetWidth)}  ${port.padEnd(6)}  ${lastUsed}`,
    );
  }
}

async function waitRemoteFile(opts, remotePath, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = sshExec(opts, `cat ${remotePath}`);
      if (content) return content;
    } catch {
      // ignore and retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${remotePath}`);
}

async function resolveRemoteBin(opts) {
  const probe = probeRemoteBin(opts);
  if (probe.status === "found" && probe.path) return probe.path;
  return "$HOME/.local/bin/cocalc-plus";
}

async function getRemoteStatus(entry) {
  const target = entry.target;
  const { host, port } = parseTarget(target);
  const sshOpts = {
    host,
    port,
    identity: entry.identity,
    proxyJump: entry.proxyJump,
    sshArgs: entry.sshArgs || [],
  };
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const extraArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  const probe = probeRemoteBin(sshOpts, extraArgs);
  if (probe.status === "unreachable") return "unreachable";
  if (probe.status === "missing") return "missing";
  const remoteBin = probe.path || "$HOME/.local/bin/cocalc-plus";
  const res = sshRun(
    sshOpts,
    `${remoteBin} --daemon-status --pidfile ${remotePidPath}`,
    { timeoutMs: 5000, extraArgs },
  );
  if (res.error) return "unreachable";
  if (res.status === 0) return "running";
  if (res.status === 1) return "stopped";
  return "error";
}

async function ensureRemoteReady(opts, install, upgrade) {
  const probe = probeRemoteBin(opts);
  if (probe.status === "found" && !upgrade) return;
  if (probe.status === "unreachable") {
    throw new Error("ssh unreachable");
  }
  if (probe.status === "missing" && !install) {
    throw new Error("cocalc-plus not installed on remote");
  }
  if (!install && !upgrade) return;
  sshExec(
    opts,
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash",
    true,
  );
}

async function startRemote(opts, remoteInfoPath, remotePidPath, remoteLogPath) {
  const remoteBin = await resolveRemoteBin(opts);
  const env = [
    "HOST=127.0.0.1",
    "PORT=0",
    "AUTH_TOKEN=short",
    `COCALC_WRITE_CONNECTION_INFO=${remoteInfoPath}`,
    `COCALC_DAEMON_PIDFILE=${remotePidPath}`,
    `COCALC_DAEMON_LOG=${remoteLogPath}`,
  ].join(" ");
  const cmd = `mkdir -p ${path.dirname(remoteInfoPath)} && ${env} ${remoteBin} --daemon --write-connection-info ${remoteInfoPath} --pidfile ${remotePidPath} --log ${remoteLogPath}`;
  sshExec(opts, cmd, true);
  const info = await waitRemoteFile(opts, remoteInfoPath, 20000);
  return JSON.parse(info);
}

async function main(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    usage();
    process.exit(0);
  }

  let mode = "connect";
  if (["list", "status", "stop"].includes(args[0])) {
    mode = args.shift();
    if (mode === "list") {
      await listRegistry(true);
      return;
    }
  }

  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const target = args.shift();
  const { host, port } = parseTarget(target);

  const localPortArg = popArg(args, "--local-port");
  const remotePortArg = popArg(args, "--remote-port");
  const noOpen = popFlag(args, "--no-open");
  const noInstall = popFlag(args, "--no-install");
  const upgrade = popFlag(args, "--upgrade");
  const forwardOnly = popFlag(args, "--forward-only");
  const identity = popArg(args, "--identity");
  const proxyJump = popArg(args, "--proxy-jump");
  const logLevel = popArg(args, "--log-level") || "info";

  const sshArgs = [];
  let next;
  while ((next = popArg(args, "--ssh-arg"))) {
    sshArgs.push(next);
  }
  if (args.length > 0) {
    console.error("Unknown args:", args.join(" "));
    usage();
    process.exit(1);
  }

  const sshOpts = { host, port, identity, proxyJump, sshArgs };
  const label = target;
  const { localDir, remoteDir } = infoPathFor(label);
  fs.mkdirSync(localDir, { recursive: true });
  const localPortPath = path.join(localDir, "local-port");

  const remoteInfoPath = `${remoteDir}/connection.json`;
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteLogPath = `${remoteDir}/daemon.log`;

  if (logLevel === "debug") {
    console.log("Target:", sshOpts);
    console.log("Remote state:", remoteDir);
  }

  if (mode === "status" || mode === "stop") {
    await ensureRemoteReady(sshOpts, false, false);
    const remoteBin = await resolveRemoteBin(sshOpts);
    const cmd = `${remoteBin} --daemon-${mode} --pidfile ${remotePidPath}`;
    sshExec(sshOpts, cmd, true);
    if (mode === "stop") {
      updateRegistry(label, { lastStopped: new Date().toISOString() });
    }
    return;
  }

  await ensureRemoteReady(sshOpts, !noInstall, upgrade);

  let info;
  if (forwardOnly) {
    const content = sshExec(sshOpts, `cat ${remoteInfoPath}`);
    info = JSON.parse(content);
  } else {
    info = await startRemote(sshOpts, remoteInfoPath, remotePidPath, remoteLogPath);
  }

  const remotePort = remotePortArg && remotePortArg !== "auto"
    ? parseInt(remotePortArg, 10)
    : info.port;

  let localPort;
  if (localPortArg && localPortArg !== "auto") {
    localPort = parseInt(localPortArg, 10);
  } else if (fs.existsSync(localPortPath)) {
    const saved = parseInt(fs.readFileSync(localPortPath, "utf8").trim(), 10);
    if (saved && (await canBindPort(saved))) {
      localPort = saved;
    }
  }
  if (!localPort) {
    localPort = await pickFreePort();
    fs.writeFileSync(localPortPath, String(localPort));
  }

  const url = `http://localhost:${localPort}?auth_token=${encodeURIComponent(info.token || "")}`;

  updateRegistry(label, {
    host,
    port,
    localPort,
    lastUsed: new Date().toISOString(),
    identity: identity || undefined,
    proxyJump: proxyJump || undefined,
    sshArgs: sshArgs.length > 0 ? sshArgs : undefined,
  });

  const tunnelArgs = buildSshArgs(sshOpts).concat([
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    host,
  ]);

  console.log(`Forwarding localhost:${localPort} -> ${host}:${remotePort}`);
  console.log(url);
  if (!noOpen) {
    openUrl(url);
  }

  const tunnel = spawn("ssh", tunnelArgs, { stdio: "inherit" });
  tunnel.on("exit", (code) => process.exit(code ?? 0));
}

module.exports = { main };
