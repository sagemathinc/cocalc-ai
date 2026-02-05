#!/usr/bin/env node
// CoCalc Plus CLI entrypoint. Delegates to the Lite starter so runtime
// behavior stays identical while packaging lives in @cocalc/plus.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reflectVersion } from "../reflect/manager";
import { main as sshMain } from "./ssh";

const dynamicImport = new Function(
  "p",
  "return import(p);",
) as (p: string) => Promise<any>;

function usage() {
  console.log(`Usage:
  cocalc-plus version
  cocalc-plus reflect --version
  cocalc-plus reflect-sync [args...]
  cocalc-plus ssh user@host[:port] [options]
  cocalc-plus ssh --target user@host[:port] [options]
  cocalc-plus [--daemon] [--write-connection-info PATH] [--pidfile PATH]

Examples:
  cocalc-plus
  cocalc-plus reflect --version
  cocalc-plus reflect-sync --version
  cocalc-plus ssh list
  cocalc-plus ssh user@host
  cocalc-plus ssh --target list
  cocalc-plus ssh user@host --local-port 42800 --no-open
`);
}

function pickArg(args: string[], name: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

function hasFlag(args: string[], name: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function stopDaemon(pidfile?: string | null) {
  if (!pidfile || !fs.existsSync(pidfile)) {
    console.error("Missing pidfile:", pidfile);
    process.exit(1);
  }
  const pid = parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10);
  if (!pid) {
    console.error("Invalid pidfile:", pidfile);
    process.exit(1);
  }
  try {
    process.kill(pid);
    console.log(`Stopped daemon pid=${pid}`);
  } catch (err: any) {
    console.error(`Failed to stop pid=${pid}:`, err?.message || err);
    process.exit(1);
  }
}

function daemonize(args: string[], pidfile?: string | null, logfile?: string | null) {
  const childArgs = args.concat(["--daemon-child"]);
  let stdoutFd: "ignore" | number = "ignore";
  let stderrFd: "ignore" | number = "ignore";
  if (logfile) {
    fs.mkdirSync(path.dirname(logfile), { recursive: true });
    const fd = fs.openSync(logfile, "a");
    stdoutFd = fd;
    stderrFd = fd;
  }
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env: { ...process.env, COCALC_DAEMON_CHILD: "1" },
  });
  if (typeof stdoutFd === "number") {
    try {
      fs.closeSync(stdoutFd);
    } catch {
      // ignore
    }
  }
  child.unref();
  if (pidfile) {
    fs.mkdirSync(path.dirname(pidfile), { recursive: true });
    fs.writeFileSync(pidfile, String(child.pid));
  }
  if (logfile) {
    fs.appendFileSync(
      logfile,
      `[${new Date().toISOString()}] daemon started pid=${child.pid}\n`,
    );
  }
  console.log(`cocalc-plus daemon started pid=${child.pid}`);
  process.exit(0);
}

function normalizeOsArch() {
  const platform = os.platform();
  const osName =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform;
  const archRaw = os.arch();
  const arch =
    archRaw === "x64"
      ? "amd64"
      : archRaw === "arm64"
        ? "arm64"
        : archRaw;
  return { os: osName, arch };
}

function getPackageVersion() {
  if (process.env.COCALC_PLUS_VERSION) {
    return process.env.COCALC_PLUS_VERSION;
  }
  if (process.env.COCALC_PROJECT_HOST_VERSION) {
    return process.env.COCALC_PROJECT_HOST_VERSION;
  }
  if (process.env.COCALC_SEA_VERSION) {
    return process.env.COCALC_SEA_VERSION;
  }
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }
  const extractVersionFromPath = (value?: string) => {
    if (!value) return undefined;
    const match = value.match(/[/\\]cocalc[/\\][^/\\]+[/\\]([^/\\]+)[/\\]/);
    return match?.[1];
  };
  const envPathVersion =
    extractVersionFromPath(process.env.COCALC_BIN_PATH) ||
    extractVersionFromPath(__dirname);
  if (envPathVersion) return envPathVersion;
  const findVersionUp = (startDir: string) => {
    let current = startDir;
    for (let i = 0; i < 8; i += 1) {
      try {
        const pkgPath = path.join(current, "package.json");
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          if (pkg?.version) {
            return pkg.version as string;
          }
        }
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  };
  try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "unknown";
  } catch {
    // ignore
  }
  const argvPath = process.argv[1];
  if (argvPath) {
    const found = findVersionUp(path.dirname(argvPath));
    if (found) return found;
  }
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "unknown";
  } catch {
    // ignore
  }
  const found = findVersionUp(process.cwd());
  if (found) return found;
  try {
    const baseDir =
      process.env.COCALC_PLUS_HOME ??
      process.env.COCALC_DATA_DIR ??
      path.join(os.homedir(), ".local", "share", "cocalc-plus");
    const versionPath = path.join(baseDir, "version.json");
    const raw = JSON.parse(fs.readFileSync(versionPath, "utf8"));
    if (raw?.version) {
      return raw.version;
    }
  } catch {
    // ignore
  }
  return "unknown";
}

function writeVersionInfo() {
  const dataDir =
    process.env.COCALC_DATA_DIR ||
    path.join(os.homedir(), ".local", "share", "cocalc-plus", "data");
  const outPath =
    process.env.COCALC_WRITE_VERSION_INFO ||
    path.join(dataDir, "version.json");
  if (!outPath) return;
  const { os: osName, arch } = normalizeOsArch();
  const payload = {
    version: getPackageVersion(),
    os: osName,
    arch,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  } catch {
    // ignore
  }
}

