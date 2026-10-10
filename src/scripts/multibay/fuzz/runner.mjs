/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Layer 1 of the multibay fuzzer: seeded random operations and faults
// against a real MultibayCluster, checked against the reference model
// (model.mjs). See src/.agents/multibay-fuzzing-plan-2026-10-05.md.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AccountClient,
  createAccount,
  eventually,
  runInBay,
} from "../harness.mjs";
import {
  expectDuringFault,
  generateOp,
  makeRng,
  Model,
  VISIBLE_GROUPS,
} from "./model.mjs";

/** Invariant names, as used in reports and FUZZ_ALLOW. */
export const INVARIANTS = [
  "one-owner", // I1
  "owner-state", // I2
  "projections-converge", // I3
  "one-home", // I4
  "permissions", // I5
  "honest-errors", // I6
];

const OP_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}: timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// Errors that do not say whether the call took effect: the edge's explicit
// OUTCOME_UNKNOWN, a client-side timeout and a lost connection.
export function isUnknownOutcome(error) {
  return /OUTCOME_UNKNOWN|outcome unknown|\btimeout\b|code='408'|CONNECTION_LOST|socket has been disconnected/i.test(
    `${error}`,
  );
}

export class FuzzRun {
  constructor(cluster, { seed, steps, faultRate, checkEvery, allow, outDir }) {
    this.cluster = cluster;
    this.seed = seed;
    this.steps = steps;
    this.faultRate = faultRate;
    this.checkEvery = checkEvery;
    this.allow = new Set(allow);
    this.outDir = outDir;
    this.rng = makeRng(seed);
    this.model = new Model();
    this.clients = new Map();
    this.names = new Map(); // id -> short name, for readable logs
    this.log = [];
    this.violations = [];
    this.warnings = [];
    this.failedRenames = [];
    this.unknownOutcomes = 0;
    this.pendingInvites = new Set();
    this.step = 0;
    this.projectCount = 0;
  }

  name(id) {
    if (id == null) return undefined;
    if (!this.names.has(id)) this.names.set(id, `p${this.projectCount++}`);
    return this.names.get(id);
  }

  note(entry) {
    this.log.push({ step: this.step, ...entry });
  }

  violate(invariant, detail) {
    const v = { step: this.step, invariant, detail };
    if (this.allow.has(invariant)) this.warnings.push(v);
    else this.violations.push(v);
    this.note({ violation: invariant, detail });
  }

  async setup() {
    const [seed, attached] = this.cluster.bayIds;
    const plan = [
      ["a0", seed],
      ["a1", seed],
      ["b0", attached],
      ["b1", attached],
    ];
    for (const [short, home_bay_id] of plan) {
      const account = await createAccount(this.cluster, {
        home_bay_id,
        name: `fuzz${this.seed}${short}`,
      });
      this.names.set(account.account_id, short);
      this.model.addAccount({ ...account, name: short });
      const client = await new AccountClient(this.cluster, account).ready();
      this.clients.set(account.account_id, client);
    }
  }

  close() {
    for (const c of this.clients.values()) c.close();
  }

  async run() {
    await this.setup();
    try {
      while (this.step < this.steps) {
        if (this.step > 0 && this.rng.chance(this.faultRate)) {
          await this.fault();
        } else {
          await this.perform(generateOp(this.model, this.rng, this.step));
        }
        this.step++;
        if (this.step % this.checkEvery === 0) await this.checkpoint();
      }
      if (this.step % this.checkEvery !== 0) await this.checkpoint();
    } finally {
      this.close();
      this.writeLog();
    }
    return {
      violations: this.violations,
      warnings: this.warnings,
      timings: this.timings(),
      unknownOutcomes: this.unknownOutcomes,
    };
  }

  // ---------------------------------------------------------------- ops

