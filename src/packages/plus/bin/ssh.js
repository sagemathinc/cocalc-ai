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

function sshExec(opts, cmd, inherit = false) {
  const sshArgs = buildSshArgs(opts);
  const finalArgs = sshArgs.concat([opts.host, cmd]);
  const res = spawnSync("ssh", finalArgs, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = res.stderr?.toString() ?? "";
    throw new Error(`ssh failed: ${stderr || res.status}`);
  }
  return (res.stdout || "").toString().trim();
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
  return {
    hash,
    localDir: path.join(
      os.homedir(),
      ".local",
      "share",
      "cocalc-plus",
      "ssh",
      hash,
    ),
    remoteDir: `$HOME/.local/share/cocalc-plus/ssh/${hash}`,
  };
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

async function ensureRemoteReady(opts, install, upgrade) {
  try {
    sshExec(opts, "command -v cocalc-plus >/dev/null 2>&1");
    if (!upgrade) return;
  } catch {
    if (!install) throw new Error("cocalc-plus not installed on remote");
  }
  if (!install && !upgrade) return;
  sshExec(
    opts,
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash",
    true,
  );
}

async function startRemote(opts, remoteInfoPath, remotePidPath, remoteLogPath) {
  const env = [
    "HOST=127.0.0.1",
    "PORT=0",
    "AUTH_TOKEN=short",
    `COCALC_WRITE_CONNECTION_INFO=${remoteInfoPath}`,
    `COCALC_DAEMON_PIDFILE=${remotePidPath}`,
    `COCALC_DAEMON_LOG=${remoteLogPath}`,
  ].join(" ");
  const cmd = `mkdir -p ${path.dirname(remoteInfoPath)} && ${env} cocalc-plus --daemon --write-connection-info ${remoteInfoPath} --pidfile ${remotePidPath} --log ${remoteLogPath}`;
  sshExec(opts, cmd, true);
  const info = await waitRemoteFile(opts, remoteInfoPath, 20000);
  return JSON.parse(info);
}

async function main(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    usage();
    process.exit(0);
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

  const remoteInfoPath = `${remoteDir}/connection.json`;
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteLogPath = `${remoteDir}/daemon.log`;

  if (logLevel === "debug") {
    console.log("Target:", sshOpts);
    console.log("Remote state:", remoteDir);
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

  const localPort = localPortArg && localPortArg !== "auto"
    ? parseInt(localPortArg, 10)
    : await pickFreePort();

  const url = `http://localhost:${localPort}?auth_token=${encodeURIComponent(info.token || "")}`;

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
