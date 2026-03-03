#!/usr/bin/env node

/*
Detached Playwright-backed browser session daemon.

This process is launched by `cocalc browser session spawn` and kept alive in
the background until `cocalc browser session destroy` sends SIGTERM/SIGINT.
*/

import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

type SpawnCookie = {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};

type SpawnDaemonConfig = {
  spawn_id: string;
  state_file: string;
  target_url: string;
  headless?: boolean;
  timeout_ms?: number;
  executable_path?: string;
  session_name?: string;
  cookies?: SpawnCookie[];
};

type SpawnDaemonState = {
  spawn_id: string;
  pid: number;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  target_url: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  stopped_at?: string;
  ready_at?: string;
  reason?: string;
  error?: string;
  page_url?: string;
  executable_path?: string;
  session_name?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeError(err: unknown): string {
  return `${err instanceof Error ? err.stack || err.message : err}`;
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeState(
  file: string,
  current: SpawnDaemonState | undefined,
  patch: Partial<SpawnDaemonState>,
): SpawnDaemonState {
  const timestamp = nowIso();
  const next: SpawnDaemonState = {
    ...(current ?? ({} as SpawnDaemonState)),
    ...patch,
    updated_at: timestamp,
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  ensureParentDir(file);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
  renameSync(tmp, file);
  return next;
}

function readConfig(configPath: string): SpawnDaemonConfig {
  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid daemon config JSON: ${normalizeError(err)}`);
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // best-effort cleanup
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("daemon config must be an object");
  }
  const row = parsed as Record<string, unknown>;
  const spawn_id = `${row.spawn_id ?? ""}`.trim();
  const state_file = `${row.state_file ?? ""}`.trim();
  const target_url = `${row.target_url ?? ""}`.trim();
  if (!spawn_id) throw new Error("daemon config missing spawn_id");
  if (!state_file) throw new Error("daemon config missing state_file");
  if (!target_url) throw new Error("daemon config missing target_url");
  const timeoutMsRaw = Number(row.timeout_ms ?? 30_000);
  const timeout_ms =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.floor(timeoutMsRaw)
      : 30_000;
  const headless = row.headless === true;
  const executable_path = `${row.executable_path ?? ""}`.trim() || undefined;
  const session_name = `${row.session_name ?? ""}`.trim() || undefined;
  const cookies = Array.isArray(row.cookies)
    ? (row.cookies.filter(
        (x) =>
          x &&
          typeof x === "object" &&
          `${(x as any).name ?? ""}`.trim() &&
          `${(x as any).value ?? ""}`.length >= 0 &&
          `${(x as any).url ?? ""}`.trim(),
      ) as SpawnCookie[])
    : undefined;
  return {
    spawn_id,
    state_file,
    target_url,
    timeout_ms,
    headless,
    executable_path,
    session_name,
    cookies,
  };
}

async function main(): Promise<void> {
  const configPath = `${process.argv[2] ?? ""}`.trim();
  if (!configPath) {
    throw new Error("usage: browser-session-playwright-daemon <config.json>");
  }
  const config = readConfig(configPath);
  let state: SpawnDaemonState | undefined = undefined;
  state = writeState(config.state_file, state, {
    spawn_id: config.spawn_id,
    pid: process.pid,
    status: "starting",
    target_url: config.target_url,
    created_at: nowIso(),
    started_at: nowIso(),
    ...(config.executable_path ? { executable_path: config.executable_path } : {}),
    ...(config.session_name ? { session_name: config.session_name } : {}),
  });

  const playwright = (await import("playwright-core")) as any;
  const launchOpts: Record<string, unknown> = {
    headless: !!config.headless,
    timeout: config.timeout_ms,
    args: [
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  };
  if (config.executable_path) {
    launchOpts.executablePath = config.executable_path;
  }
  const browser = await playwright.chromium.launch(launchOpts);
  const context = await browser.newContext();
  if (config.cookies?.length) {
    await context.addCookies(config.cookies);
  }
  const page = await context.newPage();
  await page.goto(config.target_url, {
    waitUntil: "domcontentloaded",
    timeout: config.timeout_ms,
  });
  if (config.session_name) {
    try {
      await page.evaluate((sessionName: string) => {
        document.title = sessionName;
      }, config.session_name);
    } catch {
      // best-effort; title is metadata only
    }
  }
  state = writeState(config.state_file, state, {
    status: "ready",
    ready_at: nowIso(),
    page_url: page.url(),
  });

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    state = writeState(config.state_file, state, {
      status: "stopping",
      reason,
      stopped_at: nowIso(),
    });
    try {
      await context.close();
    } catch {
      // ignore shutdown races
    }
    try {
      await browser.close();
    } catch {
      // ignore shutdown races
    }
    writeState(config.state_file, state, {
      status: "stopped",
      reason,
      stopped_at: nowIso(),
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });
  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGHUP", () => {
    void stop("SIGHUP");
  });
  process.on("uncaughtException", (err) => {
    writeState(config.state_file, state, {
      status: "failed",
      error: normalizeError(err),
      stopped_at: nowIso(),
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    writeState(config.state_file, state, {
      status: "failed",
      error: normalizeError(err),
      stopped_at: nowIso(),
    });
    process.exit(1);
  });

  setInterval(() => {
    // keep detached process alive while browser session is active
  }, 60_000);
}

void main().catch((err) => {
  process.stderr.write(`${normalizeError(err)}\n`);
  process.exit(1);
});
