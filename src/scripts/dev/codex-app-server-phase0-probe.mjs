#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

function parseArgs(argv) {
  const options = {
    codex: "codex",
    cwd: process.cwd(),
    model: "gpt-5.3-codex-spark",
    timeoutMs: 90_000,
    interruptDelayMs: 1_500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--codex" && next) {
      options.codex = next;
      i += 1;
    } else if (arg === "--cwd" && next) {
      options.cwd = next;
      i += 1;
    } else if (arg === "--model" && next) {
      options.model = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--interrupt-delay-ms" && next) {
      options.interruptDelayMs = Number(next);
      i += 1;
    } else if (arg === "--help") {
      console.error(
        [
          "Usage: node codex-app-server-phase0-probe.mjs [options]",
          "",
          "Options:",
          "  --codex <path>               Codex binary path",
          "  --cwd <path>                 Working directory for app-server",
          "  --model <id>                 Model for thread/start",
          "  --timeout-ms <ms>            Request/notification timeout",
          "  --interrupt-delay-ms <ms>    Delay before turn/interrupt",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
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

function normalizeStatus(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return null;
  }
  return JSON.stringify(value);
}

function extractAgentText(thread, turnId) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const turn =
    turns.find((candidate) => candidate?.id === turnId) ??
    turns[turns.length - 1];
  if (!turn || !Array.isArray(turn.items)) {
    return null;
  }
  const agentItems = turn.items.filter((item) => item?.type === "agentMessage");
  if (agentItems.length === 0) {
    return null;
  }
  return (
    agentItems
      .map((item) => item.text ?? "")
      .join("\n")
      .trim() || null
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const child = spawn(options.codex, ["app-server", "--listen", "stdio://"], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

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
    if (!text) {
      return;
    }
    stderrTail.push(text);
    if (stderrTail.length > 40) {
      stderrTail.shift();
    }
  }

  function fulfillWaiters(message) {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (!waiter.matches(message)) {
        continue;
      }
      waiters.splice(i, 1);
      waiter.resolve(message);
    }
  }

  function handleResponse(message) {
    const request = pendingRequests.get(message.id);
    if (!request) {
      return;
    }
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
    if (notifications.length > 400) {
      notifications.shift();
    }
    fulfillWaiters(message);
  }

  function handleStdoutLine(line) {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      throw new Error(`invalid JSON-RPC line: ${line}\n${err}`);
    }
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
      if (newline === -1) {
        break;
      }
      const line = pendingStdout.slice(0, newline);
      pendingStdout = pendingStdout.slice(newline + 1);
      handleStdoutLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    pendingStderr += chunk.toString("utf8");
    while (true) {
      const newline = pendingStderr.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = pendingStderr.slice(0, newline);
      pendingStderr = pendingStderr.slice(newline + 1);
      pushTail(line);
    }
  });

  child.on("error", (err) => {
    pushTail(`spawn error: ${err.message}`);
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
    for (const request of pendingRequests.values()) {
      request.reject(error);
    }
    pendingRequests.clear();
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  });

  function send(message) {
    if (exited) {
      throw new Error(`cannot send to exited app-server: ${exitCode}`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function notify(method, params = {}) {
    send({ method, params });
  }

  function request(method, params = {}) {
    const id = nextId;
    nextId += 1;
    const promise = new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject, method });
    });
    send({ id, method, params });
    return withTimeout(promise, options.timeoutMs, method);
  }

  function waitForNotification(
    method,
    predicate = () => true,
    timeoutMs = options.timeoutMs,
  ) {
    const existing = notifications.find(
      (message) => message.method === method && predicate(message.params ?? {}),
    );
    if (existing) {
      return Promise.resolve(existing);
    }
    return withTimeout(
      new Promise((resolve, reject) => {
        waiters.push({
          resolve,
          reject,
          matches(message) {
            return message.method === method && predicate(message.params ?? {});
          },
        });
      }),
      timeoutMs,
      method,
    );
  }

  async function waitForTurnCompleted(turnId, expectedStatus = null) {
    const notification = await waitForNotification(
      "turn/completed",
      (params) => params?.turn?.id === turnId,
    );
    const status = normalizeStatus(notification.params?.turn?.status);
    if (expectedStatus && status !== expectedStatus) {
      throw new Error(
        `turn ${turnId} completed with status ${status}, expected ${expectedStatus}`,
      );
    }
    return notification.params;
  }

  async function cleanup() {
    if (exited) {
      return;
    }
    child.kill("SIGTERM");
    try {
      await withTimeout(
        new Promise((resolve) => child.once("exit", resolve)),
        3_000,
        "codex shutdown",
      );
    } catch {
      child.kill("SIGKILL");
    }
  }

  try {
    const result = { stderrTail };

    result.initialize = await request("initialize", {
      clientInfo: {
        name: "cocalc_phase0_probe",
        title: "CoCalc Phase 0 Probe",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoningSummaryText/delta",
        ],
      },
    });
    notify("initialized", {});

    result.account = await request("account/read", {});

    const threadStart = await request("thread/start", {
      cwd: options.cwd,
      model: options.model,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    result.threadStart = {
      threadId: threadStart.thread?.id ?? null,
      model: threadStart.model ?? null,
      sandbox: threadStart.sandbox ?? null,
      approvalPolicy: threadStart.approvalPolicy ?? null,
    };
    const threadId = threadStart.thread?.id;
    if (!threadId) {
      throw new Error(
        `thread/start did not return thread id: ${JSON.stringify(threadStart)}`,
      );
    }

    const turn1Start = await request("turn/start", {
      threadId,
      cwd: options.cwd,
      input: [
        {
          type: "text",
          text: "Reply with exactly one word: alpha",
          textElements: [],
        },
      ],
    });
    const turn1Id = turn1Start.turn?.id;
    if (!turn1Id) {
      throw new Error(
        `turn/start turn1 missing id: ${JSON.stringify(turn1Start)}`,
      );
    }
    const turn1Completed = await waitForTurnCompleted(turn1Id, "completed");
    const threadRead = await request("thread/read", {
      threadId,
      includeTurns: true,
    });
    result.threadRead = {
      threadId: threadRead.thread?.id ?? null,
      turnCount: Array.isArray(threadRead.thread?.turns)
        ? threadRead.thread.turns.length
        : 0,
    };
    result.turn1 = {
      turnId: turn1Id,
      status: normalizeStatus(turn1Completed.turn?.status),
      error: turn1Completed.turn?.error ?? null,
      text: extractAgentText(threadRead.thread, turn1Id),
    };

    const threadResume = await request("thread/resume", { threadId });
    result.threadResume = {
      threadId: threadResume.thread?.id ?? null,
      status: threadResume.thread?.status ?? null,
    };

    const turn2Start = await request("turn/start", {
      threadId,
      cwd: options.cwd,
      input: [
        {
          type: "text",
          text: "What single word did you reply with last turn? Reply with one word only.",
          textElements: [],
        },
      ],
    });
    const turn2Id = turn2Start.turn?.id;
    const turn2Completed = await waitForTurnCompleted(turn2Id, "completed");
    const threadRead2 = await request("thread/read", {
      threadId,
      includeTurns: true,
    });
    result.turn2 = {
      turnId: turn2Id,
      status: normalizeStatus(turn2Completed.turn?.status),
      error: turn2Completed.turn?.error ?? null,
      text: extractAgentText(threadRead2.thread, turn2Id),
    };

    const threadFork = await request("thread/fork", { threadId });
    const forkThreadId = threadFork.thread?.id;
    result.threadFork = {
      threadId: forkThreadId ?? null,
    };
    if (!forkThreadId) {
      throw new Error(
        `thread/fork missing thread id: ${JSON.stringify(threadFork)}`,
      );
    }
    const turnForkStart = await request("turn/start", {
      threadId: forkThreadId,
      cwd: options.cwd,
      input: [
        {
          type: "text",
          text: "What single word did you reply with in the original thread? Reply with one word only.",
          textElements: [],
        },
      ],
    });
    const turnForkId = turnForkStart.turn?.id;
    const turnForkCompleted = await waitForTurnCompleted(
      turnForkId,
      "completed",
    );
    const threadReadFork = await request("thread/read", {
      threadId: forkThreadId,
      includeTurns: true,
    });
    result.turnFork = {
      turnId: turnForkId,
      status: normalizeStatus(turnForkCompleted.turn?.status),
      error: turnForkCompleted.turn?.error ?? null,
      text: extractAgentText(threadReadFork.thread, turnForkId),
    };

    const interruptStart = await request("turn/start", {
      threadId,
      cwd: options.cwd,
      input: [
        {
          type: "text",
          text: "Run the shell command `sleep 30` and do not send a final answer before the command finishes.",
          textElements: [],
        },
      ],
    });
    const interruptTurnId = interruptStart.turn?.id;
    await delay(options.interruptDelayMs);
    const interruptResponse = await request("turn/interrupt", {
      threadId,
      turnId: interruptTurnId,
    });
    const interruptCompleted = await waitForTurnCompleted(
      interruptTurnId,
      "interrupted",
    );
    result.interrupt = {
      request: interruptResponse,
      status: normalizeStatus(interruptCompleted.turn?.status),
      error: interruptCompleted.turn?.error ?? null,
    };

    const compactResponse = await request("thread/compact/start", { threadId });
    const compactSignal = await waitForNotification(
      "item/started",
      (params) =>
        params?.threadId === threadId &&
        params?.item?.type === "contextCompaction",
      30_000,
    );
    result.compact = {
      response: compactResponse,
      signal: compactSignal,
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
