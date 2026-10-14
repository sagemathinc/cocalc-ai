/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Project ineligibility reaches running work: tickets record the projects a
// computer may be serving (at most 500), the re-check raises a project's
// floor when its bay says it is no longer eligible, and only a verified,
// signed hard-delete tombstone raises the terminal floor.
// Real SQL (PGlite): run with COCALC_TEST_USE_PGLITE=1.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import {
  parseProjectDeleted,
  SIGNED_KINDS,
  TERMINAL_PRIVACY_EPOCH,
} from "@cocalc/util/computers/protocol";
import {
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  randomNonce,
  signEnvelope,
} from "@cocalc/backend/computers/crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterId } from "@cocalc/server/cluster-config";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (name: string, value: string) =>
    `test-enc:${name}:${Buffer.from(value).toString("base64")}`,
  decryptSecretStorageValue: async (name: string, value: string) => ({
    value: Buffer.from(
      value.slice(`test-enc:${name}:`.length),
      "base64",
    ).toString(),
    needsMigration: false,
  }),
}));
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://cocalc.ai",
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const tables = [
  "account_computers",
  "account_computer_sessions",
  "account_computer_session_targets",
  "account_computer_project_floors",
  "account_computer_active_projects",
  "account_computer_requests",
  "account_computer_operations",
  "account_computer_ticket_log",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_personal_controls",
  "agent_networks",
  "agent_network_members",
  "projects",
  "accounts",
];

const OTHER_BAY = "bay-9";

