/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Revocation stops running work, end to end in one process: a real conat
// server with CoCalc's getUser/isAllowed, the hub's state delivery, and
// paired computers running the connector (daemon and session loop).
// Design: src/.agents/computers-revocation-gate-2026-10-14.md (§9).
// Real SQL (PGlite): run with COCALC_TEST_USE_PGLITE=1.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import { parseOperationRequest } from "@cocalc/util/computers/operations";
import {
  parseComputerTicket,
  parsePairingTranscript,
  parseProjectAttestation,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import {
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  randomNonce,
  requestHash,
  signEnvelope,
  signProofOfPossession,
  type KeyPair,
} from "@cocalc/backend/computers/crypto";
import { signChallengeRequest } from "@cocalc/backend/computers/login";
import { DaemonStore } from "@cocalc/backend/computers/daemon/state";
import { runConnector } from "@cocalc/backend/computers/connector";
import { initConatServer } from "@cocalc/backend/conat/test/setup";
import { connect } from "@cocalc/conat/core/client";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterId } from "@cocalc/server/cluster-config";

jest.setTimeout(90_000);

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
  decryptSettingValue: async (_name: string, value: string) => ({
    value,
    needsMigration: false,
  }),
  encryptSettingValue: async (_name: string, value: string) => value,
}));
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://cocalc.ai",
}));
jest.mock("@cocalc/server/auth/oauth/purge", () => ({
  getOAuthPurgeTargets: async () => [],
  queueOAuthClientPurges: async () => {},
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
  "account_computer_challenges",
  "account_computer_relays",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_personal_controls",
  "agent_networks",
  "agent_network_members",
  "projects",
  "accounts",
  "server_settings",
];

async function until(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Is this process alive? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeDb("revoking a computer stops its work", () => {
  const db = () => getPool();
  let server;
  let hub;
  let address: string;
  const scratch = mkdtempSync(join(tmpdir(), "revocation-"));
  const cleanups: (() => Promise<void> | void)[] = [];

  async function setComputersEnabled(on: boolean) {
    await db().query(
      "DELETE FROM server_settings WHERE name='computers_enabled'",
    );
    if (on) {
      await db().query(
        "INSERT INTO server_settings (name, value) VALUES ('computers_enabled','yes')",
      );
    }
    const { resetServerSettingsCache } =
      await import("@cocalc/database/settings/server-settings");
    resetServerSettingsCache();
  }

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
    await setComputersEnabled(true);
    const auth = await import("../conat/socketio/auth");
    server = await initConatServer({
      getUser: auth.getUser,
      isAllowed: auth.isAllowed,
      onDisconnect: auth.onUserDisconnect,
      systemAccountPassword: "secret",
      computerRevalidationMs: 500,
    });
    address = server.address();
    hub = connect({ address, systemAccountPassword: "secret", noCache: true });
    (await import("./relay")).setRelayClientForTesting(hub);
    const delivery = await import("./delivery");
    delivery.setDeliveryClientForTesting(hub);
    delivery.startComputerStateDelivery();
  });

  afterEach(async () => {
    for (const f of cleanups.splice(0).reverse()) await f();
    await setComputersEnabled(true);
    (await import("./delivery")).startComputerStateDelivery();
  });

  afterAll(async () => {
    (await import("./delivery")).stopComputerStateDelivery();
    hub?.close();
    await server?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * An account with an agent network, one agent in it, and a paired
   * computer serving it, with its daemon state on disk.
   */
  async function world() {
    const account = randomUUID();
    const network = randomUUID();
    const agent = randomUUID();
    const run = randomUUID();
    const project = randomUUID();
    const policy = parseComputerPolicy({
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
    await db().query(
      `INSERT INTO accounts (account_id, first_name, last_name, email_address, created)
       VALUES ($1,'Ada','Lovelace',$2,now())`,
      [account, `${account}@example.org`],
    );
    await db().query(
      `INSERT INTO agent_networks
         (agent_network_id, account_id, title, state, delivery_mode, generation, created_by)
       VALUES ($1,$2,'lab','active','queued',$3,$2)`,
      [network, account, randomUUID()],
    );
    // Two private projects, each with an agent in the network.
    const other = { agent: randomUUID(), project: randomUUID() };
    for (const [a, p] of [
      [agent, project],
      [other.agent, other.project],
    ]) {
      await db().query(
        `INSERT INTO agent_network_members
           (agent_network_id, member_kind, member_id, registered_agent_id, project_id, added_by)
         VALUES ($1,'registered',$2,$2,$3,$4)`,
        [network, a, p, account],
      );
      await db().query(
        "INSERT INTO projects (project_id, users) VALUES ($1,$2)",
        [p, JSON.stringify({ [account]: { group: "owner" } })],
      );
    }
    const r = await import("./requests");
    const { request_id } = await r.createComputerRequest({
      account_id: account,
      name: "m1",
      requested_policy: policy,
    });
    const view = await r.getPairingView(request_id);
    const key: KeyPair = generateSigningKey();
    const transcript = parsePairingTranscript({
      type: "cocalc-computer-pairing",
      version: 1,
      site: view.site,
      cluster_id: view.cluster_id,
      request_id,
      account_id: account,
      policy_hash: policyHash(policy),
      signing_key: key.fingerprint,
      agreement_key: generateAgreementKey().fingerprint,
      client_nonce: randomNonce(),
      server_nonce: view.server_nonce,
      machine: { hostname: "m1", os: "linux", arch: "x64", user: "sage" },
    });
    const { transcript_hash } = await r.submitPairing({
      request_id,
      transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, key),
      signing_public_key: key.publicDer,
      resolved_policy: policy,
    });
    const generation = (
      await db().query(
        "SELECT generation FROM agent_networks WHERE agent_network_id=$1",
        [network],
      )
    ).rows[0].generation;
    const { computer_id } = await r.approveComputerRequest({
      account_id: account,
      request_id,
      transcript_hash,
      agent_network_generation: generation,
    });
    const status = await r.getPairingStatus({ request_id, transcript_hash });
    const certificate = status.certificate!;
    const dir = mkdtempSync(join(scratch, "computer-"));
    DaemonStore.create(join(dir, "state"), {
      certificate,
      ceiling: status.policy!,
      directory: status.directory!,
      computer_key: key.fingerprint,
      agent_network_id: network,
    });

    /** Run the connector on a state directory (by default this one). */
    function start(opts: { stateDir?: string } = {}) {
      const sessions: string[] = [];
      const logs: string[] = [];
      const stop = new AbortController();
      const { createLoginChallenge } = require("./sessions");
      const done = runConnector({
        connection: {
          dir: opts.stateDir ?? dir,
          origin: "https://cocalc.ai",
          computer_id,
          name: "m1",
          key,
          duration: null,
        },
        io: { log: (m) => logs.push(m), confirm: async () => true },
        signal: stop.signal,
        challenge: async () => {
          const { assertComputersEnabled } = await import("./enabled");
          return await createLoginChallenge(
            signChallengeRequest({ certificate, key }),
            Date.now(),
            { assertEnabled: assertComputersEnabled },
          );
        },
        openConat: (auth) =>
          connect({
            address,
            noCache: true,
            reconnection: false,
            disableInbox: true,
            auth,
          } as any),
        onSession: (id) => sessions.push(id),
      });
      let finished = false;
      done.finally(() => (finished = true)).catch(() => {});
      const handle = {
        sessions,
        logs,
        done,
        get finished() {
          return finished;
        },
        stop: async () => {
          stop.abort();
          await done.catch(() => {});
        },
      };
      cleanups.push(handle.stop);
      return handle;
    }

    /** The newest session of this computer is ready (its state applied). */
    async function ready(c: { sessions: string[] }) {
      const { currentSession } = await import("./sessions");
      await until(
        async () =>
          c.sessions.length > 0 &&
          (await currentSession(computer_id))?.session_id ===
            c.sessions[c.sessions.length - 1],
      );
    }

    /**
     * A ticket and its operation row, as issueComputerTicket records them
     * (with the project's current privacy epoch, and the project recorded
     * as possibly active there).
     */
    async function ticketFor(
      operation: "exec" | "run",
      raw: unknown,
      who: { agent: string; project: string } = { agent, project },
    ) {
      const { getBaySigningKey } = await import("./signing-keys");
      const signer = await getBaySigningKey();
      const now = Date.now();
      const op = parseOperationRequest(operation, raw);
      const attestation = signEnvelope(
        SIGNED_KINDS.attestation,
        parseProjectAttestation({
          type: "cocalc-project-attestation",
          version: 1,
          site: "https://cocalc.ai",
          cluster_id: getConfiguredClusterId(),
          project_id: who.project,
          project_bay_id: getConfiguredBayId(),
          eligible: true,
          privacy_epoch: Number(
            (
              await db().query(
                "SELECT runtime_authority_revision FROM projects WHERE project_id=$1",
                [who.project],
              )
            ).rows[0].runtime_authority_revision ?? 0,
          ),
          account_id: account,
          home_bay_id: getConfiguredBayId(),
          issued_at: now,
          not_after: now + 30_000,
        }),
        signer,
      );
      const pop = generateSigningKey();
      const c = (
        await db().query(
          "SELECT epoch, policy_epoch, signing_key FROM account_computers WHERE computer_id=$1",
          [computer_id],
        )
      ).rows[0];
      const operation_id = randomUUID();
      const ticket = signEnvelope(
        SIGNED_KINDS.ticket,
        parseComputerTicket({
          type: "cocalc-computer-ticket",
          version: 1,
          ticket_id: randomUUID(),
          operation_id,
          operation,
          request_hash: requestHash(op),
          site: "https://cocalc.ai",
          cluster_id: getConfiguredClusterId(),
          issuer_bay_id: getConfiguredBayId(),
          home_epoch: 0,
          computer_id,
          computer_key: c.signing_key,
          account_id: account,
          agent_id: who.agent,
          agent_network_id: network,
          source_project_id: who.project,
          attestation,
          computer_epoch: Number(c.epoch),
          policy_epoch: Number(c.policy_epoch),
          ceiling_hash: policyHash(policy),
          run_id: run,
          run_expires_at: now + 3_600_000,
          pop_key: pop.publicDer,
          issued_at: now,
          start_by: now + 30_000,
          max_runtime_ms: 120_000,
          limits: { max_bytes: null, concurrency: 4 },
        }),
        signer,
      );
      const t = ticket.payload;
      const tx = await db().connect();
      try {
        await tx.query("BEGIN");
        await (
          await import("./recheck")
        ).admitActiveProject(tx, {
          computer_id,
          account_id: account,
          project_id: who.project,
          possibly_active_until: operation === "run" ? null : now + 600_000,
          start_by: t.start_by,
          attesting_bay_id: getConfiguredBayId(),
          now,
        });
        await tx.query("COMMIT");
      } finally {
        tx.release();
      }
      await db().query(
        `INSERT INTO account_computer_operations
           (computer_id, operation_id, account_id, agent_id, run_id,
            source_project_id, operation, request_hash, ticket_id, pop_key,
            state, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'issued',now())`,
        [
          computer_id,
          operation_id,
          account,
          who.agent,
          run,
          who.project,
          operation,
          t.request_hash,
          t.ticket_id,
          pop.publicDer,
        ],
      );
      return {
        ticket,
        proof: signProofOfPossession(pop, t.ticket_id, t.request_hash),
        request: op.request,
      };
    }

    async function relay(
      t: { ticket; proof; request },
      waitMs?: number,
      who: { agent: string; project: string } = { agent, project },
    ) {
      const { relayToComputer } = await import("./relay");
      return await relayToComputer({
        account_id: account,
        agent_id: who.agent,
        run_id: run,
        source_project_id: who.project,
        ticket: t.ticket,
        proof: t.proof,
        request: t.request,
        ...(waitMs == null ? {} : { waitMs }),
      });
    }

    /**
     * Start a detached job and a foreground exec that each record their pid
     * and then sleep (ignoring SIGTERM, so only SIGKILL stops them).
     */
    async function startWork(
      who: { agent: string; project: string } = { agent, project },
    ) {
      const pidFile = (what: string) => join(dir, `${who.project}-${what}.pid`);
      const body = (what: string) =>
        `trap '' TERM; echo $$ > ${pidFile(what)}; sleep 60`;
      const job: any = await relay(
        await ticketFor(
          "run",
          {
            command: body("job"),
            cwd: null,
            description: "a long job",
            name: null,
            exclusive: false,
            nice: false,
          },
          who,
        ),
        undefined,
        who,
      );
      expect(job).toMatchObject({ answered: true, reply: { ok: true } });
      // The exec's answer only comes when it ends: don't wait for it.
      const exec = relay(
        await ticketFor("exec", { command: body("exec") }, who),
        1000,
        who,
      );
      let pids: { job: number; exec: number } | undefined;
      await until(() => {
        if (!existsSync(pidFile("job")) || !existsSync(pidFile("exec"))) {
          return false;
        }
        pids = {
          job: Number(readFileSync(pidFile("job"), "utf8")),
          exec: Number(readFileSync(pidFile("exec"), "utf8")),
        };
        return pids.job > 0 && pids.exec > 0;
      });
      await exec.catch(() => {});
      expect(alive(pids!.job)).toBe(true);
      expect(alive(pids!.exec)).toBe(true);
      return pids!;
    }

    const endedOnDisk = (stateDir = dir) =>
      DaemonStore.open(join(stateDir, "state"))!.ended;

    return {
      account,
      project,
      other,
      computer_id,
      dir,
      start,
      ready,
      relay,
      ticketFor,
      startWork,
      endedOnDisk,
    };
  }

  it("revoked while it runs a job and an exec: both are killed and the connector ends for good", async () => {
    const w = await world();
    const c = w.start();
    await w.ready(c);
    const pids = await w.startWork();
    const { revokeComputer } = await import("./computers");
    await revokeComputer({ account_id: w.account, computer_id: w.computer_id });
    await until(() => c.finished, 30_000);
    expect(alive(pids.job)).toBe(false);
    expect(alive(pids.exec)).toBe(false);
    expect(w.endedOnDisk()).toEqual({ reason: "revoked" });
    expect(c.logs.join("\n")).toMatch(/session has ended/);
    // Started again, it stays ended and never logs in.
    const again = w.start();
    await again.done;
    expect(again.sessions).toEqual([]);
  });

  it("two sessions at once (the same computer twice): each applies the end", async () => {
    const w = await world();
    const copy = mkdtempSync(join(scratch, "copy-"));
    cpSync(join(w.dir, "state"), join(copy, "state"), { recursive: true });
    const one = w.start();
    await w.ready(one);
    const two = w.start({ stateDir: copy });
    await until(() => two.sessions.length > 0);
    // Both sessions are open; the second becomes ready too.
    await w.ready(two);
    const { revokeComputer } = await import("./computers");
    await revokeComputer({ account_id: w.account, computer_id: w.computer_id });
    await until(() => one.finished && two.finished, 30_000);
    expect(w.endedOnDisk()).toEqual({ reason: "revoked" });
    expect(w.endedOnDisk(copy)).toEqual({ reason: "revoked" });
  });

  it("revoked while offline, with the site's switch off: told at its next login attempt, and its detached job is killed", async () => {
    const w = await world();
    const c = w.start();
    await w.ready(c);
    const pids = await w.startWork();
    // Offline: the connector stops; the detached job keeps running.
    await c.stop();
    expect(alive(pids.job)).toBe(true);
    const { revokeComputer } = await import("./computers");
    await revokeComputer({ account_id: w.account, computer_id: w.computer_id });
    await setComputersEnabled(false);
    const back = w.start();
    await until(() => back.finished, 30_000);
    expect(back.sessions).toEqual([]);
    expect(alive(pids.job)).toBe(false);
    expect(w.endedOnDisk()).toEqual({ reason: "revoked" });
  });

  it("no operation reaches a session before its daemon has the current state", async () => {
    const delivery = await import("./delivery");
    delivery.stopComputerStateDelivery();
    const w = await world();
    const c = w.start();
    await until(() => c.sessions.length > 0);
    await expect(
      w.relay(await w.ticketFor("exec", { command: "echo early" })),
    ).rejects.toThrow(/catching up/);
    delivery.startComputerStateDelivery();
    await w.ready(c);
    const r: any = await w.relay(
      await w.ticketFor("exec", { command: "echo ready" }),
    );
    expect(r.reply.result.stdout).toBe("ready\n");
  });

  it("deleting the account ends its connected computer and kills its work", async () => {
    const w = await world();
    const c = w.start();
    await w.ready(c);
    const pids = await w.startWork();
    const { markAccountDeleted } = await import("../accounts/delete");
    await markAccountDeleted(w.account);
    await until(() => c.finished, 30_000);
    expect(alive(pids.job)).toBe(false);
    expect(alive(pids.exec)).toBe(false);
    expect(w.endedOnDisk()).toEqual({ reason: "deleted" });
  });

  it("a collaborator added to a project: its job and exec are killed within one re-check; another project's work continues", async () => {
    const w = await world();
    const c = w.start();
    await w.ready(c);
    const mine = await w.startWork();
    const theirs = await w.startWork(w.other);
    await db().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      w.project,
      JSON.stringify({
        [w.account]: { group: "owner" },
        [randomUUID()]: { group: "collaborator" },
      }),
    ]);
    // One re-check pass, through the real directory and project bay.
    await db().query(
      "UPDATE account_computer_active_projects SET next_check_at=now() - interval '1 second' WHERE computer_id=$1",
      [w.computer_id],
    );
    const { recheckDueProjects } = await import("./recheck");
    expect(await recheckDueProjects()).toBeGreaterThanOrEqual(2);
    await until(() => !alive(mine.job) && !alive(mine.exec), 30_000);
    expect(alive(theirs.job)).toBe(true);
    expect(alive(theirs.exec)).toBe(true);
    expect(c.finished).toBe(false);
    // The other project still gets new work done.
    const r: any = await w.relay(
      await w.ticketFor("exec", { command: "echo still" }, w.other),
      undefined,
      w.other,
    );
    expect(r.reply.result.stdout).toBe("still\n");
  });

  it("deleted and undeleted between two re-checks: the older work is killed, newer work runs", async () => {
    const w = await world();
    const c = w.start();
    await w.ready(c);
    const old = await w.startWork();
    await db().query("UPDATE projects SET deleted=true WHERE project_id=$1", [
      w.project,
    ]);
    await db().query("UPDATE projects SET deleted=false WHERE project_id=$1", [
      w.project,
    ]);
    await db().query(
      "UPDATE account_computer_active_projects SET next_check_at=now() - interval '1 second' WHERE computer_id=$1",
      [w.computer_id],
    );
    const { recheckDueProjects } = await import("./recheck");
    await recheckDueProjects();
    await until(() => !alive(old.job) && !alive(old.exec), 30_000);
    // A ticket at the new epoch (2) is above the floor.
    const r: any = await w.relay(
      await w.ticketFor("exec", { command: "echo newer" }),
    );
    expect(r.reply.result.stdout).toBe("newer\n");
    expect(c.finished).toBe(false);
  });
});