  async perform(op, { duringFault = false } = {}) {
    let expect = duringFault ? expectDuringFault(op.expect) : op.expect;
    const inviteKey = op.kind === "invite" && `${op.project_id}:${op.target}`;
    if (inviteKey && this.pendingInvites.has(inviteKey) && expect === "ok") {
      expect = "either"; // a stale invite from an earlier failed attempt
    }
    const start = Date.now();
    let result;
    let error;
    try {
      result = await withTimeout(this.execute(op), OP_TIMEOUT_MS, op.kind);
    } catch (err) {
      error = `${err?.message ?? err}`.slice(0, 300);
    }
    const ms = Date.now() - start;
    this.note({
      op: this.describe(op),
      expect,
      outcome: error ? "error" : "ok",
      ms,
      ...(duringFault ? { duringFault } : {}),
      ...(error ? { error } : {}),
    });
    if (error) {
      // A timeout or lost connection does not say whether the call ran, and
      // the edge says so explicitly (OUTCOME_UNKNOWN) when the owning bay
      // never answered. Honest errors (I6) holds for definite errors only.
      const unknownOutcome = isUnknownOutcome(error);
      if (unknownOutcome) this.unknownOutcomes += 1;
      if (op.kind === "rename" && !unknownOutcome) {
        this.failedRenames.push({
          project_id: op.project_id,
          title: op.title,
          step: this.step,
        });
      }
      if (inviteKey) this.pendingInvites.add(inviteKey);
      if (expect === "ok") {
        this.violate("permissions", `allowed ${op.kind} failed: ${error}`);
      }
      // It may have been applied anyway: adopt the owning bay's value at the
      // next checkpoint (honest-errors checks renames).
      if (op.project_id) {
        for (const field of Model.fields(op))
          this.model.markUncertain(op.project_id, field);
      }
      return;
    }
    if (expect === "fail") {
      this.violate(
        "permissions",
        `forbidden ${op.kind} succeeded: ${JSON.stringify(this.describe(op))}`,
      );
    }
    if (inviteKey) this.pendingInvites.delete(inviteKey);
    this.model.apply(op, result);
    if (op.kind === "create") this.name(result.project_id);
  }

  describe(op) {
    return {
      kind: op.kind,
      actor: this.name(op.actor),
      ...(op.project_id ? { project: this.name(op.project_id) } : {}),
      ...(op.target ? { target: this.name(op.target) } : {}),
      ...(op.title ? { title: op.title } : {}),
      ...(op.role ? { role: op.role } : {}),
    };
  }

  async execute(op) {
    const c = this.clients.get(op.actor);
    switch (op.kind) {
      case "create":
        return {
          project_id: await c.call("projects.createProject", {
            title: op.title,
            start: false,
          }),
        };
      case "rename":
        return await c.call("projects.setProjectMetadata", {
          project_id: op.project_id,
          patch: { title: op.title },
        });
      case "invite": {
        const { invite } = await c.call("projects.createCollabInvite", {
          project_id: op.project_id,
          invitee_account_id: op.target,
        });
        const invitee = this.clients.get(op.target);
        const inbound = await eventually(
          async () =>
            (
              await invitee.call("projects.listCollabInvites", {
                direction: "inbound",
                status: "pending",
              })
            ).find((row) => row.invite_id === invite.invite_id),
          { timeoutMs: 20_000, what: "the invite in the invitee's inbox" },
        );
        return await invitee.call("projects.respondCollabInvite", {
          invite_id: inbound.invite_id,
          project_id: op.project_id,
          action: "accept",
        });
      }
      case "set-role":
        return await c.call("projects.setProjectUserRole", {
          opts: {
            project_id: op.project_id,
            target_account_id: op.target,
            role: op.role,
          },
        });
      case "remove":
        return await c.call("projects.removeCollaborator", {
          opts: { project_id: op.project_id, account_id: op.target },
        });
      case "transfer":
        return await c.call("projects.transferProjectOwnership", {
          project_id: op.project_id,
          from_account_id: op.actor,
          to_account_id: op.target,
        });
    }
    throw new Error(`unknown op ${op.kind}`);
  }

  // ------------------------------------------------------------- faults

  async fault() {
    const [seed, attached] = this.cluster.bayIds;
    const kind = this.rng.pick([
      "freeze",
      "freeze",
      "freeze",
      "lock-registry",
      "restart",
    ]);
    const opsDuring = this.rng.int(1, 2);
    const bay = this.rng.pick([seed, attached]);
    const describe =
      kind === "freeze"
        ? { fault: kind, bay }
        : kind === "restart"
          ? { fault: kind, bay: attached }
          : { fault: kind };
    this.note({ ...describe, opsDuring });
    const runOps = async () => {
      for (let i = 0; i < opsDuring; i++) {
        await this.perform(generateOp(this.model, this.rng, this.step), {
          duringFault: true,
        });
      }
    };
    if (kind === "freeze") {
      this.cluster.signal(bay, "SIGSTOP");
      try {
        await sleep(this.rng.int(1_000, 4_000));
        await runOps();
      } finally {
        this.cluster.signal(bay, "SIGCONT");
      }
    } else if (kind === "lock-registry") {
      const lock = lockCredentialRegistry(this.cluster, this.rng.int(10, 15));
      try {
        await sleep(2_000);
        await runOps();
      } finally {
        await lock;
      }
    } else {
      const restart = this.cluster.restartBay(attached);
      try {
        await runOps();
      } finally {
        await restart;
      }
    }
    await this.heal();
    await this.checkpoint();
  }