describeDb("re-checking the projects a computer serves", () => {
  const db = () => getPool();
  const account = randomUUID();
  const network = randomUUID();
  const agent = randomUUID();
  const run = randomUUID();
  let project: string;
  let computer_id: string;
  const otherBayKey = generateSigningKey();

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
    await db().query(`CREATE TABLE IF NOT EXISTS deleted_projects (
      project_id UUID PRIMARY KEY, owner_account_id UUID,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  });

  beforeEach(async () => {
    for (const t of [...tables.slice().reverse(), "deleted_projects"])
      await db().query(`DELETE FROM ${t}`);
    (await import("./signing-keys")).resetSigningKeyCacheForTesting();
    (await import("./recheck")).setRecheckDepsForTesting(undefined);
    project = randomUUID();
    await db().query(
      "INSERT INTO accounts (account_id, email_address, created) VALUES ($1,'a@example.org',now())",
      [account],
    );
    await db().query(
      `INSERT INTO agent_networks (agent_network_id, account_id, title, state, delivery_mode, generation, created_by)
       VALUES ($1,$2,'lab','active','queued',$3,$2)`,
      [network, account, randomUUID()],
    );
    await db().query(
      `INSERT INTO agent_network_members
         (agent_network_id, member_kind, member_id, registered_agent_id, project_id, added_by)
       VALUES ($1,'registered',$2,$2,$3,$4)`,
      [network, agent, project, account],
    );
    await db().query(
      `INSERT INTO projects (project_id, users) VALUES ($1,$2)`,
      [project, JSON.stringify({ [account]: { group: "owner" } })],
    );
    // Another bay of the cluster, with its key in the directory.
    await db().query(
      `INSERT INTO cluster_computer_signing_keys (kid, bay_id, public_key, not_after)
       VALUES ($1,$2,$3,now() + interval '300 days')`,
      [otherBayKey.fingerprint, OTHER_BAY, otherBayKey.publicDer],
    );
    const r = await import("./requests");
    const resolved = parseComputerPolicy({
      version: 1,
      mode: "direct",
      duration: null,
      agent_network_id: network,
      network: "on",
      gpu: true,
      mounts: [],
      images: { kind: "any" },
      scratch_bytes: null,
      limits: { cpu_millis: null, memory_bytes: null, pids: null },
    });
    const { request_id } = await r.createComputerRequest({
      account_id: account,
      name: "mac",
      requested_policy: resolved,
    });
    const view = await r.getPairingView(request_id);
    const signing = generateSigningKey();
    const { transcript_hash } = await r.submitPairing({
      request_id,
      transcript: signEnvelope(
        SIGNED_KINDS.transcript,
        {
          type: "cocalc-computer-pairing",
          version: 1,
          site: view.site,
          cluster_id: view.cluster_id,
          request_id,
          account_id: account,
          policy_hash: policyHash(resolved),
          signing_key: signing.fingerprint,
          agreement_key: generateAgreementKey().fingerprint,
          client_nonce: randomNonce(),
          server_nonce: view.server_nonce,
          machine: { hostname: "mac", os: "darwin", arch: "arm64", user: "w" },
        },
        signing,
      ),
      signing_public_key: signing.publicDer,
      resolved_policy: resolved,
    });
    const generation = (
      await db().query(
        "SELECT generation FROM agent_networks WHERE agent_network_id=$1",
        [network],
      )
    ).rows[0].generation;
    ({ computer_id } = await r.approveComputerRequest({
      agent_network_generation: generation,
      account_id: account,
      request_id,
      transcript_hash,
    }));
  });

  async function issue(
    operation = "exec",
    request: unknown = { command: "true" },
  ) {
    const { attestProjectLocal } = await import("./attestation");
    const { issueComputerTicket } = await import("./tickets");
    return await issueComputerTicket({
      account_id: account,
      agent_id: agent,
      run_id: run,
      source_project_id: project,
      run_expires_at: Date.now() + 3_600_000,
      computer: "mac",
      operation: operation as any,
      request,
      operation_id: randomUUID(),
      pop_key: generateSigningKey().publicDer,
      attestation: await attestProjectLocal({
        project_id: project,
        account_id: account,
        home_bay_id: getConfiguredBayId(),
      }),
    });
  }

  const active = async (project_id = project) =>
    (
      await db().query(
        "SELECT * FROM account_computer_active_projects WHERE computer_id=$1 AND project_id=$2",
        [computer_id, project_id],
      )
    ).rows[0];
  const floor = async (project_id = project) =>
    (
      await db().query(
        "SELECT privacy_epoch FROM account_computer_project_floors WHERE computer_id=$1 AND project_id=$2",
        [computer_id, project_id],
      )
    ).rows[0]?.privacy_epoch;
  const snapshotFloors = async () =>
    (await (await import("./state")).computerStateSnapshot(computer_id))!
      .envelope.payload.project_floors;

  /** A transaction holding nothing but the ticket's per-computer order. */
  async function inTx<T>(fn: (c: any) => Promise<T>): Promise<T> {
    const c = await db().connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  const admit = async (
    project_id: string,
    possibly_active_until: number | null,
    start_by = Date.now() + 60_000,
  ) =>
    await inTx(async (c) =>
      (await import("./recheck")).admitActiveProject(c, {
        computer_id,
        account_id: account,
        project_id,
        possibly_active_until,
        start_by,
        attesting_bay_id: getConfiguredBayId(),
        now: Date.now(),
      }),
    );

  it("a ticket records its project as possibly active there, for exactly as long as its work may last", async () => {
    const before = Date.now();
    await issue("exec", { command: "true", timeout_ms: 600_000 });
    let a = await active();
    expect(a.last_attesting_bay_id).toBe(getConfiguredBayId());
    const start_by = new Date(a.last_start_by).valueOf();
    expect(start_by).toBeGreaterThanOrEqual(before);
    expect(new Date(a.possibly_active_until).valueOf()).toBe(
      start_by + 600_000 + 5 * 60_000,
    );
    // A job: open-ended (until computer->hub reports exist), and a later
    // exec never shortens that.
    await issue("run", {
      command: "sleep 1",
      cwd: null,
      description: "a job",
      name: null,
      exclusive: false,
      nice: false,
    });
    await issue("exec", { command: "true" });
    a = await active();
    expect(a.possibly_active_until).toBeNull();
  });

  it("at most 500 projects at once; safely expired ones are dropped first, with their floors", async () => {
    const past = Date.now() - 60 * 60_000;
    // 500 expired exec projects with floors, their GC not run yet.
    const expired: string[] = [];
    for (let i = 0; i < 500; i++) expired.push(randomUUID());
    await db().query(
      `INSERT INTO account_computer_active_projects
         (computer_id, project_id, account_id, possibly_active_until,
          last_start_by, last_attesting_bay_id, next_check_at)
       SELECT $1, p, $2, $3, $3, 'bay-0', now() FROM unnest($4::uuid[]) p`,
      [computer_id, account, new Date(past), expired],
    );
    await db().query(
      `INSERT INTO account_computer_project_floors
         (computer_id, project_id, account_id, privacy_epoch)
       SELECT $1, p, $2, 3 FROM unnest($3::uuid[]) p`,
      [computer_id, account, expired],
    );
    // They are no longer in the snapshot.
    expect(await snapshotFloors()).toEqual({});
    // 500 new active projects are admitted (the expired ones go first)...
    const fresh: string[] = [];
    for (let i = 0; i < 500; i++) {
      fresh.push(randomUUID());
      await admit(fresh[i], Date.now() + 60 * 60_000);
    }
    expect(await floor(expired[0])).toBeUndefined();
    // ...and a 501st is refused, while one already in the set is not.
    await expect(admit(randomUUID(), Date.now() + 60_000)).rejects.toThrow(
      /too many projects/,
    );
    await admit(fresh[7], Date.now() + 60_000);
    // With floors for all 500, the snapshot holds exactly those.
    await db().query(
      `INSERT INTO account_computer_project_floors
         (computer_id, project_id, account_id, privacy_epoch)
       SELECT $1, p, $2, 4 FROM unnest($3::uuid[]) p`,
      [computer_id, account, fresh],
    );
    expect(Object.keys(await snapshotFloors())).toHaveLength(500);
  });

  it("1001 projects over a computer's life (execs) are all admitted as earlier ones expire", async () => {
    for (let i = 0; i < 1001; i++) {
      const p = randomUUID();
      await admit(p, Date.now() + 60_000);
      // It is over: past its possibly-active time and its start_by.
      await db().query(
        `UPDATE account_computer_active_projects
            SET possibly_active_until=now() - interval '1 second',
                last_start_by=now() - interval '1 second'
          WHERE computer_id=$1 AND project_id=$2`,
        [computer_id, p],
      );
    }
    const { rows } = await db().query(
      "SELECT count(*)::int AS n FROM account_computer_active_projects WHERE computer_id=$1",
      [computer_id],
    );
    expect(rows[0].n).toBeLessThanOrEqual(1);
  });

  it("jobs are open-ended until reports exist: at most 500 projects with jobs over a computer's life", async () => {
    const ids = Array.from({ length: 500 }, () => randomUUID());
    await db().query(
      `INSERT INTO account_computer_active_projects
         (computer_id, project_id, account_id, possibly_active_until,
          last_start_by, last_attesting_bay_id, next_check_at)
       SELECT $1, p, $2, NULL, now() - interval '1 day', 'bay-0', now()
         FROM unnest($3::uuid[]) p`,
      [computer_id, account, ids],
    );
    await expect(admit(randomUUID(), Date.now() + 60_000)).rejects.toThrow(
      /too many projects/,
    );
  });

  /**
   * Fake cluster: what each bay answers. Like a real fabric client, every
   * call ends by the timeout it is given; `inFlight` counts calls still
   * running.
   */
  const inFlight = { n: 0 };
  function cluster(
    answers: {
      owner?: string | null;
      recheck?: Record<string, (timeoutMs: number) => Promise<any>>;
      evidence?: Record<string, (timeoutMs: number) => Promise<any>>;
      bays?: string[];
    },
    deadline?: number,
  ) {
    const asked: string[] = [];
    const call = async <T>(
      timeoutMs: number,
      f: () => Promise<T>,
    ): Promise<T> => {
      inFlight.n += 1;
      let timer;
      try {
        return await Promise.race([
          f(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        inFlight.n -= 1;
      }
    };
    (
      require("./recheck") as typeof import("./recheck")
    ).setRecheckDepsForTesting(
      {
        resolveOwner: async () =>
          answers.owner === undefined ? getConfiguredBayId() : answers.owner,
        atBay: (bay_id, timeoutMs) => ({
          recheckProject: async (opts) =>
            await call(timeoutMs, async () => {
              asked.push(`recheck:${bay_id}`);
              const f = answers.recheck?.[bay_id];
              if (f) return await f(timeoutMs);
              return await (
                await import("./attestation")
              ).recheckProjectLocal(opts);
            }),
          projectHardDeleteEvidence: async () =>
            await call(timeoutMs, async () => {
              asked.push(`evidence:${bay_id}`);
              const f = answers.evidence?.[bay_id];
              return f ? await f(timeoutMs) : { kind: "unknown" };
            }),
        }),
        configuredBays: () => answers.bays ?? [getConfiguredBayId(), OTHER_BAY],
      },
      deadline,
    );
    return asked;
  }
  /** Never answers (until its caller's timeout ends the call). */
  const hang = () => new Promise<never>(() => {});

  const tombstone = (overrides: object = {}, key = otherBayKey) =>
    signEnvelope(
      SIGNED_KINDS.project_deleted,
      parseProjectDeleted({
        type: "cocalc-project-deleted",
        version: 1,
        site: "https://cocalc.ai",
        cluster_id: getConfiguredClusterId(),
        project_id: project,
        account_id: account,
        project_bay_id: OTHER_BAY,
        deleted_at: Date.now() - 1000,
        issued_at: Date.now(),
        ...overrides,
      }),
      key,
    );

  /** Make the project's row due and run one pass. */
  async function pass() {
    await db().query(
      "UPDATE account_computer_active_projects SET next_check_at=now() - interval '1 second', lease_until=NULL",
    );
    return await (await import("./recheck")).recheckDueProjects();
  }

  it("a collaborator added: the floor rises to the new epoch and the snapshot carries it; other projects are untouched", async () => {
    await issue();
    const other = randomUUID();
    await admit(other, Date.now() + 60 * 60_000);
    cluster({});
    const version = async () =>
      `${(await db().query("SELECT state_version FROM account_computers WHERE computer_id=$1", [computer_id])).rows[0].state_version}`;
    expect(await pass()).toBe(2);
    expect(await floor()).toBeUndefined();
    const v0 = await version();
    await db().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      project,
      JSON.stringify({
        [account]: { group: "owner" },
        [randomUUID()]: { group: "collaborator" },
      }),
    ]);
    await pass();
    expect(`${await floor()}`).toBe("1");
    expect(await version()).not.toBe(v0);
    expect(await snapshotFloors()).toEqual({ [project]: 1 });
    expect(await floor(other)).toBeUndefined();
    // Rescheduled 30 s later, not before.
    const a = await active();
    expect(new Date(a.next_check_at).valueOf()).toBeGreaterThan(
      Date.now() + 20_000,
    );
    expect(a.attempts).toBe("0");
  });

  it("a soft delete raises the floor; an undelete admits new tickets above it", async () => {
    await issue();
    cluster({});
    await db().query("UPDATE projects SET deleted=true WHERE project_id=$1", [
      project,
    ]);
    await pass();
    expect(`${await floor()}`).toBe("1");
    await db().query("UPDATE projects SET deleted=false WHERE project_id=$1", [
      project,
    ]);
    const result: any = await issue();
    expect(result.ticket.payload.attestation.payload.privacy_epoch).toBe(2);
    await pass();
    // Eligible again at 2: work from before (below 2) stops; the new
    // ticket at 2 is above the floor.
    expect(`${await floor()}`).toBe("2");
  });

  it("a delete and undelete between two re-checks still stops the older work (the floor follows an eligible newer epoch)", async () => {
    await issue();
    cluster({});
    await pass();
    expect(await floor()).toBeUndefined();
    await db().query("UPDATE projects SET deleted=true WHERE project_id=$1", [
      project,
    ]);
    await db().query("UPDATE projects SET deleted=false WHERE project_id=$1", [
      project,
    ]);
    await pass();
    expect(`${await floor()}`).toBe("2");
    expect(await snapshotFloors()).toEqual({ [project]: 2 });
    const later: any = await issue();
    expect(later.ticket.payload.attestation.payload.privacy_epoch).toBe(2);
  });

  it("ownership transferred, then the project hard-deleted at once: the tombstone ends it for the earlier owner's computers too", async () => {
    await issue();
    // Transferred to another account, then hard-deleted by it.
    await db().query("DELETE FROM projects WHERE project_id=$1", [project]);
    await db().query(
      "INSERT INTO deleted_projects (project_id, owner_account_id) VALUES ($1,$2)",
      [project, randomUUID()],
    );
    cluster({ owner: null });
    await pass();
    expect(`${await floor()}`).toBe(`${TERMINAL_PRIVACY_EPOCH}`);
  });

  it("a slow bay never hides a valid tombstone (either order), and no call outlives the re-check", async () => {
    await issue();
    const { determine, __depsForTesting } = await import("./recheck");
    for (const order of [
      [OTHER_BAY, "bay-slow"],
      ["bay-slow", OTHER_BAY],
    ]) {
      cluster({
        owner: null,
        recheck: { [getConfiguredBayId()]: async () => ({ kind: "unknown" }) },
        evidence: {
          [OTHER_BAY]: async () => ({ kind: "deleted", evidence: tombstone() }),
          "bay-slow": hang,
        },
        bays: order,
      });
      const started = Date.now();
      const outcome = await determine(
        {
          project_id: project,
          account_id: account,
          last_attesting_bay_id: getConfiguredBayId(),
          attempts: 0,
        },
        __depsForTesting()!,
        Date.now() + 1500,
      );
      expect([order, outcome.kind]).toEqual([order, "deleted"]);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(inFlight.n).toBe(0);
    }
  });

  it("a hard delete after the directory entry is gone: the last attesting bay's signed tombstone raises the terminal floor", async () => {
    await issue();
    await db().query(
      "UPDATE account_computer_active_projects SET last_attesting_bay_id=$1",
      [OTHER_BAY],
    );
    const asked = cluster({
      owner: null,
      recheck: {
        [OTHER_BAY]: async () => ({ kind: "deleted", evidence: tombstone() }),
      },
    });
    await pass();
    expect(asked).toEqual([`recheck:${OTHER_BAY}`]);
    expect(`${await floor()}`).toBe(`${TERMINAL_PRIVACY_EPOCH}`);
    expect(await snapshotFloors()).toEqual({
      [project]: TERMINAL_PRIVACY_EPOCH,
    });
  });

  it("a rehome then an immediate hard delete: the old bay says unknown, the cluster lookup finds the real tombstone", async () => {
    await issue();
    const asked = cluster({
      owner: null,
      recheck: { [getConfiguredBayId()]: async () => ({ kind: "unknown" }) },
      evidence: {
        [OTHER_BAY]: async () => ({ kind: "deleted", evidence: tombstone() }),
      },
    });
    await pass();
    expect(asked).toEqual([
      `recheck:${getConfiguredBayId()}`,
      `evidence:${getConfiguredBayId()}`,
      `evidence:${OTHER_BAY}`,
    ]);
    expect(`${await floor()}`).toBe(`${TERMINAL_PRIVACY_EPOCH}`);
  });

  it("never a false terminal floor: unknown everywhere, an unreachable bay, a forged or misbound tombstone, an owner that doesn't know it", async () => {
    await issue();
    const cases: [string, Parameters<typeof cluster>[0]][] = [
      [
        "unknown everywhere (a rehome where the project is alive)",
        {
          owner: null,
          recheck: {
            [getConfiguredBayId()]: async () => ({ kind: "unknown" }),
          },
        },
      ],
      [
        "a bay unreachable",
        {
          owner: null,
          recheck: {
            [getConfiguredBayId()]: async () => ({ kind: "unknown" }),
          },
          evidence: {
            [OTHER_BAY]: async () => {
              throw new Error("unreachable");
            },
          },
        },
      ],
      [
        "a tombstone signed by another bay's key",
        {
          owner: null,
          recheck: {
            [getConfiguredBayId()]: async () => ({ kind: "unknown" }),
          },
          evidence: {
            [OTHER_BAY]: async () => ({
              kind: "deleted",
              evidence: tombstone({}, generateSigningKey()),
            }),
          },
        },
      ],
      [
        "a tombstone for another account",
        {
          owner: null,
          recheck: {
            [getConfiguredBayId()]: async () => ({ kind: "unknown" }),
          },
          evidence: {
            [OTHER_BAY]: async () => ({
              kind: "deleted",
              evidence: tombstone({ account_id: randomUUID() }),
            }),
          },
        },
      ],
      [
        "a tombstone naming another bay than its signer",
        {
          owner: null,
          recheck: {
            [getConfiguredBayId()]: async () => ({ kind: "unknown" }),
          },
          evidence: {
            [OTHER_BAY]: async () => ({
              kind: "deleted",
              evidence: tombstone({ project_bay_id: getConfiguredBayId() }),
            }),
          },
        },
      ],
      [
        "the directory's owner doesn't have it yet",
        {
          owner: OTHER_BAY,
          recheck: { [OTHER_BAY]: async () => ({ kind: "unknown" }) },
        },
      ],
    ];
    for (const [what, answers] of cases) {
      cluster(answers);
      await pass();
      expect([what, await floor()]).toEqual([what, undefined]);
      const a = await active();
      expect([what, a.last_error != null]).toEqual([what, true]);
      await db().query(
        "UPDATE account_computer_active_projects SET attempts=0, last_error=NULL",
      );
    }
  });

  it("a fresh ticket brings a row out of a long failure backoff", async () => {
    await issue();
    await db().query(
      `UPDATE account_computer_active_projects
          SET next_check_at=now() + interval '30 minutes', attempts=6,
              last_error='unreachable'`,
    );
    await issue();
    const a = await active();
    expect(new Date(a.next_check_at).valueOf()).toBeLessThan(
      Date.now() + 31_000,
    );
    expect(`${a.attempts}`).toBe("0");
    expect(a.last_error).toBeNull();
  });

  it("more than 200 due rows, two hubs' passes at once, slow bays: each re-checked exactly once, none stranded", async () => {
    const ids = Array.from({ length: 250 }, () => randomUUID());
    await db().query(
      `INSERT INTO account_computer_active_projects
         (computer_id, project_id, account_id, possibly_active_until,
          last_start_by, last_attesting_bay_id, next_check_at)
       SELECT $1, p, $2, now() + interval '1 hour', now(), 'bay-0',
              now() - interval '1 second'
         FROM unnest($3::uuid[]) p`,
      [computer_id, account, ids],
    );
    const seen = new Map<string, number>();
    (await import("./recheck")).setRecheckDepsForTesting({
      resolveOwner: async () => getConfiguredBayId(),
      atBay: () => ({
        recheckProject: async (opts) => {
          seen.set(opts.project_id, (seen.get(opts.project_id) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, 20));
          return { kind: "unknown" };
        },
        projectHardDeleteEvidence: async () => ({ kind: "unknown" }),
      }),
      configuredBays: () => [getConfiguredBayId()],
    });
    const { recheckDueProjects } = await import("./recheck");
    const [a, b] = await Promise.all([
      recheckDueProjects(),
      recheckDueProjects(),
    ]);
    expect(a + b).toBe(250);
    expect(seen.size).toBe(250);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const { rows } = await db().query(
      `SELECT count(*)::int AS n FROM account_computer_active_projects
        WHERE computer_id=$1 AND (lease_until IS NOT NULL OR next_check_at <= now())`,
      [computer_id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("at the project's bay: a live project gets an attestation; a hard-deleted one its signed tombstone, for any account that asks", async () => {
    const { recheckProjectLocal, projectHardDeleteEvidenceLocal } =
      await import("./attestation");
    const opts = {
      project_id: project,
      account_id: account,
      home_bay_id: getConfiguredBayId(),
    };
    expect((await recheckProjectLocal(opts)).kind).toBe("attestation");
    expect((await projectHardDeleteEvidenceLocal(opts)).kind).toBe("unknown");
    await db().query("DELETE FROM projects WHERE project_id=$1", [project]);
    expect((await recheckProjectLocal(opts)).kind).toBe("unknown");
    await db().query(
      "INSERT INTO deleted_projects (project_id, owner_account_id) VALUES ($1,$2)",
      [project, account],
    );
    const r: any = await recheckProjectLocal(opts);
    expect(r.kind).toBe("deleted");
    expect(r.evidence.payload).toMatchObject({
      project_id: project,
      account_id: account,
      project_bay_id: getConfiguredBayId(),
    });
    // Issued for whichever account's computers ask (ownership may have
    // moved just before the delete).
    const another = randomUUID();
    const forAnother: any = await projectHardDeleteEvidenceLocal({
      ...opts,
      account_id: another,
    });
    expect(forAnother.kind).toBe("deleted");
    expect(forAnother.evidence.payload.account_id).toBe(another);
    // And the home bay accepts it (from the local bay) as terminal.
    await admit(project, Date.now() + 60_000);
    cluster({ owner: null });
    await pass();
    expect(`${await floor()}`).toBe(`${TERMINAL_PRIVACY_EPOCH}`);
  });
});
