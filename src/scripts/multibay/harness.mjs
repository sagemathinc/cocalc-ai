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
      timeout: 30_000,
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

/**
 * Run a CommonJS snippet with the server package in a bay's environment
 * (its database and its fabric credential). The snippet's async result is
 * returned as JSON.
 */
export async function runInBay(
  cluster,
  bayId,
  body,
  { timeoutMs = 60_000 } = {},
) {
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
  const marker = "__MULTIBAY_RESULT__";
  const script = `
const server = (p) => require(${JSON.stringify(path.join(SRC, "packages/server/dist"))} + "/" + p);
(async () => { ${body} })().then(
  (r) => { console.log(${JSON.stringify(marker)} + JSON.stringify({ ok: true, r: r ?? null })); process.exit(0); },
  (e) => { console.log(${JSON.stringify(marker)} + JSON.stringify({ ok: false, e: String(e?.stack ?? e) })); process.exit(1); });`;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: path.join(SRC, "packages/server"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      child.kill("SIGKILL");
      return "timeout";
    }),
  ]);
  const line = out.split("\n").find((l) => l.startsWith(marker));
  if (!line) {
    throw new Error(
      `runInBay(${bayId}) ${code}: ${err.slice(-2000)} ${out.slice(-1000)}`,
    );
  }
  const result = JSON.parse(line.slice(marker.length));
  if (!result.ok) throw new Error(`runInBay(${bayId}): ${result.e}`);
  return result.r;
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
