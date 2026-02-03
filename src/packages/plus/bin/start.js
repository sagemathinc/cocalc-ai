#!/usr/bin/env node
// CoCalc Plus CLI entrypoint. Delegates to the Lite starter so runtime
// behavior stays identical while packaging lives in @cocalc/plus.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function usage() {
  console.log(`Usage:
  cocalc-plus version
  cocalc-plus ssh user@host[:port] [options]
  cocalc-plus [--daemon] [--write-connection-info PATH] [--pidfile PATH]

Examples:
  cocalc-plus
  cocalc-plus ssh user@host
  cocalc-plus ssh user@host --local-port 42800 --no-open
`);
}

function pickArg(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

function hasFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function stopDaemon(pidfile) {
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
  } catch (err) {
    console.error(`Failed to stop pid=${pid}:`, err?.message || err);
    process.exit(1);
  }
}

function daemonize(args, pidfile, logfile) {
  const childArgs = args.concat(["--daemon-child"]);
  let stdoutFd = "ignore";
  let stderrFd = "ignore";
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
    } catch {}
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

const isCommand = (arg) =>
  arg && (arg.startsWith("-") || arg === "ssh" || arg === "version");
let argv = process.argv.slice(2);
if (argv.length === 0 || !isCommand(argv[0])) {
  const alt = process.argv.slice(1);
  const idx = alt.findIndex((arg) => isCommand(arg));
  if (idx !== -1) {
    argv = alt.slice(idx);
  }
}
if (argv[0] === "ssh") {
  try {
    require("./ssh").main(argv.slice(1));
  } catch (err) {
    console.error("cocalc-plus ssh failed:", err);
    process.exitCode = 1;
  }
} else if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    console.log(pkg.version || "unknown");
  } catch {
    console.log("unknown");
  }
  process.exit(0);
} else {

  const daemonStop = hasFlag(argv, "--daemon-stop");
  const daemonStatus = hasFlag(argv, "--daemon-status");
  const daemon = hasFlag(argv, "--daemon");
  const daemonChild = hasFlag(argv, "--daemon-child");
  const pidfile =
    pickArg(argv, "--pidfile") || process.env.COCALC_DAEMON_PIDFILE;
  const logfile =
    pickArg(argv, "--log") || process.env.COCALC_DAEMON_LOG;

  const connInfo = pickArg(argv, "--write-connection-info");
  if (connInfo) {
    process.env.COCALC_WRITE_CONNECTION_INFO = connInfo;
  }

  if (process.env.COCALC_OPEN_BROWSER == null) {
    process.env.COCALC_OPEN_BROWSER = daemon || daemonChild ? "0" : "1";
  }

  if (daemonStop) {
    stopDaemon(pidfile);
    process.exit(0);
  }
  if (daemonStatus) {
    if (!pidfile || !fs.existsSync(pidfile)) {
      console.log("daemon not running");
      process.exit(1);
    }
    const pid = parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`daemon running pid=${pid}`);
      process.exit(0);
    } catch {
      console.log("daemon not running");
      process.exit(1);
    }
  }

  if (daemon && !daemonChild) {
    daemonize(process.argv.slice(1), pidfile, logfile);
    process.exit(0);
  }

  if (!daemonChild) {
    // basic help for direct invocation
    if (argv[0] === "-h" || argv[0] === "--help") {
      usage();
      process.exit(0);
    }
  }

  try {
    require("@cocalc/lite/bin/start");
  } catch (err) {
    console.error("cocalc-plus failed to start:", err);
    process.exitCode = 1;
  }
}
