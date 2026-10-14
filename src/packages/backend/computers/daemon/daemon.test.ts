/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The daemon core end to end, against a fake hub that signs real
// certificates, attestations, tickets and floors, running real processes.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  directPolicyDefaults,
  parseComputerPolicy,
} from "@cocalc/util/computers/policy";
import {
  parseComputerCertificate,
  parseComputerState,
  parseComputerFloors,
  parseComputerTicket,
  parseProjectAttestation,
  SIGNED_KINDS,
  type ComputerTicket,
} from "@cocalc/util/computers/protocol";
import {
  parseOperationRequest,
  type OperationRequest,
} from "@cocalc/util/computers/operations";
import {
  canonicalHash,
  generateSigningKey,
  policyHash,
  requestHash,
  signEnvelope,
  signProofOfPossession,
  type KeyPair,
} from "../crypto";
import { HubClock, SessionClock, systemClocks, type Clocks } from "./clock";
import { ComputerDaemon, type OperationReply } from "./daemon";
import { DaemonStore, type TrustedKey } from "./state";

const SITE = "https://cocalc.ai";
const CLUSTER = "standalone";
const HOME = "bay-0";
const PROJECT_BAY = "bay-1";

function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(poll, 25);
    };
    poll();
  });
}

describe("the computer daemon (direct mode)", () => {
  let dir: string;
  let workdir: string;
  const homeKey = generateSigningKey();
  const projectBayKey = generateSigningKey();
  const strangerKey = generateSigningKey();
  const computerKey = generateSigningKey();
  const account_id = randomUUID();
  const computer_id = randomUUID();
  const agent_network_id = randomUUID();
  const agent = randomUUID();
  const otherAgent = randomUUID();
  const project_id = randomUUID();
  const ceiling = parseComputerPolicy({
    version: 1,
    mode: "direct",
    duration: null,
    agent_network_id,
    ...directPolicyDefaults(),
  });
  const directory: TrustedKey[] = [
    {
      kid: homeKey.fingerprint,
      bay_id: HOME,
      public_key: homeKey.publicDer,
      not_after: Date.now() + 86_400_000,
    },
    {
      kid: projectBayKey.fingerprint,
      bay_id: PROJECT_BAY,
      public_key: projectBayKey.publicDer,
      not_after: Date.now() + 86_400_000,
    },
  ];

  function certificate(
    overrides: Record<string, unknown> = {},
    signer = homeKey,
  ) {
    const now = Date.now();
    return signEnvelope(
      SIGNED_KINDS.certificate,
      parseComputerCertificate({
        type: "cocalc-computer-certificate",
        version: 1,
        site: SITE,
        cluster_id: CLUSTER,
        computer_id,
        account_id,
        home_bay_id: HOME,
        home_epoch: 0,
        signing_key: computerKey.fingerprint,
        signing_public_key: computerKey.publicDer,
        agreement_key: generateSigningKey().fingerprint,
        transcript_hash: canonicalHash({ transcript: 1 }),
        ceiling_hash: policyHash(ceiling),
        not_before: now,
        not_after: now + 86_400_000,
        ...overrides,
      }),
      signer,
    );
  }

  let store: DaemonStore;
  let daemon: ComputerDaemon;
  let clocks: Clocks;
  let session: SessionClock;

  function makeDaemon(
    limits = {
      deadline_ms: null as number | null,
      max_ms: null as number | null,
    },
  ) {
    const hubClock = new HubClock(clocks);
    hubClock.observe(0);
    session = new SessionClock(clocks, limits);
    return new ComputerDaemon({
      stateDir: dir,
      store,
      clocks,
      hubClock,
      session,
      workdir,
      shell: "/bin/bash",
      killGraceMs: 200,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "computer-daemon-"));
    workdir = join(dir, "work");
    mkdirSync(workdir);
    clocks = systemClocks;
    store = DaemonStore.create(join(dir, "state"), {
      certificate: certificate(),
      ceiling,
      directory,
      computer_key: computerKey.fingerprint,
      agent_network_id,
    });
    daemon = makeDaemon();
  });

  afterEach(() => {
    daemon.endSession("test over");
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the agent's CLI sends after the hub issued a ticket. */
  function message(
    operation: OperationRequest["operation"],
    request: unknown,
    opts: {
      operation_id?: string;
      agent_id?: string;
      ticket?: Partial<ComputerTicket>;
      attestation?: Record<string, unknown>;
      attestationSigner?: KeyPair;
      ticketSigner?: KeyPair;
      pop?: KeyPair;
      proofKey?: KeyPair;
      sendRequest?: unknown;
    } = {},
  ) {
    const now = Date.now();
    const op = parseOperationRequest(operation, request);
    const pop = opts.pop ?? generateSigningKey();
    const attestation = signEnvelope(
      SIGNED_KINDS.attestation,
      parseProjectAttestation({
        type: "cocalc-project-attestation",
        version: 1,
        site: SITE,
        cluster_id: CLUSTER,
        project_id,
        project_bay_id: PROJECT_BAY,
        eligible: true,
        privacy_epoch: 1,
        account_id,
        home_bay_id: HOME,
        issued_at: now,
        not_after: now + 30_000,
        ...opts.attestation,
      }),
      opts.attestationSigner ?? projectBayKey,
    );
    const ticket = parseComputerTicket({
      type: "cocalc-computer-ticket",
      version: 1,
      ticket_id: randomUUID(),
      operation_id: opts.operation_id ?? randomUUID(),
      operation,
      request_hash: requestHash(op),
      site: SITE,
      cluster_id: CLUSTER,
      issuer_bay_id: HOME,
      home_epoch: 0,
      computer_id,
      computer_key: computerKey.fingerprint,
      account_id,
      agent_id: opts.agent_id ?? agent,
      agent_network_id,
      source_project_id: project_id,
      attestation,
      computer_epoch: 0,
      policy_epoch: 0,
      ceiling_hash: policyHash(ceiling),
      run_id: randomUUID(),
      run_expires_at: now + 3600_000,
      pop_key: pop.publicDer,
      issued_at: now,
      start_by: now + 30_000,
      max_runtime_ms: 600_000,
      limits: { max_bytes: null, concurrency: 4 },
      ...opts.ticket,
    });
    return {
      ticket: signEnvelope(
        SIGNED_KINDS.ticket,
        ticket,
        opts.ticketSigner ?? homeKey,
      ),
      proof: signProofOfPossession(
        opts.proofKey ?? pop,
        ticket.ticket_id,
        ticket.request_hash,
      ),
      request: opts.sendRequest ?? request,
      received_at: clocks.continuous(),
    };
  }

  const exec = (command: string, extra: Record<string, unknown> = {}) => ({
    command,
    cwd: null,
    timeout_ms: 10_000,
    stdin: null,
    ...extra,
  });

  function ok(reply: OperationReply) {
    if (!reply.ok) throw new Error(`refused: ${reply.refused.join("; ")}`);
    return reply;
  }

  describe("admission", () => {
    it("runs a valid exec and answers with its output", async () => {
      const reply = ok(
        await daemon.handle(
          message("exec", exec("echo hi; echo oops >&2; exit 3")),
        ),
      );
      expect(reply).toMatchObject({ state: "done", replayed: false });
      expect(reply.result).toMatchObject({
        exit_code: 3,
        stdout: "hi\n",
        stderr: "oops\n",
        timed_out: false,
        truncated: false,
      });
    });

    it.each([
      [
        "a ticket signed by a key that isn't the home bay's",
        { ticketSigner: projectBayKey },
        /not signed by this computer's home bay/,
      ],
      [
        "a ticket signed by a stranger",
        { ticketSigner: strangerKey },
        /not signed by this computer's home bay/,
      ],
      [
        "an attestation signed by the home bay instead of the project's bay",
        { attestationSigner: homeKey },
        /not signed by the project's bay/,
      ],
      [
        "a proof by another key (a copied ticket)",
        { proofKey: generateSigningKey() },
        /proof of possession/,
      ],
      [
        "a request changed after the ticket",
        { sendRequest: exec("rm -rf ~") },
        /does not match the ticket/,
      ],
      [
        "another computer's ticket",
        { ticket: { computer_id: randomUUID() } },
        /another computer/,
      ],
      [
        "a ticket for another key of this computer",
        { ticket: { computer_key: strangerKey.fingerprint } },
        /another key/,
      ],
      [
        "an expired start window",
        {
          ticket: {
            issued_at: Date.now() - 60_000,
            start_by: Date.now() - 1000,
          },
        },
        /start window passed/,
      ],
      [
        "an ineligible project",
        { attestation: { eligible: false } },
        /not eligible/,
      ],
      [
        "another effective policy",
        { ticket: { policy_epoch: 1 } },
        /another effective policy/,
      ],
    ])("refuses %s", async (_label, opts, reason) => {
      const marker = join(dir, "ran");
      const reply = await daemon.handle(
        message("exec", exec(`touch ${marker}`), opts as any),
      );
      expect(reply.ok).toBe(false);
      expect((reply as any).refused.join("; ")).toMatch(reason);
      expect(existsSync(marker)).toBe(false);
      expect(daemon.ledger.list()).toEqual([]);
    });

    it("refuses garbage without throwing", async () => {
      for (const garbage of [
        null,
        "x",
        { kid: 1 },
        { payload: {}, kid: "a", sig: "b" },
      ]) {
        const reply = await daemon.handle({
          ticket: garbage,
          proof: "x",
          request: {},
          received_at: clocks.continuous(),
        });
        expect(reply.ok).toBe(false);
      }
    });

    it("refuses tickets below the floors the hub pushed, and only raises floors", async () => {
      const floors = (computer_epoch: number, signer = homeKey) =>
        signEnvelope(
          SIGNED_KINDS.floors,
          parseComputerFloors({
            type: "cocalc-computer-floors",
            version: 1,
            computer_id,
            home_epoch: 0,
            computer_epoch,
            projects: { [project_id]: 2 },
            issued_at: Date.now(),
          }),
          signer,
        );
      expect(() => daemon.applyFloors(floors(5, strangerKey))).toThrow(
        /not signed by the home bay/,
      );
      expect(daemon.applyFloors(floors(5)).raised).toBe(true);
      // Replaying an older push changes nothing.
      expect(daemon.applyFloors(floors(1)).raised).toBe(false);
      const stale = await daemon.handle(
        message("exec", exec("true"), { ticket: { computer_epoch: 4 } }),
      );
      expect((stale as any).refused).toEqual(
        expect.arrayContaining([
          "computer epoch is stale",
          "project privacy epoch is stale",
        ]),
      );
      ok(
        await daemon.handle(
          message("exec", exec("true"), {
            ticket: { computer_epoch: 5 },
            attestation: { privacy_epoch: 2 },
          }),
        ),
      );
      // The floors survive a restart.
      expect(DaemonStore.open(join(dir, "state"))!.state.floors).toMatchObject({
        computer_epoch: 5,
        projects: { [project_id]: 2 },
      });
    });

    it("ends for good once its certificate has expired", () => {
      const t = { wall: Date.now(), continuous: 0 };
      clocks = { wall: () => t.wall, continuous: () => t.continuous };
      daemon = makeDaemon();
      daemon.tick();
      expect(daemon.sessionEnded).toBe(false);
      t.wall += 86_400_000 + 1000;
      t.continuous += 86_400_000 + 1000;
      daemon.tick();
      expect(daemon.sessionEnded).toBe(true);
    });

    const runJob = (command: string) => ({
      command,
      cwd: null,
      description: "test job",
      name: "test",
      exclusive: false,
      nice: false,
    });

    const stateEnvelope = (
      overrides: Record<string, unknown> = {},
      signer = homeKey,
    ) =>
      signEnvelope(
        SIGNED_KINDS.state,
        parseComputerState({
          type: "cocalc-computer-state",
          version: 1,
          computer_id,
          state_version: "1",
          home_epoch: 0,
          computer_epoch: 0,
          project_floors: {},
          policy_epoch: 0,
          policy: ceiling,
          ended: null,
          issued_at: Date.now(),
          ...overrides,
        }),
        signer,
      );

    it("parses state versions as canonical decimals only", () => {
      for (const bad of ["01", "-1", "+1", "1.0", "", "1e3", " 1"]) {
        expect(() => stateEnvelope({ state_version: bad })).toThrow(
          /canonical decimal/,
        );
      }
      expect(
        stateEnvelope({ state_version: "12345678901234567" }).payload
          .state_version,
      ).toBe("12345678901234567");
    });

    it("a signed state with ended stops everything, for good, across a restart", async () => {
      const started = ok(
        await daemon.handle(message("run", runJob("sleep 30"))),
      );
      const job_id = (started.result as any).job_id;
      expect(() =>
        daemon.applyState(
          stateEnvelope({ ended: { reason: "revoked" } }, strangerKey),
        ),
      ).toThrow(/not signed by the home bay/);
      expect(() =>
        daemon.applyState(
          stateEnvelope({
            computer_id: randomUUID(),
            ended: { reason: "revoked" },
          }),
        ),
      ).toThrow(/another computer/);
      // Another kind's signature over the same payload is refused.
      const env = stateEnvelope({ ended: { reason: "revoked" } });
      expect(() =>
        daemon.applyState(
          signEnvelope(SIGNED_KINDS.floors, env.payload, homeKey),
        ),
      ).toThrow();
      expect(daemon.sessionEnded).toBe(false);

      const ack = daemon.applyState(env);
      expect(ack.state_version).toBe("1");
      expect(ack.envelope_hash).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
      expect(daemon.sessionEnded).toBe(true);
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(job_id)?.state === "killed";
      });
      // A replay is harmless and acknowledged the same way.
      expect(daemon.applyState(env)).toEqual(ack);
      // After a restart the computer is still ended before anything else.
      daemon.endSession("test restart");
      const reopened = DaemonStore.open(join(dir, "state"))!;
      expect(reopened.ended).toEqual({ reason: "revoked" });
      store = reopened;
      daemon = makeDaemon();
      expect(daemon.sessionEnded).toBe(true);
      const reply = await daemon.handle(message("exec", exec("true")));
      expect((reply as any).refused).toEqual([
        "the session on this computer has ended",
      ]);
    });

    it("once ended, drain sees every job and exec gone, SIGKILL included, before the daemon may exit", async () => {
      // SIGTERM is ignored by the shell and (inherited) by its sleep.
      const stubborn = "trap '' TERM; sleep 30";
      const started = ok(await daemon.handle(message("run", runJob(stubborn))));
      const job_id = (started.result as any).job_id;
      const execDone = daemon.handle(message("exec", exec(stubborn)));
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(job_id)?.state === "running";
      });
      await new Promise((r) => setTimeout(r, 300));
      daemon.applyState(stateEnvelope({ ended: { reason: "revoked" } }));
      expect(await daemon.drain(10_000, 50)).toBe(true);
      expect(daemon.jobs.get(job_id)?.state).toBe("killed");
      expect(daemon.jobs.liveCount()).toBe(0);
      expect(daemon.cleanups.pending()).toEqual([]);
      await execDone;
    });

    it("a state's policy only narrows; a widening one is refused but its floors still apply", async () => {
      const narrower = {
        ...ceiling,
        duration: { initial_seconds: 3600, max_seconds: 7200 },
      };
      daemon.applyState(stateEnvelope({ policy_epoch: 1, policy: narrower }));
      expect(store.state.policy_epoch).toBe(1);
      expect(store.effectivePolicy.duration?.max_seconds).toBe(7200);
      // Not even back to the ceiling, but the raised floor is applied.
      expect(() =>
        daemon.applyState(
          stateEnvelope({
            state_version: "2",
            policy_epoch: 2,
            policy: ceiling,
            computer_epoch: 3,
          }),
        ),
      ).toThrow(/would widen/);
      expect(store.state.policy_epoch).toBe(1);
      expect(store.state.floors.computer_epoch).toBe(3);
      const old = await daemon.handle(message("exec", exec("true")));
      expect((old as any).refused).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/another effective policy/),
        ]),
      );
    });

    it("reconciles at start: a crash after the state write but before its side effects is repaired", async () => {
      const started = ok(
        await daemon.handle(message("run", runJob("sleep 30"))),
      );
      const job_id = (started.result as any).job_id;
      // The write happens, then the process dies before reconciling.
      store.applyState(
        stateEnvelope({ project_floors: { [project_id]: 5 } }),
        Date.now(),
      );
      daemon.jobs.refresh();
      expect(daemon.jobs.get(job_id)?.state).toBe("running");
      daemon.stop();
      // The next daemon reconciles before doing anything else.
      daemon = makeDaemon();
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(job_id)?.state === "killed";
      });
    });

    it("a running exec below its project's floor is stopped; one admitted above it keeps running", async () => {
      const t0 = Date.now();
      const below = daemon.handle(
        message("exec", exec("sleep 30"), {
          attestation: { privacy_epoch: 1 },
        }),
      );
      await new Promise((r) => setTimeout(r, 300));
      const snapshot = stateEnvelope({ project_floors: { [project_id]: 5 } });
      daemon.applyState(snapshot);
      await below;
      expect(Date.now() - t0).toBeLessThan(15_000);
      const above = daemon.handle(
        message("exec", exec("sleep 1; echo kept"), {
          attestation: { privacy_epoch: 5 },
        }),
      );
      await new Promise((r) => setTimeout(r, 200));
      // Replaying the older snapshot changes nothing for it.
      daemon.applyState(snapshot);
      const r = ok(await above);
      expect((r.result as any).stdout).toBe("kept\n");
    });

    it("refuses everything once the session has ended", async () => {
      const t = { wall: Date.now(), continuous: 0 };
      clocks = { wall: () => t.wall, continuous: () => t.continuous };
      daemon = makeDaemon({ deadline_ms: 60_000, max_ms: 60_000 });
      ok(await daemon.handle(message("exec", exec("true"))));
      t.wall += 60_000;
      t.continuous += 60_000;
      const reply = await daemon.handle(message("exec", exec("true")));
      expect((reply as any).refused).toEqual([
        "the session on this computer has ended",
      ]);
    });
  });

  describe("retries never repeat a side effect", () => {
    it("a lost answer plus a new ticket returns the recorded exec, output included", async () => {
      const operation_id = randomUUID();
      const counter = join(dir, "count");
      const cmd = exec(`echo x >> ${counter}; echo ran`);
      const first = ok(
        await daemon.handle(message("exec", cmd, { operation_id })),
      );
      const second = ok(
        await daemon.handle(message("exec", cmd, { operation_id })),
      );
      expect(second).toMatchObject({ replayed: true, state: "done" });
      expect(second.result).toMatchObject({ exit_code: 0, stdout: "ran\n" });
      expect(first.result).toMatchObject({ stdout: "ran\n" });
      expect(readFileSync(counter, "utf8")).toBe("x\n");
    });

    it("the same operation_id with another request is refused", async () => {
      const operation_id = randomUUID();
      ok(await daemon.handle(message("exec", exec("true"), { operation_id })));
      const reply = await daemon.handle(
        message("exec", exec("false"), { operation_id }),
      );
      expect((reply as any).refused).toEqual([
        "that operation_id was used for a different request",
      ]);
    });

    it("a run retried never starts a second job", async () => {
      const operation_id = randomUUID();
      const run = {
        command: "sleep 0.1",
        cwd: null,
        description: "a short job",
        name: "short",
        exclusive: false,
        nice: false,
      };
      const a = ok(await daemon.handle(message("run", run, { operation_id })));
      const b = ok(await daemon.handle(message("run", run, { operation_id })));
      expect((b.result as any).job_id).toBe((a.result as any).job_id);
      expect(daemon.jobs.list()).toHaveLength(1);
    });

    it("an exec in flight when the daemon stopped is unknown afterwards", async () => {
      const operation_id = randomUUID();
      daemon.ledger.begin({
        operation_id,
        operation: "exec",
        request_hash: requestHash(parseOperationRequest("exec", exec("true"))),
        ticket_id: randomUUID(),
        agent_id: agent,
        source_project_id: project_id,
      });
      daemon = makeDaemon(); // a restart
      const reply = ok(
        await daemon.handle(message("exec", exec("true"), { operation_id })),
      );
      expect(reply).toMatchObject({ replayed: true, state: "unknown" });
      expect(reply.error).toMatch(/stopped before/);
    });
  });

  describe("jobs", () => {
    const run = (command: string, extra: Record<string, unknown> = {}) => ({
      command,
      cwd: null,
      description: "test job",
      name: null,
      exclusive: false,
      nice: true,
      ...extra,
    });

    it("runs a job to its exit code, with logs and kill only for its own agent", async () => {
      const started = ok(
        await daemon.handle(message("run", run("echo one; echo two; exit 7"))),
      );
      const job_id = (started.result as any).job_id;
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(job_id)?.state === "exited";
      });
      expect(daemon.jobs.get(job_id)!.exit_code).toBe(7);

      const logs = ok(
        await daemon.handle(message("logs", { job_id, tail_lines: 1 })),
      );
      expect(logs.result).toEqual({ log: "two" });
      const theirs = ok(
        await daemon.handle(
          message("logs", { job_id, tail_lines: 10 }, { agent_id: otherAgent }),
        ),
      );
      expect(theirs).toMatchObject({
        state: "failed",
        error: "no such job of yours",
      });

      // Others see the command and description, but it isn't theirs.
      const listing = ok(
        await daemon.handle(message("jobs", {}, { agent_id: otherAgent })),
      );
      expect((listing.result as any).jobs).toEqual([
        expect.objectContaining({
          job_id,
          command: "echo one; echo two; exit 7",
          description: "test job",
          own: false,
        }),
      ]);
    });

    it("kills a job's whole process group", async () => {
      const started = ok(
        await daemon.handle(message("run", run("sleep 30 & sleep 30; wait"))),
      );
      const job_id = (started.result as any).job_id;
      const theirs = ok(
        await daemon.handle(
          message("kill", { job_id }, { agent_id: otherAgent }),
        ),
      );
      expect(theirs.state).toBe("failed");
      ok(await daemon.handle(message("kill", { job_id })));
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(job_id)?.state === "killed";
      });
      const pid = daemon.jobs.get(job_id)!.pid!;
      let groupAlive = true;
      await waitFor(() => {
        try {
          process.kill(-pid, 0);
        } catch {
          groupAlive = false;
        }
        return !groupAlive;
      });
      expect(groupAlive).toBe(false);
    });

    it("an exclusive job waits for running jobs, and later jobs wait for it", async () => {
      const gate = join(dir, "gate");
      const first = ok(
        await daemon.handle(
          message("run", run(`while [ ! -e ${gate} ]; do sleep 0.05; done`)),
        ),
      );
      const exclusive = ok(
        await daemon.handle(
          message("run", run("sleep 0.2", { exclusive: true })),
        ),
      );
      const later = ok(await daemon.handle(message("run", run("true"))));
      expect((exclusive.result as any).state).toBe("queued");
      expect((later.result as any).state).toBe("queued");
      const ids = [first, exclusive, later].map(
        (r) => (r.result as any).job_id,
      );
      require("node:fs").writeFileSync(gate, "");
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(ids[1])?.state === "running";
      });
      expect(daemon.jobs.get(ids[2])!.state).toBe("queued");
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(ids[2])?.state === "exited";
      });
    });

    it("a raised floor cancels queued jobs before they start", async () => {
      const gate = join(dir, "gate");
      ok(
        await daemon.handle(
          message("run", run(`while [ ! -e ${gate} ]; do sleep 0.05; done`)),
        ),
      );
      const queued = ok(
        await daemon.handle(
          message(
            "run",
            run(`touch ${join(dir, "started")}`, { exclusive: true }),
          ),
        ),
      );
      const { cancelled } = daemon.applyFloors(
        signEnvelope(
          SIGNED_KINDS.floors,
          parseComputerFloors({
            type: "cocalc-computer-floors",
            version: 1,
            computer_id,
            home_epoch: 0,
            computer_epoch: 1,
            projects: {},
            issued_at: Date.now(),
          }),
          homeKey,
        ),
      );
      expect(cancelled).toEqual([(queued.result as any).job_id]);
      require("node:fs").writeFileSync(gate, "");
      await new Promise((r) => setTimeout(r, 300));
      daemon.jobs.refresh();
      expect(existsSync(join(dir, "started"))).toBe(false);
    });

    it("a job that ends while the daemon is down keeps its exit code", async () => {
      const started = ok(
        await daemon.handle(message("run", run("sleep 0.3; exit 4"))),
      );
      const job_id = (started.result as any).job_id;
      await new Promise((r) => setTimeout(r, 800));
      daemon = makeDaemon(); // the daemon comes back
      expect(daemon.jobs.get(job_id)).toMatchObject({
        state: "exited",
        exit_code: 4,
      });
    });

    it("ending the session kills running jobs and cancels the queue", async () => {
      const started = ok(await daemon.handle(message("run", run("sleep 30"))));
      const job_id = (started.result as any).job_id;
      daemon.endSession("time limit reached");
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(job_id)?.state === "killed";
      });
    });
  });

  describe("exec limits", () => {
    it("times out and kills the command's process group", async () => {
      const reply = ok(
        await daemon.handle(
          message(
            "exec",
            exec("sleep 30 & echo started; wait", { timeout_ms: 1000 }),
          ),
        ),
      );
      expect(reply.result).toMatchObject({
        timed_out: true,
        stdout: "started\n",
      });
    });

    it("keeps stdin closed unless given", async () => {
      const closed = ok(
        await daemon.handle(message("exec", exec("cat; echo end"))),
      );
      expect((closed.result as any).stdout).toBe("end\n");
      const given = ok(
        await daemon.handle(
          message(
            "exec",
            exec("cat", { stdin: Buffer.from("in\n").toString("base64") }),
          ),
        ),
      );
      expect((given.result as any).stdout).toBe("in\n");
    });

    it("refuses a working directory that doesn't exist", async () => {
      const reply = ok(
        await daemon.handle(message("exec", exec("true", { cwd: "nope" }))),
      );
      expect(reply).toMatchObject({ state: "failed" });
      expect(reply.error).toMatch(/no such directory/);
    });
  });

  describe("pairing state", () => {
    it("refuses a certificate not signed by the home bay, or for another key or policy", () => {
      const create =
        (cert: unknown, extra: Record<string, unknown> = {}) =>
        () =>
          DaemonStore.create(join(dir, `s-${randomUUID()}`), {
            certificate: cert,
            ceiling,
            directory,
            computer_key: computerKey.fingerprint,
            agent_network_id,
            ...extra,
          });
      expect(create(certificate({}, projectBayKey))).toThrow(/home bay/);
      expect(create(certificate({}, strangerKey))).toThrow(/home bay/);
      expect(
        create(certificate(), { computer_key: strangerKey.fingerprint }),
      ).toThrow(/another key/);
      expect(
        create(certificate({ ceiling_hash: canonicalHash({ other: 1 }) })),
      ).toThrow(/another policy/);
      expect(
        create(certificate(), {
          directory: [{ ...directory[0], kid: strangerKey.fingerprint }],
        }),
      ).toThrow(/does not match its kid/);
    });

    it("never goes back to an older key directory", () => {
      expect(store.applyDirectory(2, directory)).toBe(true);
      expect(store.applyDirectory(1, directory.slice(0, 1))).toBe(false);
      expect(store.applyDirectory(2, directory.slice(0, 1))).toBe(false);
      const reopened = DaemonStore.open(join(dir, "state"))!;
      expect(
        reopened.trustedKey(projectBayKey.fingerprint, PROJECT_BAY, Date.now()),
      ).toBeDefined();
    });
  });

  describe("limits from the ticket and the session (review of #1035)", () => {
    const run = (command: string, extra: Record<string, unknown> = {}) => ({
      command,
      cwd: null,
      description: "test job",
      name: null,
      exclusive: false,
      nice: false,
      ...extra,
    });
    const floors = (computer_epoch: number, projects: Record<string, number>) =>
      signEnvelope(
        SIGNED_KINDS.floors,
        parseComputerFloors({
          type: "cocalc-computer-floors",
          version: 1,
          computer_id,
          home_epoch: 0,
          computer_epoch,
          projects,
          issued_at: Date.now(),
        }),
        homeKey,
      );

    it("an exec runs no longer than the ticket allows", async () => {
      const started = Date.now();
      const reply = ok(
        await daemon.handle(
          message("exec", exec("sleep 5", { timeout_ms: 60_000 }), {
            ticket: { max_runtime_ms: 400 },
          }),
        ),
      );
      expect(reply.result).toMatchObject({ timed_out: true });
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("an exec runs no longer than what is left of the session", async () => {
      daemon = makeDaemon({ deadline_ms: 600, max_ms: 600 });
      const reply = ok(
        await daemon.handle(
          message("exec", exec("sleep 5", { timeout_ms: 60_000 })),
        ),
      );
      expect(reply.result).toMatchObject({ timed_out: true });
    });

    it("a job's id is its run operation's id, and it stops at the ticket's limit", async () => {
      const operation_id = randomUUID();
      const reply = ok(
        await daemon.handle(
          message("run", run("sleep 30"), {
            operation_id,
            ticket: { max_runtime_ms: 300 },
          }),
        ),
      );
      expect((reply.result as any).job_id).toBe(operation_id);
      await waitFor(() => {
        daemon.jobs.refresh();
        return daemon.jobs.get(operation_id)?.state === "killed";
      });
      expect(daemon.jobs.get(operation_id)!.error).toMatch(/time limit/);
    });

    it("a project that stops being private loses its queued and running jobs; others keep theirs", async () => {
      const gate = join(dir, "gate");
      const otherProject = randomUUID();
      const blocker = ok(
        await daemon.handle(
          message("run", run(`while [ ! -e ${gate} ]; do sleep 0.05; done`), {
            attestation: { project_id: otherProject },
            ticket: { source_project_id: otherProject },
          }),
        ),
      );
      const mine = ok(await daemon.handle(message("run", run("sleep 30"))));
      const queued = ok(
        await daemon.handle(message("run", run("true", { exclusive: true }))),
      );
      expect((queued.result as any).state).toBe("queued");
      const { killed, cancelled } = daemon.applyFloors(
        floors(0, { [project_id]: 2 }),
      );
      expect(killed).toEqual([(mine.result as any).job_id]);
      expect(cancelled).toEqual([(queued.result as any).job_id]);
      daemon.jobs.refresh();
      expect(daemon.jobs.get((blocker.result as any).job_id)!.state).toBe(
        "running",
      );
      require("node:fs").writeFileSync(gate, "");
    });

    it("a raised computer epoch cancels queued work but lets running jobs finish", async () => {
      const gate = join(dir, "gate");
      const running = ok(
        await daemon.handle(
          message("run", run(`while [ ! -e ${gate} ]; do sleep 0.05; done`)),
        ),
      );
      const queued = ok(
        await daemon.handle(message("run", run("true", { exclusive: true }))),
      );
      const { cancelled, killed } = daemon.applyFloors(floors(3, {}));
      expect(cancelled).toEqual([(queued.result as any).job_id]);
      expect(killed).toEqual([]);
      require("node:fs").writeFileSync(gate, "");
      await waitFor(() => {
        daemon.jobs.refresh();
        return (
          daemon.jobs.get((running.result as any).job_id)?.state === "exited"
        );
      });
    });

    it("re-checks a queued job's authorization when it would start", async () => {
      const gate = join(dir, "gate");
      ok(
        await daemon.handle(
          message("run", run(`while [ ! -e ${gate} ]; do sleep 0.05; done`)),
        ),
      );
      const queued = ok(
        await daemon.handle(
          message(
            "run",
            run(`touch ${join(dir, "started")}`, { exclusive: true }),
            {
              ticket: { max_runtime_ms: 200 },
            },
          ),
        ),
      );
      // Its time limit passes while it waits.
      await new Promise((r) => setTimeout(r, 400));
      require("node:fs").writeFileSync(gate, "");
      await waitFor(() => {
        daemon.jobs.refresh();
        return (
          daemon.jobs.get((queued.result as any).job_id)?.state === "cancelled"
        );
      });
      expect(daemon.jobs.get((queued.result as any).job_id)!.error).toMatch(
        /time limit passed while it was queued/,
      );
      expect(existsSync(join(dir, "started"))).toBe(false);
    });

    it("caps a job's log on the machine without killing the job", async () => {
      const { JobManager } = await import("./jobs");
      const jobs = new JobManager(join(dir, "capped"), { logCapBytes: 100 });
      const job_id = randomUUID();
      jobs.submit({
        job_id,
        operation_id: job_id,
        agent_id: agent,
        source_project_id: project_id,
        name: null,
        description: "noisy",
        command: "head -c 100000 /dev/zero | tr '\\0' x; echo; exit 6",
        cwd: workdir,
        nice: false,
        exclusive: false,
        auth: {
          computer_epoch: 0,
          policy_epoch: 0,
          privacy_epoch: 1,
          deadline_at: null,
        },
      });
      await waitFor(() => {
        jobs.refresh();
        return jobs.get(job_id)?.state === "exited";
      });
      expect(jobs.get(job_id)!.exit_code).toBe(6);
      const log = readFileSync(
        join(dir, "capped", "jobs", job_id, "log"),
        "utf8",
      );
      expect(log.startsWith("x".repeat(100))).toBe(true);
      expect(log).toMatch(/log capped; 99901 more bytes not kept/);
      expect(log.length).toBeLessThan(200);
    });

    it("caps an exec's output files on the machine", async () => {
      const { runExec } = await import("./exec");
      const logDir = join(dir, "exec-capped");
      const r = await runExec(
        {
          command: "head -c 100000 /dev/zero | tr '\\0' y",
          cwd: null,
          timeout_ms: 10_000,
          stdin: null,
        },
        {
          workdir,
          logDir,
          shell: "/bin/bash",
          fileCapBytes: 1000,
          maxOutputBytes: 10,
        },
      );
      expect(r.stdout).toBe("y".repeat(10));
      expect(r.truncated).toBe(true);
      expect(readFileSync(join(logDir, "stdout"), "utf8")).toBe(
        "y".repeat(1000),
      );
    });

    it("refuses a flood before parsing it, and too many concurrent execs per agent", async () => {
      const garbage = () =>
        daemon.handle({
          ticket: null,
          proof: "x",
          request: {},
          received_at: clocks.continuous(),
        });
      const answers = await Promise.all(Array.from({ length: 120 }, garbage));
      expect(
        answers.filter(
          (a: any) => a.refused?.[0] === "this computer is busy; try again",
        ).length,
      ).toBeGreaterThan(0);
      // A fresh daemon (fresh buckets) for the concurrency part.
      daemon.endSession("next part");
      daemon = makeDaemon();
      const slow = Array.from({ length: 4 }, () =>
        daemon.handle(message("exec", exec("sleep 1"))),
      );
      await new Promise((r) => setTimeout(r, 200));
      const fifth = await daemon.handle(message("exec", exec("true")));
      expect((fifth as any).refused).toEqual([
        "too many operations running on this computer; try again",
      ]);
      // Another agent still gets one.
      ok(
        await daemon.handle(
          message("exec", exec("true"), { agent_id: otherAgent }),
        ),
      );
      for (const r of await Promise.all(slow)) ok(r);
    });
  });

  describe("enforcement (re-review of #1035)", () => {
    const run = (command: string, extra: Record<string, unknown> = {}) => ({
      command,
      cwd: null,
      description: "test job",
      name: null,
      exclusive: false,
      nice: false,
      ...extra,
    });
    const groupAlive = (pid: number) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it("a ticket's concurrency of 1 refuses a second exec or run while one runs", async () => {
      const one = { ticket: { limits: { max_bytes: null, concurrency: 1 } } };
      const first = daemon.handle(message("exec", exec("sleep 1"), one));
      await new Promise((r) => setTimeout(r, 200));
      for (const second of [
        message("exec", exec("true"), one),
        message("run", run("true"), one),
      ]) {
        expect(((await daemon.handle(second)) as any).refused).toEqual([
          "too many operations running on this computer; try again",
        ]);
      }
      ok(await first);
      ok(await daemon.handle(message("run", run("sleep 0.1"), one)));
    });

    it("runs hit the hard cap too, and a restarted daemon counts them again", async () => {
      const started = [];
      for (let i = 0; i < 4; i++) {
        started.push(ok(await daemon.handle(message("run", run("sleep 30")))));
      }
      const fifth = await daemon.handle(message("run", run("sleep 30")));
      expect((fifth as any).refused).toEqual([
        "too many operations running on this computer; try again",
      ]);
      daemon = makeDaemon(); // a restart: the jobs are still running
      const again = await daemon.handle(message("run", run("sleep 30")));
      expect((again as any).refused).toEqual([
        "too many operations running on this computer; try again",
      ]);
      // A retry of a known operation still gets its recorded answer.
      const known = started[0];
      const retry = await daemon.handle(
        message("run", run("sleep 30"), { operation_id: known.operation_id }),
      );
      expect(retry).toMatchObject({ ok: true, replayed: true });
    });

    it("a quiet daemon stops a job at its ticket limit and everything at the session's end", async () => {
      daemon.endSession("replace");
      daemon = makeDaemon({ deadline_ms: 1500, max_ms: 1500 });
      daemon.start(50);
      try {
        const short = ok(
          await daemon.handle(
            message("run", run("sleep 30"), {
              ticket: { max_runtime_ms: 300 },
            }),
          ),
        );
        const long = ok(await daemon.handle(message("run", run("sleep 30"))));
        const pid = (id: string) => daemon.jobs.get(id)!.pid!;
        const a = pid((short.result as any).job_id);
        const b = pid((long.result as any).job_id);
        // No more calls and no manual refresh: only the timer acts.
        await waitFor(() => !groupAlive(a), 5000);
        expect(groupAlive(b)).toBe(true);
        await waitFor(() => !groupAlive(b), 5000);
        expect(daemon.sessionEnded).toBe(true);
      } finally {
        daemon.stop();
      }
    });

    it("a job that ignores SIGTERM is SIGKILLed after the grace period, even across a restart", async () => {
      const { JobManager } = await import("./jobs");
      const first = new JobManager(join(dir, "stubborn"), {
        killGraceMs: 600_000,
      });
      const job_id = randomUUID();
      first.submit({
        job_id,
        operation_id: job_id,
        agent_id: agent,
        source_project_id: project_id,
        name: null,
        description: "stubborn",
        command: "trap '' TERM; while :; do sleep 0.1; done",
        cwd: workdir,
        nice: false,
        exclusive: false,
        auth: {
          computer_epoch: 0,
          policy_epoch: 0,
          privacy_epoch: 1,
          deadline_at: null,
        },
      });
      await new Promise((r) => setTimeout(r, 300));
      const pid = first.get(job_id)!.pid!;
      first.kill(job_id, agent);
      await new Promise((r) => setTimeout(r, 300));
      expect(groupAlive(pid)).toBe(true); // it ignored SIGTERM
      // The daemon restarts during the grace period.
      const second = new JobManager(join(dir, "stubborn"), {
        killGraceMs: 100,
      });
      await waitFor(() => {
        second.refresh();
        return second.get(job_id)?.state === "killed";
      });
      expect(groupAlive(pid)).toBe(false);
    });

    it("setting the wall clock back doesn't extend a job (this boot's clock still runs)", async () => {
      const { JobManager } = await import("./jobs");
      let since = 1_000_000;
      const jobs = new JobManager(join(dir, "clock"), {
        bootClock: { bootId: () => "boot-a", sinceBootMs: () => since },
      });
      const job = {
        auth: {
          computer_epoch: 0,
          policy_epoch: 0,
          privacy_epoch: 0,
          deadline_at: Date.now() + 60_000,
          boot_id: "boot-a",
          boot_deadline_ms: since + 60_000,
        },
      } as any;
      expect(jobs.deadlinePassed(job, Date.now())).toBe(false);
      since += 60_000; // an hour of wall time "un-happens"; the boot clock ran
      expect(jobs.deadlinePassed(job, Date.now() - 3_600_000)).toBe(true);
      // On another boot only the wall clock counts.
      job.auth.boot_id = "boot-b";
      expect(jobs.deadlinePassed(job, Date.now())).toBe(false);
    });

    it("the ledger also refuses an operation_id reused for another operation or project", () => {
      const operation_id = randomUUID();
      const base = {
        operation_id,
        operation: "exec" as const,
        request_hash: "sha256:x",
        ticket_id: randomUUID(),
        agent_id: agent,
        source_project_id: project_id,
      };
      daemon.ledger.begin(base);
      expect(() => daemon.ledger.begin({ ...base, operation: "run" })).toThrow(
        /different request/,
      );
      expect(() =>
        daemon.ledger.begin({ ...base, source_project_id: randomUUID() }),
      ).toThrow(/different request/);
    });
  });

  describe("housekeeping (re-review of #1035)", () => {
    it("a report that throws never changes an operation's outcome", async () => {
      daemon.endSession("replace");
      const hubClock = new HubClock(clocks);
      hubClock.observe(0);
      daemon = new ComputerDaemon({
        stateDir: dir,
        store,
        clocks,
        hubClock,
        session: new SessionClock(clocks, { deadline_ms: null, max_ms: null }),
        workdir,
        shell: "/bin/bash",
        report: () => {
          throw new Error("hub unreachable");
        },
      });
      const reply = ok(await daemon.handle(message("exec", exec("exit 2"))));
      expect(reply).toMatchObject({ state: "done" });
      expect(reply.result).toMatchObject({ exit_code: 2 });
    });

    it("prunes exec output with its ledger entry, and keeps exec output under its quota", async () => {
      const old = ok(await daemon.handle(message("exec", exec("echo old"))));
      const recent = ok(
        await daemon.handle(message("exec", exec("echo recent"))),
      );
      const root = join(dir, "exec");
      expect(existsSync(join(root, old.operation_id))).toBe(true);
      // Age the first one past retention.
      const entryPath = join(dir, "ledger", `${old.operation_id}.json`);
      const entry = JSON.parse(readFileSync(entryPath, "utf8"));
      entry.updated_at = Date.now() - 8 * 24 * 3600_000;
      require("node:fs").writeFileSync(entryPath, JSON.stringify(entry));
      daemon.prune();
      expect(existsSync(join(root, old.operation_id))).toBe(false);
      expect(existsSync(join(root, recent.operation_id))).toBe(true);
    });
  });

  describe("crash recovery (re-review of a0798222e4)", () => {
    it("an exec whose identity can't be read is never started", async () => {
      daemon.endSession("replace");
      const hubClock = new HubClock(clocks);
      hubClock.observe(0);
      daemon = new ComputerDaemon({
        stateDir: dir,
        store,
        clocks,
        hubClock,
        session: new SessionClock(clocks, { deadline_ms: null, max_ms: null }),
        workdir,
        shell: "/bin/bash",
        identify: () => undefined,
      });
      const marker = join(dir, "marker");
      const reply = ok(
        await daemon.handle(message("exec", exec(`touch ${marker}`))),
      );
      expect(reply).toMatchObject({ state: "failed" });
      expect(reply.error).toMatch(/not started/);
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(marker)).toBe(false);
    });

    it("an unknown exec without a cleanup record (a crash between the two writes) is stopped at the next start", async () => {
      const { spawn } = require("node:child_process");
      const child = spawn(
        "/bin/sh",
        ["-c", "trap '' TERM; while :; do sleep 0.1; done"],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      await new Promise((r) => setTimeout(r, 200));
      const { processStartTime } = await import("./launch");
      const operation_id = randomUUID();
      daemon.ledger.begin({
        operation_id,
        operation: "exec",
        request_hash: "sha256:x",
        ticket_id: randomUUID(),
        agent_id: agent,
        source_project_id: project_id,
      });
      daemon.ledger.update(operation_id, {
        state: "unknown",
        result: { pid: child.pid, pid_start: processStartTime(child.pid) },
      });
      expect(daemon.cleanups.pending()).toEqual([]);
      daemon = makeDaemon(); // restart
      expect(daemon.cleanups.pending().map((r) => r.id)).toEqual([
        operation_id,
      ]);
      await waitFor(() => {
        daemon.tick();
        return daemon.cleanups.pending().length === 0;
      });
      let alive = true;
      try {
        process.kill(-child.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    });
  });

  describe("output and identity (re-review of a0798222e4)", () => {
    it("a replay whose output was pruned says so", async () => {
      const operation_id = randomUUID();
      ok(
        await daemon.handle(message("exec", exec("echo hi"), { operation_id })),
      );
      rmSync(join(dir, "exec", operation_id), { recursive: true, force: true });
      const again = ok(
        await daemon.handle(message("exec", exec("echo hi"), { operation_id })),
      );
      expect(again).toMatchObject({ replayed: true });
      expect(again.result).toMatchObject({ output_pruned: true, stdout: "" });
    });

    const retained = () => {
      const root = join(dir, "exec");
      let total = 0;
      for (const id of readdirSync(root)) {
        for (const name of readdirSync(join(root, id))) {
          total += statSync(join(root, id, name)).size;
        }
      }
      return total;
    };

    it("keeps exec output under its quota as execs run, oldest first", async () => {
      daemon.endSession("replace");
      const hubClock = new HubClock(clocks);
      hubClock.observe(0);
      daemon = new ComputerDaemon({
        stateDir: dir,
        store,
        clocks,
        hubClock,
        session: new SessionClock(clocks, { deadline_ms: null, max_ms: null }),
        workdir,
        shell: "/bin/bash",
        execOutputQuotaBytes: 25_000,
      });
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = ok(
          await daemon.handle(
            message("exec", exec("head -c 10000 /dev/zero | tr '\\0' z")),
          ),
        );
        ids.push(r.operation_id);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const kept = ids.filter((id) => existsSync(join(dir, "exec", id)));
      // Pruned when each finished: within the quota once nothing runs.
      expect(kept).toEqual(ids.slice(2));
      expect(retained()).toBeLessThanOrEqual(25_000);
    });

    it("the exec output quota holds once concurrent execs finish (running output is the documented excess)", async () => {
      daemon.endSession("replace");
      const hubClock = new HubClock(clocks);
      hubClock.observe(0);
      daemon = new ComputerDaemon({
        stateDir: dir,
        store,
        clocks,
        hubClock,
        session: new SessionClock(clocks, { deadline_ms: null, max_ms: null }),
        workdir,
        shell: "/bin/bash",
        execOutputQuotaBytes: 25_000,
      });
      // All admitted while the directory is empty; each writes 10000 bytes.
      const replies = await Promise.all(
        [0, 1, 2, 3].map(() =>
          daemon.handle(
            message(
              "exec",
              exec("sleep 0.3; head -c 10000 /dev/zero | tr '\\0' z"),
            ),
          ),
        ),
      );
      replies.forEach((r) => ok(r));
      expect(retained()).toBeLessThanOrEqual(25_000);
    });

    it("on a platform without a durable identity, only the daemon that spawned a process may signal it", async () => {
      const {
        leaderAlive,
        processStartTime,
        setDurableIdentityForTesting,
        captureIdentity,
      } = await import("./launch");
      const { spawn } = require("node:child_process");
      const stranger = spawn("/bin/sh", ["-c", "sleep 30"], {
        detached: true,
        stdio: "ignore",
      });
      const ours = spawn("/bin/sh", ["-c", "sleep 30"], {
        detached: true,
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 200));
      const strangerStart = processStartTime(stranger.pid)!;
      const oursStart = captureIdentity(ours);
      try {
        setDurableIdentityForTesting(false);
        // A start time recorded elsewhere (a previous daemon): not trusted.
        expect(leaderAlive(stranger.pid, strangerStart)).toBe(false);
        // One this process captured when it spawned it: trusted.
        expect(leaderAlive(ours.pid, oursStart)).toBe(true);
        setDurableIdentityForTesting(true);
        expect(leaderAlive(stranger.pid, strangerStart)).toBe(true);
      } finally {
        setDurableIdentityForTesting(null);
        process.kill(-stranger.pid, "SIGKILL");
        process.kill(-ours.pid, "SIGKILL");
      }
    });

    it("on macOS-like identity, a reaped child's pid is never signalled even if a reused pid has the same lstart", async () => {
      const {
        leaderAlive,
        signalVerifiedGroup,
        setDurableIdentityForTesting,
        setIdentifyForTesting,
        captureIdentity,
      } = await import("./launch");
      const { spawn } = require("node:child_process");
      const child = spawn("/bin/sh", ["-c", "sleep 30"], {
        detached: true,
        stdio: "ignore",
      });
      const lstart = "Mon Oct 12 10:00:00 2026";
      try {
        setDurableIdentityForTesting(false);
        // Every pid "has" the same one-second lstart: the worst case.
        setIdentifyForTesting(() => lstart);
        expect(captureIdentity(child)).toBe(lstart);
        expect(leaderAlive(child.pid, lstart)).toBe(true);
        const exited = new Promise((r) => child.once("exit", r));
        process.kill(-child.pid, "SIGKILL");
        await exited;
        // The pid is free now; whoever gets it next must not be signalled.
        expect(leaderAlive(child.pid, lstart)).toBe(false);
        const kill = jest.spyOn(process, "kill");
        try {
          expect(signalVerifiedGroup(child.pid, lstart, "SIGTERM")).toBe(false);
          expect(kill).not.toHaveBeenCalledWith(-child.pid, expect.anything());
        } finally {
          kill.mockRestore();
        }
      } finally {
        setIdentifyForTesting(undefined);
        setDurableIdentityForTesting(null);
      }
    });

    (process.platform === "linux" ? it : it.skip)(
      "after a reboot, a process with the same pid and start tick is never signalled",
      async () => {
        const { processStartTime, setBootIdForTesting, captureIdentity } =
          await import("./launch");
        const { Cleanups } = await import("./cleanups");
        const { spawn } = require("node:child_process");
        const victim = spawn("/bin/sh", ["-c", "sleep 30"], {
          detached: true,
          stdio: "ignore",
        });
        const alive = () => {
          try {
            process.kill(victim.pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        try {
          await new Promise((r) => setTimeout(r, 100));
          const identity = captureIdentity(victim);
          const [, tick] = identity.split(":");
          // The identity includes this boot's id.
          expect(
            identity.startsWith(
              `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:`,
            ),
          ).toBe(true);
          const stateDir = mkdtempSync(join(tmpdir(), "cleanups-"));
          const cleanups = new Cleanups(stateDir, 0);
          // A record from an earlier boot (same pid, same tick) and one from
          // before boot ids were recorded (just the tick).
          const ids = [randomUUID(), randomUUID()];
          cleanups.add(ids[0], victim.pid, `previous-boot:${tick}`);
          cleanups.add(ids[1], victim.pid, tick);
          const kill = jest.spyOn(process, "kill");
          try {
            cleanups.drive();
            cleanups.drive(Date.now() + 60_000);
            expect(kill).not.toHaveBeenCalledWith(-victim.pid, "SIGTERM");
            expect(kill).not.toHaveBeenCalledWith(-victim.pid, "SIGKILL");
          } finally {
            kill.mockRestore();
          }
          expect(alive()).toBe(true);
          // Fail closed: both records are dropped, never re-driven.
          expect(cleanups.pending()).toEqual([]);
          // And if the boot id itself changes under the same pid and tick.
          const record = randomUUID();
          cleanups.add(record, victim.pid, identity);
          setBootIdForTesting("another-boot");
          expect(processStartTime(victim.pid)).toBe(`another-boot:${tick}`);
          cleanups.drive();
          expect(alive()).toBe(true);
          // An unreadable boot id: no identity at all.
          setBootIdForTesting(null);
          expect(processStartTime(victim.pid)).toBeUndefined();
        } finally {
          setBootIdForTesting(undefined);
          process.kill(-victim.pid, "SIGKILL");
        }
      },
    );
  });
});
