#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { AsciiTable3 } from "ascii-table3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

type SshExecOptions = {
  inherit?: boolean;
  timeoutMs?: number;
  extraArgs?: string[];
};

type SshOptions = {
  host: string;
  port: number | null;
  identity?: string;
  proxyJump?: string;
  sshArgs: string[];
};

type RegistryEntry = {
  target: string;
  host?: string;
  port?: number | null;
  localPort?: number;
  lastUsed?: string;
  lastStopped?: string;
  identity?: string;
  proxyJump?: string;
  sshArgs?: string[];
};

type ProbeResult = {
  status: "found" | "missing" | "unreachable";
  path: string;
};

type ConnectionInfo = {
  port: number;
  token?: string;
  [key: string]: unknown;
};

function parseTarget(raw: string) {
  const m = raw.match(/^(.*?)(?::(\d+))?$/);
  if (!m) throw new Error(`Invalid target: ${raw}`);
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : null };
}

function pickFreePort(): Promise<number> {
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

function canBindPort(port: number): Promise<boolean> {
  const net = require("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

function buildSshArgs(opts: SshOptions): string[] {
  const args: string[] = [];
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

function sshRun(opts: SshOptions, cmd: string, execOpts: SshExecOptions = {}) {
  const sshArgs = buildSshArgs(opts);
  const finalArgs = sshArgs.concat(execOpts.extraArgs || [], [opts.host, cmd]);
  return spawnSync("ssh", finalArgs, {
    encoding: "utf8",
    stdio: execOpts.inherit ? "inherit" : "pipe",
    timeout: execOpts.timeoutMs,
  });
}

function sshExec(opts: SshOptions, cmd: string, inherit = false): string {
  const res = sshRun(opts, cmd, { inherit });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = res.stderr?.toString() ?? "";
    throw new Error(`ssh failed: ${stderr || res.status}`);
  }
  return (res.stdout || "").toString().trim();
}

function probeRemoteBin(opts: SshOptions, extraArgs: string[] = []): ProbeResult {
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

function openUrl(url: string) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : "xdg-open";
  const args = [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function infoPathFor(target: string) {
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

function loadRegistry(): Record<string, RegistryEntry> {
  const file = registryPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const obj: Record<string, RegistryEntry> = {};
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

function saveRegistry(registry: Record<string, RegistryEntry>) {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

function updateRegistry(target: string, data: Partial<RegistryEntry>) {
  const registry = loadRegistry();
  registry[target] = { ...(registry[target] || {}), ...data, target };
  saveRegistry(registry);
}

async function listRegistry(withStatus: boolean) {
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
  const rows: string[][] = [];
  for (const entry of entries) {
    const target = String(entry.target);
    const port = entry.localPort != null ? String(entry.localPort) : "";
    const lastUsed = entry.lastUsed || "";
    let status = "";
    if (withStatus) {
      status = await getRemoteStatus(entry);
    }
    if (withStatus) {
      rows.push([target, port, status, lastUsed]);
    } else {
      rows.push([target, port, lastUsed]);
    }
  }
  const table = new AsciiTable3("SSH Targets")
    .setHeading(...header)
    .addRowMatrix(rows);
  table.setStyle("unicode-round");
  table.setWidth(1, 15).setWrapped(1);
  console.log(table.toString());
}

async function waitRemoteFile(
  opts: SshOptions,
  remotePath: string,
  timeoutMs = 10000,
) {
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

async function resolveRemoteBin(opts: SshOptions): Promise<string> {
  const probe = probeRemoteBin(opts);
  if (probe.status === "found" && probe.path) return probe.path;
  return "$HOME/.local/bin/cocalc-plus";
}

async function getRemoteStatus(entry: RegistryEntry): Promise<string> {
  const target = entry.target;
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
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

async function ensureRemoteReady(
  opts: SshOptions,
  install: boolean,
  upgrade: boolean,
) {
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

async function startRemote(
  opts: SshOptions,
  remoteInfoPath: string,
  remotePidPath: string,
  remoteLogPath: string,
): Promise<ConnectionInfo> {
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
  return JSON.parse(info) as ConnectionInfo;
}

function collectRepeatable(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

async function statusOrStop(
  mode: "status" | "stop",
  target: string,
  opts: { identity?: string; proxyJump?: string; sshArg?: string[] },
) {
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: opts.identity,
    proxyJump: opts.proxyJump,
    sshArgs: opts.sshArg || [],
  };
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  await ensureRemoteReady(sshOpts, false, false);
  const remoteBin = await resolveRemoteBin(sshOpts);
  const cmd = `${remoteBin} --daemon-${mode} --pidfile ${remotePidPath}`;
  sshExec(sshOpts, cmd, true);
  if (mode === "stop") {
    updateRegistry(target, { lastStopped: new Date().toISOString() });
  }
}

async function connect(
  target: string,
  options: {
    localPort?: string;
    remotePort?: string;
    noOpen?: boolean;
    noInstall?: boolean;
    upgrade?: boolean;
    forwardOnly?: boolean;
    identity?: string;
    proxyJump?: string;
    logLevel?: string;
    sshArg?: string[];
  },
) {
  const { host, port } = parseTarget(target);
  const sshArgs = options.sshArg || [];
  const sshOpts: SshOptions = {
    host,
    port,
    identity: options.identity,
    proxyJump: options.proxyJump,
    sshArgs,
  };
  const label = target;
  const { localDir, remoteDir } = infoPathFor(label);
  fs.mkdirSync(localDir, { recursive: true });
  const localPortPath = path.join(localDir, "local-port");

  const remoteInfoPath = `${remoteDir}/connection.json`;
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteLogPath = `${remoteDir}/daemon.log`;

  if (options.logLevel === "debug") {
    console.log("Target:", sshOpts);
    console.log("Remote state:", remoteDir);
  }

  await ensureRemoteReady(sshOpts, !options.noInstall, !!options.upgrade);

  let info: ConnectionInfo;
  if (options.forwardOnly) {
    const content = sshExec(sshOpts, `cat ${remoteInfoPath}`);
    info = JSON.parse(content) as ConnectionInfo;
  } else {
    info = await startRemote(sshOpts, remoteInfoPath, remotePidPath, remoteLogPath);
  }

  const remotePort = options.remotePort && options.remotePort !== "auto"
    ? parseInt(options.remotePort, 10)
    : info.port;

  let localPort: number | undefined;
  if (options.localPort && options.localPort !== "auto") {
    localPort = parseInt(options.localPort, 10);
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

  const url = `http://localhost:${localPort}?auth_token=${encodeURIComponent(
    info.token || "",
  )}`;

  updateRegistry(label, {
    host,
    port,
    localPort,
    lastUsed: new Date().toISOString(),
    identity: options.identity || undefined,
    proxyJump: options.proxyJump || undefined,
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
  if (!options.noOpen) {
    openUrl(url);
  }

  const tunnel = spawn("ssh", tunnelArgs, { stdio: "inherit" });
  tunnel.on("exit", (code) => process.exit(code ?? 0));
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const program = new Command();
  program
    .name("cocalc-plus ssh")
    .usage("user@host[:port] [options]")
    .showHelpAfterError()
    .argument("[target]")
    .option("--target <target>", "disambiguate targets named list/status/stop")
    .option("--local-port <n|auto>")
    .option("--remote-port <n|auto>")
    .option("--no-open")
    .option("--no-install")
    .option("--upgrade")
    .option("--forward-only")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .option("--log-level <info|debug>", "", "info")
    .addHelpText(
      "after",
      `\nExamples:\n  cocalc-plus ssh user@host\n  cocalc-plus ssh list\n  cocalc-plus ssh status user@host\n  cocalc-plus ssh stop user@host\n  cocalc-plus ssh --target list\n  cocalc-plus ssh -- list\n  cocalc-plus ssh user@host:2222 --identity ~/.ssh/id_ed25519\n  cocalc-plus ssh user@host --proxy-jump jumpbox\n  cocalc-plus ssh user@host --no-open --local-port 42800\n`,
    )
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.help({ error: true });
        return;
      }
      await connect(finalTarget, options);
    });

  program
    .command("list")
    .description("list saved ssh targets")
    .action(async () => {
      await listRegistry(true);
    });

  program
    .command("status")
    .argument("[target]")
    .option("--target <target>")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.error("Missing target for status.");
        return;
      }
      await statusOrStop("status", finalTarget, options);
    });

  program
    .command("stop")
    .argument("[target]")
    .option("--target <target>")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.error("Missing target for stop.");
        return;
      }
      await statusOrStop("stop", finalTarget, options);
    });

  await program.parseAsync(argv, { from: "user" });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("cocalc-plus ssh failed:", err?.message || err);
    process.exit(1);
  });
}
