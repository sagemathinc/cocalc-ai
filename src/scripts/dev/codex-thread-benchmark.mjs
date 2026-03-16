#!/usr/bin/env node

import { spawn, execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

function parseArgs(argv) {
  const options = {
    codex: "codex",
    cwd: process.cwd(),
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    threadId: undefined,
    prompt: "Reply with exactly one word: benchmark",
    timeoutMs: 180_000,
    sampleMs: 100,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--codex" && next) {
      options.codex = next;
      i += 1;
    } else if (arg === "--cwd" && next) {
      options.cwd = next;
      i += 1;
    } else if (arg === "--codex-home" && next) {
      options.codexHome = next;
      i += 1;
    } else if (arg === "--thread-id" && next) {
      options.threadId = next;
      i += 1;
    } else if (arg === "--prompt" && next) {
      options.prompt = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--sample-ms" && next) {
      options.sampleMs = Number(next);
      i += 1;
    } else if (arg === "--help") {
      console.error(
        [
          "Usage: node codex-thread-benchmark.mjs --thread-id <id> [options]",
          "",
          "Options:",
          "  --codex <path>        Codex binary path (default: codex)",
          "  --cwd <path>          Working directory for app-server",
          "  --codex-home <path>   CODEX_HOME to measure (default: $CODEX_HOME or ~/.codex)",
          "  --thread-id <id>      Existing Codex thread id to resume",
          "  --prompt <text>       Benchmark prompt",
          "  --timeout-ms <ms>     End-to-end timeout",
          "  --sample-ms <ms>      RSS polling interval",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.threadId) {
    throw new Error("--thread-id is required");
  }
  return options;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function fileSizeOrZero(target) {
  try {
    const stat = await fs.stat(target);
    return stat.size;
  } catch {
    return 0;
  }
}

async function directorySize(target) {
  try {
    const { stdout } = await execFile("du", ["-sb", target]);
    const value = Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
    if (Number.isFinite(value)) return value;
  } catch {
    // Fall back to manual traversal below.
  }
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          return;
        }
        if (!entry.isFile()) return;
        total += await fileSizeOrZero(full);
      }),
    );
  }
  await walk(target);
  return total;
}

async function collectStorageStats(codexHome) {
  const sessionsDir = path.join(codexHome, "sessions");
  const rootEntries = await fs.readdir(codexHome).catch(() => []);
  let sqliteBytes = 0;
  for (const name of rootEntries) {
    if (!name.endsWith(".sqlite")) continue;
    sqliteBytes += await fileSizeOrZero(path.join(codexHome, name));
  }
  return {
    sessionsBytes: await directorySize(sessionsDir),
    sqliteBytes,
  };
}

