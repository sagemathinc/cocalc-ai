/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Act as accounts against a MultibayCluster through the real public hub API,
// and run small server-side setup steps inside a bay's own environment.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SRC } from "./cluster.mjs";

const require = createRequire(path.join(SRC, "packages/backend/package.json"));
const { connect } = require("@cocalc/conat/core/client");
const { inboxPrefix } = require("@cocalc/conat/names");
const callHub = require("@cocalc/conat/hub/call-hub").default;

/**
 * A signed-in browser-like session: a remember-me cookie for an auth session
 * created on the account's home bay and marked freshly authenticated (as
 * after a password plus second-factor sign-in), connected to that bay.
 * Calls take exactly the routes a browser's would.
 */
export class AccountClient {
  constructor(cluster, account, { bay = account.home_bay_id } = {}) {
    this.cluster = cluster;
    this.account_id = account.account_id;
    this.home_bay_id = account.home_bay_id;
    this.bay = bay;
  }

  async signIn() {
    const cookie = await runInBay(
      this.cluster,
      this.home_bay_id,
      `const { createRememberMeCookie } = server("auth/remember-me.js");
       const sessions = server("auth/auth-sessions.js");
       const account_id = ${JSON.stringify(this.account_id)};
       const { value, hash } = await createRememberMeCookie(account_id, 6 * 3600);
       await sessions.ensureAuthSessionForRememberMeHash({ session_hash: hash });
       await sessions.setSessionFreshAuth({
         account_id,
         session_hash: hash,
         factor_level: "totp",
         fresh_auth_until: new Date(Date.now() + 6 * 3600 * 1000),
         metadata_patch: { multibay_test: true },
       });
       return value;`,
    );
    this.cookie = cookie;
    this.client = connect({
      address: this.cluster.url(this.bay),
      noCache: true,
      extraHeaders: { Cookie: `remember_me=${cookie}` },
    });
    this.client.inboxPrefixHook = (info) =>
      info?.user
        ? inboxPrefix({ account_id: info.user.account_id })
        : undefined;
    return this;
  }

  async ready() {
    if (!this.client) await this.signIn();
    await this.client.waitUntilSignedIn({ timeout: 30_000 });
    const user = this.client.info?.user ?? {};
    if (user.account_id !== this.account_id) {
      throw new Error(`signed in as ${JSON.stringify(user)}`);
    }
    return this;
  }

  async call(name, ...args) {
    return await callHub({
      client: this.client,
      account_id: this.account_id,
      auth_session_hash: this.client.info?.user?.auth_session_hash ?? null,
      name,
      args,
      // As the hub API clients do: a call may ask for a longer timeout.
      timeout: args[0]?.timeout ?? 30_000,
    });
  }

