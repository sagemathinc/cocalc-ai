/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { execFile, fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { issueProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";

const execute = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export type Role = "owner" | "a" | "b" | "host";

export class AcceptanceWorker {
  readonly child: ChildProcess;
  private next = 0;
  private output = "";
  private fatal?: string;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  readonly exited: Promise<void>;
  constructor(
    readonly role: Role,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = fork(join(__dirname, "worker.cjs"), [], {
      env,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const capture = (data: Buffer) => {
      this.output = (this.output + data.toString()).slice(-24000);
    };
    this.child.stdout!.on("data", capture);
    this.child.stderr!.on("data", capture);
    this.child.on("message", (message: any) => {
      if (message.fatal) {
        this.fatal = message.fatal;
        for (const pending of this.pending.values())
          pending.reject(Error(message.fatal));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(Error(`${role}: ${message.error}\n${this.output}`));
      else pending.resolve(message.result);
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        for (const pending of this.pending.values())
          pending.reject(
            Error(`${role} exited (${code}/${signal})\n${this.output}`),
          );
        this.pending.clear();
        resolve();
      });
    });
    this.child.on("error", (error) => {
      this.fatal = String(error);
      for (const pending of this.pending.values()) pending.reject(error);
    });
  }
  async call<T = any>(
    name: string,
    args: object = {},
    timeout = 30000,
  ): Promise<T> {
    if (this.fatal) throw Error(`${this.role}: ${this.fatal}`);
    const id = ++this.next;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(
          () => reject(Error(`${this.role}.${name} timed out\n${this.output}`)),
          timeout,
        );
        this.child.send({ id, name, args }, (error) => {
          if (error) reject(error);
        });
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      await this.call("shutdown", {}, 10000);
    } catch {}
    await Promise.race([this.exited, pause(1000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await Promise.race([this.exited, pause(2000)]);
    }
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGKILL");
    await this.exited;
  }
}

/** Owns its cluster; never connects to PGHOST/PGDATABASE inherited from the caller. */
export class MultibayAcceptance {
  readonly accounts = [randomUUID(), randomUUID()];
  readonly project = randomUUID();
  readonly host = randomUUID();
  readonly bays = ["acceptance-owner", "acceptance-a", "acceptance-b"];
  readonly workers = new Map<Role, AcceptanceWorker>();
  private readonly prefix = `collab_acceptance_${randomBytes(5).toString("hex")}`;
  private readonly accountSecrets = [randomUUID(), randomUUID()];
  private readonly hostSecret = randomUUID();
  private readonly systemSecret = randomUUID();
  private readonly hostSystemSecret = randomUUID();
  private readonly keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  private root = "";
  private bin = "";
  private pgAttempted = false;
  private pgPid?: number;
  private address = "";
  private expectedRoomId?: string;
  hostAddress = "";
  private credentials: string[] = [];

  footprint() {
    return {
      directory: this.root,
      pids: [
        this.pgPid,
        ...[...this.workers.values()].map((worker) => worker.child.pid),
      ].filter((pid): pid is number => pid != null),
    };
  }
  async start(afterOwnerReady?: () => void) {
    this.root = await mkdtemp(join(tmpdir(), "collab-acceptance-"));
    try {
      this.bin =
        process.env.COCALC_ACCEPTANCE_PG_BIN ||
        (await execute("pg_config", ["--bindir"])).stdout.trim();
      await execute(
        join(this.bin, "initdb"),
        [
          "-D",
          join(this.root, "pg"),
          "-A",
          "trust",
          "-U",
          "acceptance_admin",
          "--no-locale",
        ],
        { timeout: 30000 },
      );
      this.pgAttempted = true;
      await execute(
        join(this.bin, "pg_ctl"),
        [
          "-D",
          join(this.root, "pg"),
          "-l",
          join(this.root, "postgres.log"),
          "-o",
          `-k ${this.root} -p 5432 -c listen_addresses=''`,
          "-w",
          "start",
        ],
        { timeout: 30000 },
      );
      this.pgPid = Number(
        (await readFile(join(this.root, "pg/postmaster.pid"), "utf8")).split(
          "\n",
        )[0],
      );
      const admin = new Client({
        host: this.root,
        port: 5432,
        user: "acceptance_admin",
        database: "postgres",
        ssl: false,
      });
      await admin.connect();
      try {
        for (const role of ["owner", "a", "b"] as const) {
          const name = `${this.prefix}_${role}`;
          await admin.query(`CREATE ROLE ${name} LOGIN`);
          await admin.query(`CREATE DATABASE ${name} OWNER ${name}`);
          await admin.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);
        }
      } finally {
        await admin.end();
      }
      const owner = await this.spawn("owner");
      const info = await owner.call("boot", this.config("owner"), 90000);
      this.address = info.address;
      this.credentials = info.credentials;
      afterOwnerReady?.();
      for (const role of ["a", "b"] as const) {
        const worker = await this.spawn(role);
        await worker.call("boot", this.config(role), 90000);
      }
      const host = await this.spawn("host");
      this.hostAddress = (
        await host.call("boot", this.config("host"), 60000)
      ).address;
    } catch (error) {
      const log = await readFile(join(this.root, "postgres.log"), "utf8").catch(
        () => "",
      );
      await this.close();
      throw Error(`${error}\n${log.slice(-3000)}`);
    }
  }
  private config(role: Role) {
    const index = role === "owner" ? 0 : role === "a" ? 1 : 2;
    return {
      role,
      accounts: this.accounts,
      project: this.project,
      host: this.host,
      bays: this.bays,
      accountSecrets: this.accountSecrets,
      hostSecret: this.hostSecret,
      systemSecret: this.systemSecret,
      hostSystemSecret: this.hostSystemSecret,
      directory: join(this.root, role),
      address: this.address,
      bayCredential: this.credentials[index],
    };
  }
  private async spawn(role: Role) {
    const directory = join(this.root, role);
    await mkdir(directory, { recursive: true });
    // Whitelist inherited environment. In particular never inherit credentials,
    // real site URLs, SMC_DB, DATA, PGDATA, NODE_OPTIONS or cluster settings.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      LANG: "C.UTF-8",
      TZ: "UTC",
      NODE_ENV: "test",
      COCALC_TEST_MODE: "true",
      BASE_PATH: "/",
      COCALC_DATA_DIR: directory,
      SECRETS: join(directory, "secrets"),
      COCALC_LITE_SQLITE_FILENAME: join(directory, "host.sqlite"),
      COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY: this.keys.publicKey,
      COCALC_DB: "postgres",
      COCALC_DB_SKIP_ENSURE_EXISTS: "1",
      PGHOST: this.root,
      PGPORT: "5432",
      PGDATABASE: `${this.prefix}_${role}`,
      PGUSER: `${this.prefix}_${role}`,
      COCALC_BAY_ID:
        role === "owner"
          ? this.bays[0]
          : role === "a"
            ? this.bays[1]
            : this.bays[2],
      COCALC_CLUSTER_ROLE: role === "owner" ? "seed" : "attached",
      COCALC_CLUSTER_ID: this.prefix,
      COCALC_CLUSTER_SEED_BAY_ID: this.bays[0],
      COCALC_CLUSTER_SEED_CONAT_SERVER: this.address,
    };
    const worker = new AcceptanceWorker(role, env);
    this.workers.set(role, worker);
    return worker;
  }
  worker(role: Role) {
    return this.workers.get(role)!;
  }
  hub(role: "a" | "b", name: string, opts: object = {}) {
    return this.worker(role).call("hub", {
      name: `collaborators.${name}`,
      opts,
    });
  }
  async send(
    role: "a" | "b",
    method: string,
    opts: object,
    account_id?: string,
    timeout?: number,
  ) {
    // Bind the client's intent once, never retarget a retry after replacement.
    this.expectedRoomId ??= (
      await this.hub(role, "getRoom", { project_id: this.project })
    )?.room_id;
    if (!this.expectedRoomId) throw Error("fixture has no registered room");
    return this.worker(role).call("host", {
      address: this.hostAddress,
      method,
      opts: { expected_room_id: this.expectedRoomId, ...opts },
      account_id,
      timeout,
      token: issueProjectHostAuthToken({
        host_id: this.host,
        account_id: this.accounts[role === "a" ? 0 : 1],
        private_key: this.keys.privateKey,
        auth_actor: "account",
      }).token,
    });
  }
  async restartHost() {
    const old = this.worker("host");
    old.child.kill("SIGKILL");
    await Promise.race([
      old.exited,
      pause(5000).then(() => {
        throw Error("fixture host did not exit after SIGKILL");
      }),
    ]);
    for (const role of ["a", "b"] as const)
      await this.worker(role).call("resetHostConnection");
    const host = await this.spawn("host");
    this.hostAddress = (
      await host.call("boot", this.config("host"), 60000)
    ).address;
    return { oldPid: old.child.pid, newPid: host.child.pid };
  }
  async retrySend(role: "a" | "b", method: string, opts: object) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await this.send(role, method, opts);
      } catch (error) {
        if (!/human room service busy/.test(String(error))) throw error;
        await pause(50);
      }
    }
    throw Error("human send remained busy");
  }
  async converge(check: () => Promise<boolean>) {
    for (let pass = 0; pass < 40; pass++) {
      await this.worker("host").call("tick");
      await this.worker("a").call("tick");
      await this.worker("b").call("tick");
      if (await check()) return;
      await pause(100);
    }
    const diagnostics: Record<string, unknown> = {};
    for (const role of ["a", "b"] as const) {
      try {
        diagnostics[role] = await this.worker(role).call(
          "sql",
          {
            sql: `SELECT x.generation,x.revision,x.complete,x.last_error,x.failures,
            x.lease_until>now() AS authorized,
            (SELECT jsonb_agg(jsonb_build_object('kind',i.kind,'activity',i.metadata->>'activity'))
              FROM collaboration_index i WHERE i.account_id=x.account_id AND i.project_id=x.project_id) AS resources
            FROM collaboration_access x WHERE x.project_id=$1 LIMIT 4`,
            params: [this.project],
          },
          5000,
        );
      } catch {
        diagnostics[role] = "diagnostic unavailable";
      }
    }
    throw Error(
      `acceptance projections did not converge in 40 bounded passes: ${JSON.stringify(diagnostics)}`,
    );
  }
  sql(role: "owner" | "a" | "b", sql: string, params: unknown[] = []) {
    return this.worker(role).call<any[]>("sql", { sql, params });
  }
  async close() {
    // Stop ingress/host first, then account workers, and seed/fabric last.
    for (const role of ["host", "b", "a", "owner"] as const)
      await this.workers.get(role)?.close();
    this.workers.clear();
    if (this.pgAttempted) {
      const running = await execute(join(this.bin, "pg_ctl"), [
        "-D",
        join(this.root, "pg"),
        "status",
      ]).then(
        () => true,
        (error) => {
          if (error.code === 3) return false;
          throw error;
        },
      );
      if (running)
        await execute(
          join(this.bin, "pg_ctl"),
          ["-D", join(this.root, "pg"), "-m", "fast", "-w", "stop"],
          { timeout: 15000 },
        );
      this.pgAttempted = false;
      this.pgPid = undefined;
    }
    if (this.root) {
      await rm(this.root, { recursive: true, force: true });
      this.root = "";
    }
  }
}