async function readRssKb(pid) {
  try {
    const { stdout } = await execFile("ps", ["-o", "rss=", "-p", `${pid}`]);
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function createRpcClient(child, options) {
  let nextId = 1;
  let exited = false;
  let exitCode = null;
  let pendingStdout = "";
  let pendingStderr = "";
  const stderrTail = [];
  const notifications = [];
  const pendingRequests = new Map();
  const waiters = [];

  function pushTail(line) {
    const text = String(line ?? "").trimEnd();
    if (!text) return;
    stderrTail.push(text);
    if (stderrTail.length > 80) stderrTail.shift();
  }

  function fulfillWaiters(message) {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (!waiter.matches(message)) continue;
      waiters.splice(i, 1);
      waiter.resolve(message);
    }
  }

  function handleResponse(message) {
    const request = pendingRequests.get(message.id);
    if (!request) return;
    pendingRequests.delete(message.id);
    if (message.error) {
      request.reject(
        new Error(`${request.method}: ${JSON.stringify(message.error)}`),
      );
      return;
    }
    request.resolve(message.result ?? {});
  }

  function handleNotification(message) {
    notifications.push(message);
    if (notifications.length > 2000) notifications.shift();
    fulfillWaiters(message);
  }

  function handleStdoutLine(line) {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      handleResponse(message);
      return;
    }
    if (message.method) {
      handleNotification(message);
    }
  }

  child.stdout.on("data", (chunk) => {
    pendingStdout += chunk.toString("utf8");
    while (true) {
      const newline = pendingStdout.indexOf("\n");
      if (newline === -1) break;
      const line = pendingStdout.slice(0, newline);
      pendingStdout = pendingStdout.slice(newline + 1);
      handleStdoutLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    pendingStderr += chunk.toString("utf8");
    while (true) {
      const newline = pendingStderr.indexOf("\n");
      if (newline === -1) break;
      const line = pendingStderr.slice(0, newline);
      pendingStderr = pendingStderr.slice(newline + 1);
      pushTail(line);
    }
  });

  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = signal ? `signal:${signal}` : code;
    if (pendingStderr.trim()) {
      pushTail(pendingStderr);
      pendingStderr = "";
    }
    const error = new Error(
      `codex app-server exited unexpectedly: ${exitCode}`,
    );
    for (const request of pendingRequests.values()) request.reject(error);
    pendingRequests.clear();
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  function send(message) {
    if (exited)
      throw new Error(`cannot send to exited app-server: ${exitCode}`);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    stderrTail,
    notify(method, params = {}) {
      send({ method, params });
    },
    request(method, params = {}) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject, method });
      });
      send({ id, method, params });
      return withTimeout(promise, options.timeoutMs, method);
    },
    waitForNotification(
      method,
      predicate = () => true,
      timeoutMs = options.timeoutMs,
    ) {
      const existing = notifications.find(
        (message) =>
          message.method === method && predicate(message.params ?? {}),
      );
      if (existing) return Promise.resolve(existing);
      return withTimeout(
        new Promise((resolve, reject) => {
          waiters.push({
            resolve,
            reject,
            matches(message) {
              return (
                message.method === method && predicate(message.params ?? {})
              );
            },
          });
        }),
        timeoutMs,
        method,
      );
    },
    async cleanup() {
      if (exited) return;
      child.kill("SIGTERM");
      try {
        await withTimeout(
          new Promise((resolve) => child.once("exit", resolve)),
          3000,
          "codex shutdown",
        );
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const before = await collectStorageStats(options.codexHome);
  const child = spawn(options.codex, ["app-server", "--listen", "stdio://"], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const startedAt = Date.now();
  const rpc = createRpcClient(child, options);
  const rssSamples = [];
  let peakRssKb = 0;
  const rssTimer = setInterval(async () => {
    if (!child.pid) return;
    const rssKb = await readRssKb(child.pid);
    if (rssKb == null) return;
    rssSamples.push({ atMs: Date.now() - startedAt, rssKb });
    peakRssKb = Math.max(peakRssKb, rssKb);
  }, options.sampleMs);

  const metrics = {
    threadId: options.threadId,
    codexHome: options.codexHome,
    cwd: options.cwd,
    prompt: options.prompt,
    before,
    timingsMs: {},
    rss: {},
    stderrTail: rpc.stderrTail,
  };

  let turnId;
  const marks = { benchmarkStart: Date.now() };

  try {
    await rpc.request("initialize", {
      clientInfo: {
        name: "cocalc_thread_benchmark",
        title: "CoCalc Thread Benchmark",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["item/reasoningSummaryText/delta"],
      },
    });
    rpc.notify("initialized", {});

    marks.resumeStart = Date.now();
    await rpc.request("thread/resume", { threadId: options.threadId });
    marks.resumeDone = Date.now();

    const turnStartResult = await rpc.request("turn/start", {
      threadId: options.threadId,
      cwd: options.cwd,
      input: [
        {
          type: "text",
          text: options.prompt,
          textElements: [],
        },
      ],
    });
    turnId = turnStartResult.turn?.id;
    if (!turnId) {
      throw new Error(
        `turn/start missing turn id: ${JSON.stringify(turnStartResult)}`,
      );
    }
    marks.turnRequested = Date.now();

    const firstActivityMethods = [
      "turn/started",
      "item/started",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
      "item/agentMessage/delta",
      "item/completed",
    ];

    const firstActivity = await Promise.race(
      firstActivityMethods.map((method) =>
        rpc
          .waitForNotification(
            method,
            (params) =>
              params?.turn?.id === turnId || params?.turnId === turnId,
          )
          .then((message) => ({
            method: message.method,
            params: message.params,
          })),
      ),
    );
    marks.firstActivity = Date.now();

    const firstOutput = await Promise.race([
      rpc
        .waitForNotification(
          "item/agentMessage/delta",
          (params) => params?.turnId === turnId,
        )
        .then(() => ({ source: "agentMessageDelta" })),
      rpc
        .waitForNotification(
          "item/completed",
          (params) =>
            params?.turnId === turnId && params?.item?.type === "agentMessage",
        )
        .then(() => ({ source: "agentMessageCompleted" })),
    ]);
    marks.firstOutput = Date.now();

    const completed = await rpc.waitForNotification(
      "turn/completed",
      (params) => params?.turn?.id === turnId,
    );
    marks.turnCompleted = Date.now();

    await new Promise((resolve) => setTimeout(resolve, 750));
    const after = await collectStorageStats(options.codexHome);

    metrics.after = after;
    metrics.storageDelta = {
      sessionsBytes: after.sessionsBytes - before.sessionsBytes,
      sqliteBytes: after.sqliteBytes - before.sqliteBytes,
    };
    metrics.timingsMs = {
      resume: marks.resumeDone - marks.resumeStart,
      turnSetup: marks.turnRequested - marks.resumeDone,
      firstActivity: marks.firstActivity - marks.turnRequested,
      firstOutput: marks.firstOutput - marks.turnRequested,
      total: marks.turnCompleted - marks.turnRequested,
    };
    metrics.turn = {
      id: turnId,
      status: completed.params?.turn?.status ?? null,
      firstActivityMethod: firstActivity.method,
      firstOutputSource: firstOutput.source,
    };
    metrics.rss = {
      peakKb: peakRssKb,
      peakMiB: Number((peakRssKb / 1024).toFixed(1)),
      samples: rssSamples.length,
      lastKb: rssSamples[rssSamples.length - 1]?.rssKb ?? null,
    };

    console.log(JSON.stringify(metrics, null, 2));
  } finally {
    clearInterval(rssTimer);
    await rpc.cleanup();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