  close() {
    this.client?.close();
  }
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const serverRequire = createRequire(
  path.join(SRC, "packages/server/package.json"),
);

/**
 * A connection of the test's own to a bay's database, for what a snippet is
 * too slow to start for: holding a lock for a set time, say. End it.
 */
export async function connectBayDatabase(cluster, bayId) {
  const { Client } = serverRequire("pg");
  const env = parseEnvFile(
    readFileSync(
      path.join(cluster.postgresDir(bayId), "local-postgres.env"),
      "utf8",
    ),
  );
  const db = new Client({
    host: env.PGHOST,
    user: env.PGUSER,
    database: env.PGDATABASE,
    ...(env.PGPORT ? { port: Number(env.PGPORT) } : {}),
  });
  await db.connect();
  return db;
}

function bayEnv(cluster, bayId) {
  const pg = cluster.postgresDir(bayId);
  const env = {
    ...cluster.env(bayId),
    ...parseEnvFile(readFileSync(path.join(pg, "local-postgres.env"), "utf8")),
    CONAT_SERVER: cluster.url(bayId),
    COCALC_PRODUCT: "launchpad",
    COCALC_HUB_PASSWORD: path.join(pg, "secrets", "conat-password"),
    DATA: pg,
    COCALC_DATA_DIR: pg,
  };
  // As packages/hub/bin/start.sh does: the hub derives its secret-settings
  // keys from the site master key, not this legacy override, so a snippet
  // must too to read what the hub encrypted.
  delete env.COCALC_SECRET_SETTINGS_KEY_PATH;
  return env;
}

const MARKER = "__MULTIBAY_RESULT__";
const SERVER_DIST = path.join(SRC, "packages/server/dist");

/**
 * Run a CommonJS snippet with the server package in a bay's environment
 * (its database and its fabric credential). The snippet's async result is
 * returned as JSON.
 *
 * Snippets run in one long-lived worker process per bay, since starting a
 * process that loads the server package takes about 1.5 s. Pass
 * `fresh: true` for a process of its own: for a snippet that changes process
 * or module state (process.env, a patched module), which would otherwise
 * leak into later snippets, or one that runs long (e.g. a fake host).
 */
export async function runInBay(
  cluster,
  bayId,
  body,
  { timeoutMs = 60_000, fresh = false } = {},
) {
  if (fresh) return await runInFreshProcess(cluster, bayId, body, timeoutMs);
  return await bayWorker(cluster, bayId).run(body, timeoutMs);
}

async function runInFreshProcess(cluster, bayId, body, timeoutMs) {
  const script = `
const server = (p) => require(${JSON.stringify(SERVER_DIST)} + "/" + p);
(async () => { ${body} })().then(
  (r) => { console.log(${JSON.stringify(MARKER)} + JSON.stringify({ ok: true, r: r ?? null })); process.exit(0); },
  (e) => { console.log(${JSON.stringify(MARKER)} + JSON.stringify({ ok: false, e: String(e?.stack ?? e) })); process.exit(1); });`;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: path.join(SRC, "packages/server"),
    env: bayEnv(cluster, bayId),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  // An ordinary timer, cleared once the child exits: a pending sleep() would
  // keep the test process alive for the rest of timeoutMs.
  let timer;
  const code = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("timeout");
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  const line = out.split("\n").find((l) => l.startsWith(MARKER));
  if (!line) {
    throw new Error(
      `runInBay(${bayId}) ${code}: ${err.slice(-2000)} ${out.slice(-1000)}`,
    );
  }
  const result = JSON.parse(line.slice(MARKER.length));
  if (!result.ok) throw new Error(`runInBay(${bayId}): ${result.e}`);
  return result.r;
}

// One worker per bay of each cluster. It reads {id, body} lines on stdin and
// answers each with a MARKER line on stdout.
const WORKER_SOURCE = `
const readline = require("node:readline");
const server = (p) => require(${JSON.stringify(SERVER_DIST)} + "/" + p);
const AsyncFunction = (async () => {}).constructor;
// A snippet's un-awaited work must not take the worker down with it.
process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, body } = JSON.parse(line);
  let reply;
  try {
    const r = await new AsyncFunction("require", "server", body)(require, server);
    reply = { id, ok: true, r: r ?? null };
  } catch (e) {
    reply = { id, ok: false, e: String(e?.stack ?? e) };
  }
  let text;
  try {
    text = JSON.stringify(reply);
  } catch (e) {
    text = JSON.stringify({ id, ok: false, e: "result is not JSON: " + e });
  }
  process.stdout.write(${JSON.stringify(MARKER)} + text + "\\n");
});`;

const workers = new WeakMap(); // cluster -> Map(bayId -> worker)

function bayWorker(cluster, bayId) {
  let byBay = workers.get(cluster);
  if (byBay == null) {
    byBay = new Map();
    workers.set(cluster, byBay);
    // A stopped bay's database is gone too: start a new worker after it.
    cluster.stopHooks.add((id) => {
      byBay.get(id)?.close();
      byBay.delete(id);
    });
  }
  let worker = byBay.get(bayId);
  if (worker == null || worker.dead) {
    worker = new BayWorker(cluster, bayId);
    byBay.set(bayId, worker);
  }
  return worker;
}

class BayWorker {
  constructor(cluster, bayId) {
    this.bayId = bayId;
    this.dead = false;
    this.next = 0;
    this.pending = new Map();
    this.err = "";
    this.child = spawn(process.execPath, ["-e", WORKER_SOURCE], {
      cwd: path.join(SRC, "packages/server"),
      env: bayEnv(cluster, bayId),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    this.child.stdout.on("data", (data) => {
      buffer += data;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const at = line.indexOf(MARKER);
        if (at < 0) continue; // a snippet's own output
        const reply = JSON.parse(line.slice(at + MARKER.length));
        const waiter = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        waiter?.(reply);
      }
    });
    this.child.stderr.on("data", (d) => {
      this.err = (this.err + d).slice(-4000);
    });
    this.child.once("exit", (code) => {
      this.dead = true;
      for (const waiter of this.pending.values()) {
        waiter({ ok: false, e: `worker exited (${code}): ${this.err.slice(-2000)}` });
      }
      this.pending.clear();
    });
    // Idle workers must not keep the test process alive.
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream.unref?.();
    }
  }

  async run(body, timeoutMs) {
    const id = this.next++;
    const reply = new Promise((resolve) => this.pending.set(id, resolve));
    this.child.stdin.write(JSON.stringify({ id, body }) + "\n");
    // While a snippet runs, keep the test process alive for its answer.
    this.child.ref();
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const result = await Promise.race([reply, timedOut]);
      if (result == null) {
        // A stuck snippet: don't let it hold the worker for later calls.
        this.close();
        throw new Error(`runInBay(${this.bayId}) timeout: ${this.err.slice(-2000)}`);
      }
      if (!result.ok) throw new Error(`runInBay(${this.bayId}): ${result.e}`);
      return result.r;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
      if (this.pending.size === 0 && !this.dead) this.child.unref();
    }
  }

  close() {
    this.dead = true;
    this.child.kill("SIGKILL");
  }
}

/** Create an account homed on `home_bay_id`, as sign-up on the seed does. */
export async function createAccount(cluster, { home_bay_id, name }) {
  const account_id = randomUUID();
  const email_address = `${name}-${account_id.slice(0, 8)}@multibay.test`;
  await runInBay(
    cluster,
    cluster.bayIds[0],
    `const { createClusterAccount } = server("inter-bay/accounts.js");
     return await createClusterAccount(${JSON.stringify({
       account_id,
       email_address,
       password: randomUUID(),
       display_name: name,
       home_bay_id,
       signup_reason: "multibay test",
     })});`,
  );
  return { account_id, email_address, home_bay_id };
}

/** Poll until `check()` returns a truthy value or the deadline passes. */
export async function eventually(
  check,
  { timeoutMs = 30_000, intervalMs = 500, what = "condition" } = {},
) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}; last: ${last?.message ?? JSON.stringify(last)}`,
  );
}
