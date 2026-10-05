/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Boot a throwaway multibay cluster (one seed plus attached bays), each bay a
// real hub process with its own embedded Postgres, joined by the real
// inter-bay fabric. Everything lives in one temporary directory on free
// ports, so this runs in CI and next to a developer's own dev hubs.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const SRC = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const require = createRequire(import.meta.url);
const { normalizeHubCluster } = require("../dev/hub-cluster.js");

// Each hub also listens on a few ports just above its own.
const PORT_SPAN = 20;

async function portFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freePortRange(count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const base = 20_000 + PORT_SPAN * Math.floor(Math.random() * 1_500);
    let ok = true;
    for (let p = base; p < base + count * PORT_SPAN && ok; p += 1) {
      ok = await portFree(p);
    }
    if (ok) return base;
  }
  throw new Error("no free port range for a multibay cluster");
}

export class MultibayCluster {
  constructor({ bayIds = ["bay-0", "bay-1"], dir } = {}) {
    this.bayIds = bayIds;
    // Keep the path short: Postgres sockets live below it.
    this.dir =
      dir ??
      mkdtempSync(path.join(process.env.MULTIBAY_DIR ?? tmpdir(), "mb-"));
    this.home = path.join(this.dir, "home");
    this.procs = new Map();
  }

  async init() {
    mkdirSync(this.home, { recursive: true });
    mkdirSync(path.join(this.dir, "run"), { recursive: true, mode: 0o700 });
    const base = await freePortRange(this.bayIds.length);
    const config = {
      seed_bay_id: this.bayIds[0],
      bays: this.bayIds.map((id, i) => ({
        id,
        port: base + i * PORT_SPAN,
        bind_host: "127.0.0.1",
        state_dir: path.join(this.dir, id, "state"),
        data_dir: path.join(this.dir, id, "data"),
        debug_file: path.join(this.dir, id, "debug.log"),
        stdout_log: path.join(this.dir, id, "stdout.log"),
      })),
    };
    this.cluster = normalizeHubCluster(
      {
        HUB_DEV_CLUSTER_JSON: JSON.stringify(config),
        STATE_DIR: config.bays[0].state_dir,
        HUB_CMD: "./packages/hub/bin/start.sh postgres",
        COCALC_CLUSTER_ID: `ci-${path.basename(this.dir)}`,
      },
      { root: SRC },
    );
    return this;
  }

  bay(id) {
    const bay = this.cluster.bays.find((b) => b.id === id);
    if (!bay) throw new Error(`unknown bay ${id}`);
    return bay;
  }

  url(id) {
    return `http://127.0.0.1:${this.bay(id).port}`;
  }

  /** Directory holding this bay's Postgres data, secrets and env file. */
  postgresDir(id) {
    return path.join(this.bay(id).dataDir, "postgres");
  }

  hubPassword(id) {
    return readFileSync(
      path.join(this.postgresDir(id), "secrets", "conat-password"),
      "utf8",
    ).trim();
  }