  /** Wait until every account can talk to its home bay again. */
  async heal() {
    for (const bay of this.cluster.bayIds) this.cluster.signal(bay, "SIGCONT");
    for (const c of this.clients.values()) {
      await eventually(() => c.call("system.getAccountBay", {}), {
        timeoutMs: 120_000,
        what: "the cluster to answer again",
      });
    }
  }

  // ----------------------------------------------------------- checking

  async truth() {
    const project_ids = [...this.model.projects.keys()];
    const account_ids = [...this.model.accounts.keys()];
    const perBay = {};
    for (const bay of this.cluster.bayIds) {
      perBay[bay] = await runInBay(
        this.cluster,
        bay,
        `const getPool = require("@cocalc/database/pool").default;
         const projects = (await getPool().query(
           "SELECT project_id, owning_bay_id, title, users FROM projects WHERE project_id = ANY($1::uuid[]) AND deleted IS NOT TRUE",
           [${JSON.stringify(project_ids)}])).rows;
         const accounts = (await getPool().query(
           "SELECT account_id, home_bay_id FROM accounts WHERE account_id = ANY($1::uuid[]) AND deleted IS NOT TRUE",
           [${JSON.stringify(account_ids)}])).rows;
         return { projects, accounts };`,
      );
    }
    return perBay;
  }

  async checkpoint() {
    this.note({ checkpoint: true });
    const truth = await this.truth();
    const bays = this.cluster.bayIds;

    // I1 one owner, then the owning bay's rows.
    const ownerRow = new Map();
    for (const project of this.model.projects.values()) {
      const claims = bays.filter((bay) =>
        truth[bay].projects.some(
          (row) =>
            row.project_id === project.project_id && row.owning_bay_id === bay,
        ),
      );
      if (claims.length !== 1 || claims[0] !== project.owning_bay_id) {
        this.violate(
          "one-owner",
          `${this.name(project.project_id)}: claimed by [${claims}], expected ${project.owning_bay_id}`,
        );
        continue;
      }
      ownerRow.set(
        project.project_id,
        truth[claims[0]].projects.find(
          (row) => row.project_id === project.project_id,
        ),
      );
    }

    // I6 honest errors: a failed rename must not have taken effect.
    for (const failed of this.failedRenames) {
      if (ownerRow.get(failed.project_id)?.title === failed.title) {
        this.violate(
          "honest-errors",
          `rename of ${this.name(failed.project_id)} to ${failed.title} (step ${failed.step}) failed but was applied`,
        );
      }
    }
    this.failedRenames = [];

    // Adopt the owning bay's value for fields left uncertain by failures.
    for (const [project_id, fields] of this.model.uncertain) {
      const row = ownerRow.get(project_id);
      const project = this.model.projects.get(project_id);
      if (!row || !project) continue;
      if (fields.has("title")) project.title = row.title;
      if (fields.has("users")) project.users = visibleUsers(row.users);
      this.note({ reconciled: this.name(project_id), fields: [...fields] });
    }
    this.model.uncertain.clear();

    // I2 owner state.
    for (const project of this.model.projects.values()) {
      const row = ownerRow.get(project.project_id);
      if (!row) continue;
      const actual = visibleUsers(row.users);
      if (row.title !== project.title) {
        this.violate(
          "owner-state",
          `${this.name(project.project_id)} title ${row.title}, expected ${project.title}`,
        );
      }
      if (
        JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(project.users))
      ) {
        this.violate(
          "owner-state",
          `${this.name(project.project_id)} users ${this.groups(actual)}, expected ${this.groups(project.users)}`,
        );
      }
    }