async function runCli() {
  if (process.argv.includes("--run-reflect-scheduler")) {
    if (!process.env.REFLECT_HOME) {
      process.env.REFLECT_HOME = path.join(
        os.homedir(),
        ".local",
        "share",
        "cocalc-plus",
        "reflect-sync",
      );
    }
    const opts = JSON.parse(process.env.REFLECT_OPTS ?? "{}");
    const entry = process.env.REFLECT_SYNC_ENTRY;
    const mod = entry
      ? await dynamicImport(entry)
      : await dynamicImport("reflect-sync");
    await mod.runScheduler(opts);
    return;
  }

  const isCommand = (arg?: string) =>
    arg &&
    (arg.startsWith("-") ||
      arg === "ssh" ||
      arg === "version" ||
      arg === "reflect" ||
      arg === "reflect-sync");
  const isSelfPath = (arg?: string) => {
    if (!arg) return false;
    if (!arg.includes("/") && !arg.includes("\\")) return false;
    const base = path.basename(arg);
    const execBase = path.basename(process.execPath);
    if (base !== execBase && !base.startsWith("cocalc-plus")) return false;
    try {
      return fs.existsSync(arg);
    } catch {
      return false;
    }
  };
  let argv = process.argv.slice(2);
  argv = argv.filter(
    (arg) =>
      arg !== process.execPath && arg !== process.argv[1] && !isSelfPath(arg),
  );
  if (argv.length >= 1) {
    const base = path.basename(argv[0]);
    const execBase = path.basename(process.execPath);
    if (base === execBase || base.startsWith("cocalc-plus")) {
      argv = argv.slice(1);
    }
  }
  if (argv.length === 0 || !isCommand(argv[0])) {
    const alt = process.argv.slice(1);
    const idx = alt.findIndex((arg) => isCommand(arg));
    if (idx !== -1) {
      argv = alt.slice(idx);
    }
  }
  if (argv[0] === "ssh") {
    await sshMain(argv.slice(1));
    return;
  }
  if (argv[0] === "reflect") {
    const reflectArgs = argv.slice(1);
    if (reflectArgs.length === 0) {
      console.log("Usage: cocalc-plus reflect --version");
      return;
    }
    if (reflectArgs.includes("-h") || reflectArgs.includes("--help")) {
      console.log("Usage: cocalc-plus reflect --version");
      return;
    }
    if (reflectArgs.includes("--version") || reflectArgs.includes("-v")) {
      console.log(await reflectVersion());
      return;
    }
    console.log("Usage: cocalc-plus reflect --version");
    return;
  }
  if (argv[0] === "reflect-sync") {
    process.argv = [process.execPath, "reflect-sync", ...argv.slice(1)];
    await dynamicImport("reflect-sync/cli");
    return;
  }
  if (
    argv[0] === "version" ||
    argv[0] === "--version" ||
    argv[0] === "-v"
  ) {
    console.log(getPackageVersion());
    return;
  }

  if (argv[0] === "-h" || argv[0] === "--help") {
    usage();
    return;
  }

  if (!process.env.COCALC_ENABLE_SSH_UI) {
    process.env.COCALC_ENABLE_SSH_UI = "1";
  }

  const daemonStop = hasFlag(argv, "--daemon-stop");
  const daemonStatus = hasFlag(argv, "--daemon-status");
  const daemon = hasFlag(argv, "--daemon");
  const daemonChild = hasFlag(argv, "--daemon-child");
  const pidfile = pickArg(argv, "--pidfile") || process.env.COCALC_DAEMON_PIDFILE;
  const logfile = pickArg(argv, "--log") || process.env.COCALC_DAEMON_LOG;

  const connInfo = pickArg(argv, "--write-connection-info");
  if (connInfo) {
    process.env.COCALC_WRITE_CONNECTION_INFO = connInfo;
  }

  if (process.env.COCALC_OPEN_BROWSER == null) {
    process.env.COCALC_OPEN_BROWSER = daemon || daemonChild ? "0" : "1";
  }

  if (daemonStop) {
    stopDaemon(pidfile);
    return;
  }

  if (daemonStatus) {
    if (!pidfile || !fs.existsSync(pidfile)) {
      console.log("stopped");
      process.exitCode = 1;
      return;
    }
    const pid = parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10);
    if (!pid) {
      console.log("stopped");
      process.exitCode = 1;
      return;
    }
    try {
      process.kill(pid, 0);
      console.log("running");
      return;
    } catch {
      console.log("stopped");
      process.exitCode = 1;
      return;
    }
  }

  if (daemon && !daemonChild) {
    daemonize(argv, pidfile, logfile);
  }

  if (!process.env.COCALC_BIN_PATH) {
    const tools = process.env.COCALC_TOOLS_DIR;
    if (tools) {
      process.env.COCALC_BIN_PATH = path.join(tools, "bin");
    }
  }

  if (argv.length > 0) {
    console.error("Unknown args:", argv.join(" "));
    usage();
    process.exitCode = 1;
    return;
  }

  if (!process.env.COCALC_DATA_DIR) {
    process.env.COCALC_DATA_DIR = path.join(
      os.homedir(),
      ".local",
      "share",
      "cocalc-plus",
      "data",
    );
  }

  writeVersionInfo();

  const liteMain = require("@cocalc/lite/main");
  if (typeof liteMain.main !== "function") {
    console.error("Failed to load @cocalc/lite/main");
    process.exitCode = 1;
    return;
  }
  let sshUi: any = undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sshUi = require("../ssh/ui");
  } catch {
    // ignore
  }
  let reflectUi: any = undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    reflectUi = require("../reflect/ui");
  } catch {
    // ignore
  }
  await liteMain.main({ sshUi, reflectUi });
}

runCli().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