  /** The environment a bay's hub runs with; never the caller's credentials. */
  env(id) {
    const bay = this.bay(id);
    const ids = this.cluster.bays.map((b) => b.id).join(",");
    const env = {
      PATH: [
        path.join(SRC, "packages/hub/node_modules/.bin"),
        path.join(SRC, "node_modules/.bin"),
        process.env.PATH,
      ].join(":"),
      HOME: this.home,
      XDG_RUNTIME_DIR: path.join(this.dir, "run"),
      LANG: process.env.LANG ?? "C.UTF-8",
      DEBUG: process.env.MULTIBAY_DEBUG ?? "cocalc:*,-cocalc:silly:*",
      DEBUG_FILE: bay.debugFile,
      DEBUG_CONSOLE: "no",
      HOST: bay.bindHost,
      PORT: `${bay.port}`,
      DATA_BASE: bay.dataDir,
      COCALC_DISABLE_NEXT: "1",
      // Projects without project hosts: these checks cover the control plane.
      COCALC_PROJECT_RUNTIME: "workspace",
      COCALC_ALLOW_INSECURE_HTTP_MODE: "true",
      COCALC_BAY_ID: bay.id,
      COCALC_CLUSTER_ROLE: bay.role,
      COCALC_CLUSTER_ID: this.cluster.clusterId,
      COCALC_BAY_CREDENTIAL_FILE: bay.credentialFile ?? "",
      COCALC_CLUSTER_BAY_IDS: ids,
      HUB_CLUSTER_BAY_IDS: ids,
      COCALC_CLUSTER_SEED_BAY_ID: bay.seedBayId,
    };
    if (bay.role === "seed") {
      env.COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE =
        this.cluster.credentialBootstrapFile;
    }
    if (bay.seedConatServer) {
      env.COCALC_CLUSTER_SEED_CONAT_SERVER = bay.seedConatServer;
    }
    for (const key of ["TMPDIR", "CI", "GITHUB_ACTIONS"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return env;
  }

  startBay(id) {
    const bay = this.bay(id);
    mkdirSync(path.dirname(bay.stdoutLog), { recursive: true });
    mkdirSync(bay.dataDir, { recursive: true });
    const fd = openSync(bay.stdoutLog, "a");
    const child = spawn("bash", ["-c", bay.cmd], {
      cwd: SRC,
      env: this.env(id),
      stdio: ["ignore", fd, fd],
      // Its own process group, so signals reach the hub and its children.
      detached: true,
    });
    this.procs.set(id, child);
    return child;
  }

  async waitReady(id, timeoutMs = 240_000) {
    const start = Date.now();
    const secrets = path.join(
      this.postgresDir(id),
      "secrets",
      "conat-password",
    );
    while (Date.now() - start < timeoutMs) {
      const child = this.procs.get(id);
      if (child?.exitCode != null) {
        throw new Error(
          `${id} exited with ${child.exitCode}:\n${this.tail(id, 60)}`,
        );
      }
      if (existsSync(secrets)) {
        try {
          const res = await fetch(`${this.url(id)}/customize`);
          if (res.status < 500) return;
        } catch {
          // not listening yet
        }
      }
      await sleep(1_000);
    }
    throw new Error(`${id} not ready after ${timeoutMs}ms:\n${this.tail(id)}`);
  }

  async start() {
    for (const id of this.bayIds) {
      this.startBay(id);
      // The seed must be up before attached bays enroll with it.
      await this.waitReady(id);
    }
  }

  /** Signal a hub's whole process group, e.g. SIGSTOP to simulate a stall. */
  signal(id, sig) {
    const child = this.procs.get(id);
    if (!child?.pid) throw new Error(`${id} is not running`);
    process.kill(-child.pid, sig);
  }

  async stopBay(id) {
    const child = this.procs.get(id);
    if (child?.pid && child.exitCode == null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        process.kill(-child.pid, "SIGCONT");
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const timedOut = await Promise.race([
        exited.then(() => false),
        sleep(30_000).then(() => true),
      ]);
      if (timedOut) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        await exited;
      }
    }
    // The embedded Postgres can outlive the hub; stop it as well.
    await this.stopPostgres(id);
  }

  async restartBay(id) {
    await this.stopBay(id);
    this.startBay(id);
    await this.waitReady(id);
  }

  async stopPostgres(id) {
    const pidFile = path.join(
      this.postgresDir(id),
      "postgres",
      "postmaster.pid",
    );
    for (let i = 0; i < 100 && existsSync(pidFile); i += 1) {
      const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
      if (!Number.isFinite(pid) || pid <= 0) return;
      try {
        process.kill(pid, i === 0 ? "SIGINT" : 0); // SIGINT = fast shutdown
      } catch {
        return;
      }
      await sleep(100);
    }
  }

  tail(id, lines = 40) {
    const file = this.bay(id).stdoutLog;
    if (!existsSync(file)) return "(no output)";
    return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  }

  async stop({ keep = !!process.env.MULTIBAY_KEEP } = {}) {
    for (const id of [...this.bayIds].reverse()) {
      await this.stopBay(id);
    }
    if (!keep) rmSync(this.dir, { recursive: true, force: true });
  }
}