    // I4 one home.
    for (const account of this.model.accounts.values()) {
      const homes = bays.filter((bay) =>
        truth[bay].accounts.some(
          (row) =>
            row.account_id === account.account_id && row.home_bay_id === bay,
        ),
      );
      if (homes.length !== 1 || homes[0] !== account.home_bay_id) {
        this.violate(
          "one-home",
          `${account.name}: homed on [${homes}], expected ${account.home_bay_id}`,
        );
      }
    }

    // I3 projections converge (bounded).
    for (const [account_id, client] of this.clients) {
      const expected = this.model.expectedList(account_id);
      let diff = null;
      try {
        await eventually(
          async () => {
            const rows = await client.call(
              "projects.listAccountProjectWindow",
              { limit: 200 },
            );
            const ours = new Map(
              rows
                .filter((row) => this.model.projects.has(row.project_id))
                .map((row) => [
                  row.project_id,
                  {
                    title: row.title,
                    group: row.users_summary?.[account_id]?.group ?? null,
                  },
                ]),
            );
            diff = this.listDiff(expected, ours);
            return diff.length === 0;
          },
          { timeoutMs: 60_000, intervalMs: 1_000, what: "projection" },
        );
      } catch {
        this.violate(
          "projections-converge",
          `${this.name(account_id)}: ${diff?.join("; ")}`,
        );
      }
    }
  }

  listDiff(expected, actual) {
    const out = [];
    for (const [id, want] of expected) {
      const got = actual.get(id);
      if (!got) out.push(`missing ${this.name(id)}`);
      else if (got.title !== want.title || got.group !== want.group) {
        out.push(
          `${this.name(id)} is ${got.title}/${got.group}, expected ${want.title}/${want.group}`,
        );
      }
    }
    for (const id of actual.keys()) {
      if (!expected.has(id)) out.push(`unexpected ${this.name(id)}`);
    }
    return out;
  }

  groups(users) {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(users).map(([id, g]) => [this.name(id), g]),
      ),
    );
  }

  writeLog() {
    if (!this.outDir) return;
    const file = path.join(this.outDir, `fuzz-seed-${this.seed}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          seed: this.seed,
          steps: this.steps,
          violations: this.violations,
          warnings: this.warnings,
          timings: this.timings(),
          unknownOutcomes: this.unknownOutcomes,
          log: this.log,
        },
        null,
        1,
      ),
    );
    this.logFile = file;
  }

  /** Per operation kind outside faults: count and median/max duration. */
  timings() {
    const byKind = {};
    for (const e of this.log) {
      if (!e.op || e.duringFault) continue;
      (byKind[e.op.kind] ??= []).push(e.ms);
    }
    return Object.fromEntries(
      Object.entries(byKind).map(([kind, ms]) => {
        ms.sort((a, b) => a - b);
        return [
          kind,
          {
            n: ms.length,
            median_ms: ms[ms.length >> 1],
            max_ms: ms[ms.length - 1],
          },
        ];
      }),
    );
  }

  report() {
    const tail = this.log
      .slice(-40)
      .map((e) => JSON.stringify(e))
      .join("\n");
    return (
      `seed ${this.seed} (FUZZ_SEED=${this.seed} FUZZ_RUNS=1 FUZZ_STEPS=${this.steps}):\n` +
      this.violations
        .map((v) => `  step ${v.step} ${v.invariant}: ${v.detail}`)
        .join("\n") +
      `\n--- last log entries ---\n${tail}` +
      (this.logFile ? `\n--- full log: ${this.logFile}` : "")
    );
  }
}

function visibleUsers(users) {
  return Object.fromEntries(
    Object.entries(users ?? {})
      .filter(([, info]) => VISIBLE_GROUPS.has(info?.group))
      .map(([id, info]) => [id, info.group]),
  );
}

function sorted(users) {
  return Object.entries(users).sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Hold the seed's bay credential registry unreadable for `seconds`. */
async function lockCredentialRegistry(cluster, seconds) {
  await runInBay(
    cluster,
    cluster.bayIds[0],
    `const getPool = require("@cocalc/database/pool").default;
     const db = await getPool().connect();
     try {
       await db.query("BEGIN");
       await db.query("LOCK TABLE cluster_bay_credentials IN ACCESS EXCLUSIVE MODE");
       await db.query("SELECT pg_sleep($1)", [${seconds}]);
       await db.query("COMMIT");
     } finally {
       db.release();
     }`,
    { timeoutMs: (seconds + 60) * 1000 },
  );
}
