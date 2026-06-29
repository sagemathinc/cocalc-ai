#!/usr/bin/env node

/*
 * Run only inside a disposable test project.
 *
 * This intentionally tries to exhaust container resources so project-host
 * limits and watchdog enforcement can be validated.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

const ACK = "I_UNDERSTAND_THIS_IS_DANGEROUS";
const cleanupCallbacks = [];

function usage() {
  console.log(`Usage:
  COCALC_RESOURCE_STRESS_ACK=${ACK} node project-host-resource-stress-test.mjs --mode <mode> [options]

Modes:
  fds                 open /dev/null until target or EMFILE
  processes           spawn sleeping children until target or pids limit
  sockets             open loopback sockets until target or EMFILE
  inotify-watches     create files and watch them with fs.watch
  inotify-instances   spawn child Node processes that each hold a watcher
  tmp                 write data to /tmp until target MB or quota
  memory              allocate memory until target MB or cgroup memory limit
  cpu                 start CPU-burning workers
  keyrings            call keyctl add until target or denied

Options:
  --mode <mode>           required
  --target <n>            target count; mode-specific default is used if absent
  --duration-sec <n>      hold resources before cleanup, default 600
  --rate-per-sec <n>      allocation rate for count-based modes, default 200
  --mb <n>                target MB for tmp or memory modes
  --workers <n>           CPU workers, default os.cpus().length
`);
}

function parseArgs(argv) {
  const opts = {
    durationSec: 600,
    ratePerSec: 200,
    workers: os.cpus().length,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--child-watch") {
      opts.childWatch = argv[++i];
      continue;
    }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) {
      throw Error(`unknown argument '${arg}'`);
    }
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = match[2] ?? argv[++i];
    if (value == null) {
      throw Error(`missing value for '${arg}'`);
    }
    if (
      ["target", "durationSec", "ratePerSec", "mb", "workers"].includes(key)
    ) {
      opts[key] = Number(value);
    } else {
      opts[key] = value;
    }
  }
  return opts;
}

function addCleanup(fn) {
  cleanupCallbacks.push(fn);
}

async function cleanup() {
  for (const fn of cleanupCallbacks.reverse()) {
    try {
      await fn();
    } catch (err) {
      console.error(`cleanup failed: ${err}`);
    }
  }
}

function installSignalHandlers() {
  const handler = async () => {
    await cleanup();
    process.exit(130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pacedLoop(target, ratePerSec, fn) {
  const pauseEvery = Math.max(1, Math.floor(ratePerSec / 10));
  for (let i = 0; i < target; i += 1) {
    await fn(i);
    if (i % 100 === 0) {
      console.log(`allocated ${i}`);
    }
    if (i % pauseEvery === 0) {
      await sleep(100);
    }
  }
}

async function hold(durationSec) {
  console.log(
    `holding resources for ${durationSec}s; press Ctrl-C to clean up`,
  );
  await sleep(durationSec * 1000);
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-resource-stress-"));
  addCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function stressFds(opts) {
  const target = opts.target ?? 100000;
  const fds = [];
  addCleanup(() => {
    for (const fd of fds) fs.closeSync(fd);
  });
  await pacedLoop(target, opts.ratePerSec, () => {
    fds.push(fs.openSync("/dev/null", "r"));
  });
  await hold(opts.durationSec);
}

async function stressProcesses(opts) {
  const target = opts.target ?? 10000;
  const children = [];
  addCleanup(() => {
    for (const child of children) child.kill("SIGTERM");
  });
  await pacedLoop(target, opts.ratePerSec, () => {
    const child = spawn("sleep", [`${opts.durationSec + 60}`], {
      stdio: "ignore",
    });
    children.push(child);
  });
  await hold(opts.durationSec);
}

async function stressSockets(opts) {
  const target = opts.target ?? 100000;
  const sockets = [];
  const serverSockets = [];
  const server = net.createServer((socket) => {
    serverSockets.push(socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  addCleanup(() => {
    for (const socket of sockets) socket.destroy();
    for (const socket of serverSockets) socket.destroy();
    server.close();
  });
  const port = server.address().port;
  await pacedLoop(target, opts.ratePerSec, async () => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
  });
  await hold(opts.durationSec);
}

async function stressInotifyWatches(opts) {
  const target = opts.target ?? 300000;
  const dir = makeTempDir();
  const watchers = [];
  addCleanup(() => {
    for (const watcher of watchers) watcher.close();
  });
  await pacedLoop(target, opts.ratePerSec, (i) => {
    const file = path.join(dir, `watched-${i}`);
    fs.writeFileSync(file, "");
    watchers.push(fs.watch(file, () => {}));
  });
  await hold(opts.durationSec);
}

async function childWatch(file) {
  fs.writeFileSync(file, "");
  const watcher = fs.watch(file, () => {});
  addCleanup(() => watcher.close());
  parentPort?.postMessage("ready");
  setInterval(() => {}, 1000);
}

async function stressInotifyInstances(opts) {
  const target = opts.target ?? 10000;
  const dir = makeTempDir();
  const children = [];
  addCleanup(() => {
    for (const child of children) child.kill("SIGTERM");
  });
  await pacedLoop(target, Math.min(opts.ratePerSec, 50), async (i) => {
    const file = path.join(dir, `instance-${i}`);
    const child = spawn(
      process.execPath,
      [new URL(import.meta.url).pathname, "--child-watch", file],
      {
        env: {
          ...process.env,
          COCALC_RESOURCE_STRESS_ACK: ACK,
        },
        stdio: "ignore",
      },
    );
    children.push(child);
  });
  await hold(opts.durationSec);
}

async function stressTmp(opts) {
  const mb = opts.mb ?? opts.target ?? 10000;
  const dir = makeTempDir();
  const file = path.join(dir, "tmp-fill.bin");
  const fd = fs.openSync(file, "w");
  addCleanup(() => fs.closeSync(fd));
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let i = 0; i < mb; i += 1) {
    fs.writeSync(fd, chunk);
    if (i % 100 === 0) console.log(`wrote ${i} MB`);
  }
  await hold(opts.durationSec);
}

async function stressMemory(opts) {
  const mb = opts.mb ?? opts.target ?? 10000;
  const buffers = [];
  for (let i = 0; i < mb; i += 1) {
    buffers.push(Buffer.alloc(1024 * 1024, 0x62));
    if (i % 100 === 0) console.log(`allocated ${i} MB`);
    if (i % 100 === 0) await sleep(50);
  }
  await hold(opts.durationSec);
}

async function stressCpu(opts) {
  const workers = [];
  addCleanup(() => {
    for (const worker of workers) worker.terminate();
  });
  for (let i = 0; i < opts.workers; i += 1) {
    workers.push(new Worker(new URL(import.meta.url), { workerData: "cpu" }));
  }
  await hold(opts.durationSec);
}

async function stressKeyrings(opts) {
  const target = opts.target ?? 50000;
  await pacedLoop(target, Math.min(opts.ratePerSec, 20), (i) => {
    const result = spawnSync("keyctl", [
      "add",
      "user",
      `cocalc-stress-${process.pid}-${i}`,
      "value",
      "@s",
    ]);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw Error(`keyctl failed at ${i}: ${result.stderr?.toString().trim()}`);
    }
  });
  await hold(opts.durationSec);
}

if (!isMainThread) {
  while (true) {
    Math.sqrt(Math.random());
  }
}

const opts = parseArgs(process.argv);

if (opts.help) {
  usage();
  process.exit(0);
}

if (opts.childWatch) {
  installSignalHandlers();
  await childWatch(opts.childWatch);
} else if (process.env.COCALC_RESOURCE_STRESS_ACK !== ACK) {
  usage();
  console.error(`\nRefusing to run without COCALC_RESOURCE_STRESS_ACK=${ACK}`);
  process.exit(2);
} else {
  installSignalHandlers();
  try {
    switch (opts.mode) {
      case "fds":
        await stressFds(opts);
        break;
      case "processes":
        await stressProcesses(opts);
        break;
      case "sockets":
        await stressSockets(opts);
        break;
      case "inotify-watches":
        await stressInotifyWatches(opts);
        break;
      case "inotify-instances":
        await stressInotifyInstances(opts);
        break;
      case "tmp":
        await stressTmp(opts);
        break;
      case "memory":
        await stressMemory(opts);
        break;
      case "cpu":
        await stressCpu(opts);
        break;
      case "keyrings":
        await stressKeyrings(opts);
        break;
      default:
        usage();
        throw Error(`unknown or missing mode '${opts.mode}'`);
    }
  } finally {
    await cleanup();
  }
}
