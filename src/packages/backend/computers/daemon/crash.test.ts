/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Crash points of applying a signed state, with real processes: a daemon
// process starts a job and a 50-minute exec, applies the state, and is
// SIGKILLed after the durable write, before each side effect, or before its
// ack; a new daemon process on the same state directory then reconciles and
// gets the same state again (the hub redelivers what was never acked).
// Everything that should stop is stopped, the job and the orphaned exec
// included; and replaying an older state never stops newer work.
// Design: src/.agents/computers-revocation-gate-2026-10-14.md (§1, §9).

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  parseComputerTicket,
  parseProjectAttestation,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import { parseOperationRequest } from "@cocalc/util/computers/operations";
import {
  canonicalHash,
  generateSigningKey,
  policyHash,
  requestHash,
  signEnvelope,
  signProofOfPossession,
} from "../crypto";
import { DaemonStore } from "./state";

jest.setTimeout(60_000);

const SITE = "https://cocalc.ai";
const CLUSTER = "standalone";
const HOME = "bay-0";
const PROJECT_BAY = "bay-1";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("crash points of applying a computer's state", () => {
  const homeKey = generateSigningKey();
  const projectBayKey = generateSigningKey();
  const computerKey = generateSigningKey();
  const account_id = randomUUID();
  const computer_id = randomUUID();
  const agent_network_id = randomUUID();
  const agent = randomUUID();
  const project_id = randomUUID();
  const ceiling = parseComputerPolicy({
    version: 1,
    mode: "direct",
    duration: null,
    agent_network_id,
    ...directPolicyDefaults(),
  });
  const directory = [HOME, PROJECT_BAY].map((bay_id) => {
    const key = bay_id === HOME ? homeKey : projectBayKey;
    return {
      kid: key.fingerprint,
      bay_id,
      public_key: key.publicDer,
      not_after: Date.now() + 86_400_000,
    };
  });
  let dir: string;
  const pids: number[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "computer-crash-"));
    mkdirSync(join(dir, "work"));
    const now = Date.now();
    DaemonStore.create(join(dir, "state"), {
      certificate: signEnvelope(
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
        }),
        homeKey,
      ),
      ceiling,
      directory,
      computer_key: computerKey.fingerprint,
      agent_network_id,
    });
  });

  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** A ticketed operation as the hub would send it (at this privacy epoch). */
  function message(
    operation: "exec" | "run",
    request: unknown,
    privacy_epoch = 1,
  ) {
    const now = Date.now();
    const op = parseOperationRequest(operation, request);
    const pop = generateSigningKey();
    const ticket = parseComputerTicket({
      type: "cocalc-computer-ticket",
      version: 1,
      ticket_id: randomUUID(),
      operation_id: randomUUID(),
      operation,
      request_hash: requestHash(op),
      site: SITE,
      cluster_id: CLUSTER,
      issuer_bay_id: HOME,
      home_epoch: 0,
      computer_id,
      computer_key: computerKey.fingerprint,
      account_id,
      agent_id: agent,
      agent_network_id,
      source_project_id: project_id,
      attestation: signEnvelope(
        SIGNED_KINDS.attestation,
        parseProjectAttestation({
          type: "cocalc-project-attestation",
          version: 1,
          site: SITE,
          cluster_id: CLUSTER,
          project_id,
          project_bay_id: PROJECT_BAY,
          eligible: true,
          privacy_epoch,
          account_id,
          home_bay_id: HOME,
          issued_at: now,
          not_after: now + 30_000,
        }),
        projectBayKey,
      ),
      computer_epoch: 0,
      policy_epoch: 0,
      ceiling_hash: policyHash(ceiling),
      run_id: randomUUID(),
      run_expires_at: now + 3_600_000,
      pop_key: pop.publicDer,
      issued_at: now,
      start_by: now + 30_000,
      max_runtime_ms: 3_000_000,
      limits: { max_bytes: null, concurrency: 4 },
    });
    return {
      ticket: signEnvelope(SIGNED_KINDS.ticket, ticket, homeKey),
      proof: signProofOfPossession(pop, ticket.ticket_id, ticket.request_hash),
      request,
    };
  }

  const state = (overrides: Record<string, unknown>) =>
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
      homeKey,
    );

  /** Run a daemon process; resolves with its exit and what it wrote. */
  function daemonProcess(config: Record<string, unknown>) {
    const configFile = join(dir, `config-${randomUUID()}.json`);
    const out = join(dir, `out-${randomUUID()}.json`);
    writeFileSync(configFile, JSON.stringify({ dir, out, ...config }));
    const child = spawn(
      process.execPath,
      [
        "-r",
        "ts-node/register",
        join(__dirname, "test", "crash-child.ts"),
        configFile,
      ],
      {
        cwd: join(__dirname, "..", ".."),
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    return new Promise<{
      signal: string | null;
      code: number | null;
      out: any;
    }>((resolve) =>
      child.on("exit", (code, signal) =>
        resolve({
          code,
          signal,
          out: existsSync(out)
            ? JSON.parse(readFileSync(out, "utf8"))
            : { stderr },
        }),
      ),
    );
  }

  /** A job and a 50-minute exec, both ignoring SIGTERM, recording pids. */
  function work(privacy_epoch = 1) {
    const pidFile = (what: string) => join(dir, `${what}.pid`);
    const body = (what: string) =>
      `trap '' TERM; echo $$ > ${pidFile(what)}; sleep 3000`;
    return {
      messages: [
        message(
          "run",
          {
            command: body("job"),
            cwd: null,
            description: "a long job",
            name: null,
            exclusive: false,
            nice: false,
          },
          privacy_epoch,
        ),
        message(
          "exec",
          { command: body("exec"), timeout_ms: 50 * 60_000 },
          privacy_epoch,
        ),
      ],
      pidFiles: [pidFile("job"), pidFile("exec")],
      pids: () => {
        const r = ["job", "exec"].map((w) =>
          Number(readFileSync(pidFile(w), "utf8")),
        );
        pids.push(...r);
        return r;
      },
    };
  }

  const cases: [string, Record<string, unknown>, string[]][] = [
    [
      "revoked",
      { ended: { reason: "revoked" } },
      ["state-saved", "side-effect#1", "side-effect#2", "before-ack"],
    ],
    [
      "its project's floor raised",
      { project_floors: { [project_id]: 2 } },
      ["state-saved", "side-effect#1", "side-effect#2", "before-ack"],
    ],
  ];
  for (const [what, overrides, points] of cases) {
    for (const crashAt of points) {
      it(`${what}: killed at ${crashAt}, a restart stops the job and the 50-minute exec`, async () => {
        const w = work();
        const envelope = state(overrides);
        const first = await daemonProcess({
          crashAt,
          messages: w.messages,
          pidFiles: w.pidFiles,
          state: envelope,
        });
        // It really died there, after the durable write.
        expect([first.signal, first.out]).toEqual([
          "SIGKILL",
          expect.anything(),
        ]);
        const saved = DaemonStore.open(join(dir, "state"))!;
        if (overrides.ended) {
          expect(saved.ended).toEqual({ reason: "revoked" });
        } else {
          expect(saved.state.floors.projects[project_id]).toBe(2);
        }
        const [job, exec] = w.pids();
        // Restart: reconcile at start, then the hub's redelivery (no ack
        // ever reached it).
        const second = await daemonProcess({ state: envelope });
        expect(second.code).toBe(0);
        expect(second.out.ack).toEqual({
          state_version: "1",
          envelope_hash: canonicalHash(envelope),
        });
        await until(() => !alive(job) && !alive(exec));
        if (overrides.ended) {
          expect(second.out.ended).toEqual({ reason: "revoked" });
        }
      });
    }
  }

  it("replaying an older state never stops work authorized above it", async () => {
    // The project's floor is 2; new work is authorized at 2.
    const floor = state({ project_floors: { [project_id]: 2 } });
    const applied = await daemonProcess({ state: floor });
    expect(applied.code).toBe(0);
    const w = work(2);
    const replay = await daemonProcess({
      messages: w.messages,
      pidFiles: w.pidFiles,
      state: floor,
      noDrain: true,
    });
    expect(replay.code).toBe(0);
    expect(replay.out.replies[0]).toMatchObject({ ok: true });
    const [job, exec] = w.pids();
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(job)).toBe(true);
    expect(alive(exec)).toBe(true);
  });
});
