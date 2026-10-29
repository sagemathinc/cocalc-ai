/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The ACP turn ledger with a stub projector: admission,
// replay, the terminal arbiter, pendingIncomplete, the lease CAS, the fence
// and objects, with injected faults at each transaction step.

import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  fenceAcpTurnLeasesForProject,
  startAcpTurnLease,
} from "../../sqlite/acp-turns";
import {
  __clearPendingIncompleteForTests,
  __getAcpLedgerMutationForTests,
  __setAcpLedgerFaultHook,
  __setAcpLedgerMutationForTests,
  admitInitial,
  decideClose,
  deleteAcpLedgerTurnObjects,
  expireAcpLedgerDerivedObjects,
  fenceAcpLedgerProject,
  finalizeAcpLedgerLease,
  flushPendingIncomplete,
  getAcpLedgerWinner,
  hasPendingIncomplete,
  heartbeatAcpLedgerLease,
  listAcpLedgerQueueRows,
  markPendingIncomplete,
  readAcpLedgerLog,
  readAcpLedgerObject,
  replayRow,
  startAcpLedgerLeaseAttempt,
  type AcpLedgerEnvelope,
  type AcpLedgerProjector,
  type AcpLedgerTurnContext,
} from "../../sqlite/acp-turn-ledger";

const turn: AcpLedgerTurnContext = {
  project_id: "project-ledger",
  path: "work.chat",
  message_date: "2026-10-29T00:00:00.000Z",
  thread_id: "thread-ledger",
  turn_id: "message-ledger",
};

const context = {
  project_id: turn.project_id,
  path: turn.path,
  message_date: turn.message_date,
  message_id: turn.turn_id,
  thread_id: turn.thread_id,
  sender_id: "agent-sender",
} as any;

// A stub projector: one event per live input, one per winner and one per
// invalidation. Its state counts live inputs.
const projector: AcpLedgerProjector = {
  validate: (_state, envelope: AcpLedgerEnvelope) =>
    (envelope.body as any)?.malformed ? "malformed" : "ok",
  input: (state, envelope, ctx) => ({
    state: { count: ((state as any)?.count ?? 0) + 1 },
    events: [
      {
        type: "echo",
        n: envelope.n,
        origin: envelope.origin,
        cutover: ctx.cutover,
      },
    ],
    objects: (envelope.body as any)?.object
      ? [
          {
            object_id: ctx.newObjectId(),
            class: (envelope.body as any).object,
            body: new TextEncoder().encode("body"),
            deps: [ctx.turn.message_date],
          },
        ]
      : [],
  }),
  close: (state, winner) => ({
    state,
    events: [
      {
        type: "turn_finished",
        outcome: winner.outcome,
        code: winner.code ?? null,
      },
    ],
    objects: [],
  }),
  invalidate: (state, code) => ({
    state,
    events: [{ type: "turn_invalidated", code }],
    objects: [],
  }),
};

function start(attempt_id: string) {
  return startAcpLedgerLeaseAttempt({
    context,
    attempt_id,
    owner_instance_id: "worker-1",
    pid: 1,
    approver_account_id: "account-1",
  });
}

function log(): any[] {
  const out = readAcpLedgerLog({
    project_id: turn.project_id,
    path: turn.path,
    thread_id: turn.thread_id,
    after_seq: 0,
    max_events: 10_000,
    max_bytes: 10_000_000,
  });
  if ("reset" in out) throw Error("unexpected reset");
  return out.events;
}

function lease(): any {
  return getAcpDatabase()
    .prepare(
      `SELECT state, attempt_id, attempt_gen, ledger_incomplete FROM acp_turns
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(turn.project_id, turn.path, turn.message_date);
}

// Every ledger row and the lease, for whole-state rollback assertions.
function tables(): Record<string, unknown[]> {
  const db = getAcpDatabase();
  const out: Record<string, unknown[]> = {};
  for (const table of [
    "acp_turns",
    "acp_ledger_input",
    "acp_ledger_queue",
    "acp_ledger_turn",
    "acp_ledger_close",
    "acp_ledger_thread",
    "acp_ledger_log",
    "acp_ledger_object",
    "acp_ledger_object_dep",
  ]) {
    out[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  // the lease's heartbeat time changes with time alone
  out.acp_turns = (out.acp_turns as any[]).map((row) => {
    const copy = { ...row };
    delete copy.heartbeat_at;
    return copy;
  });
  return out;
}

function admit(attempt_id: string, body: unknown, origin = "source" as const) {
  return admitInitial({ turn, attempt_id, origin, body, projector });
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterEach(() => {
  __setAcpLedgerFaultHook(undefined);
  __clearPendingIncompleteForTests();
  const db = getAcpDatabase();
  for (const table of [
    "acp_turns",
    "acp_ledger_input",
    "acp_ledger_queue",
    "acp_ledger_turn",
    "acp_ledger_close",
    "acp_ledger_thread",
    "acp_ledger_log",
    "acp_ledger_object",
    "acp_ledger_object_dep",
  ]) {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // the table may not exist yet in the first test
    }
  }
});

afterAll(() => {
  closeAcpDatabase();
});

describe("admission", () => {
  it("assigns consecutive ordinals and seqs, and never confuses a resend with a duplicate", () => {
    start("A");
    const first = admit("A", { type: "event", text: "hi" });
    const second = admit("A", { type: "event", text: "hi" });
    expect(first.result).toBe("admitted");
    expect(second.result).toBe("admitted");
    if (first.result !== "admitted" || second.result !== "admitted") return;
    expect([first.envelope.n, second.envelope.n]).toEqual([0, 1]);
    expect(log().map((e) => e.seq)).toEqual([1, 2]);
    expect(
      log().every((e) => e.v === "1.0" && e.turn_id === turn.turn_id),
    ).toBe(true);
    expect(listAcpLedgerQueueRows(turn)).toHaveLength(2);
  });

  it("shares one ordinal sequence between source and local inputs", () => {
    start("A");
    admit("A", { a: 1 });
    admit("A", { b: 1 }, "local" as any);
    admit("A", { c: 1 });
    expect(log().map((e) => [e.n, e.origin])).toEqual([
      [0, "source"],
      [1, "local"],
      [2, "source"],
    ]);
  });

  it("refuses an input from a superseded attempt, and records it", () => {
    start("A");
    start("B");
    const result = admit("A", { x: 1 });
    expect(result).toMatchObject({ result: "refused", reason: "stale" });
    expect(log()).toHaveLength(0);
    const row = getAcpDatabase()
      .prepare(`SELECT class FROM acp_ledger_input WHERE attempt_id = 'A'`)
      .get() as any;
    expect(row.class).toBe("stale");
  });

  it("marks the first admitted input after a cutover", () => {
    start("A");
    admit("A", { x: 1 });
    start("B");
    admit("B", { x: 2 });
    admit("B", { x: 3 });
    expect(log().map((e) => e.cutover)).toEqual([true, true, false]);
  });

  it("refuses input after the winner as late, with no event", () => {
    start("A");
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    expect(admit("A", { x: 1 })).toMatchObject({
      result: "refused",
      reason: "late",
    });
    expect(log().map((e) => e.type)).toEqual(["turn_finished"]);
  });

  it("fails a malformed input closed through the arbiter", () => {
    start("A");
    expect(admit("A", { malformed: true })).toMatchObject({
      result: "refused",
      reason: "malformed",
    });
    expect(getAcpLedgerWinner(turn)).toMatchObject({
      outcome: "error",
      code: "source_malformed",
    });
  });

  it("refuses with no attempt when there is no lease", () => {
    expect(admit("A", { x: 1 })).toMatchObject({
      result: "refused",
      reason: "no_attempt",
    });
  });
});

describe("storage failure", () => {
  for (const point of [
    "admit:after-record",
    "admit:after-queue",
    "admit:before-commit",
  ]) {
    it(`writes nothing and sets pendingIncomplete (fault at ${point})`, () => {
      start("A");
      __setAcpLedgerFaultHook((p) => {
        if (p === point) throw Error("injected");
      });
      expect(admit("A", { x: 1 }).result).toBe("storage_failed");
      __setAcpLedgerFaultHook(undefined);
      expect(listAcpLedgerQueueRows(turn)).toHaveLength(0);
      expect(log()).toHaveLength(0);
      expect(hasPendingIncomplete(turn)).toBe(true);
    });
  }

  it("forces admission_failed at the writer's own close", () => {
    start("A");
    __setAcpLedgerFaultHook((p) => {
      if (p === "admit:after-queue") throw Error("injected");
    });
    admit("A", { x: 1 });
    __setAcpLedgerFaultHook(undefined);
    const result = decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    expect(result.role).toBe("winner");
    expect(result.winner).toMatchObject({
      outcome: "error",
      code: "admission_failed",
    });
    // the durable write committed first, so the entry is gone
    expect(hasPendingIncomplete(turn)).toBe(false);
    expect(lease().ledger_incomplete).toBe(1);
  });

  it("keeps the pending entry when the durable write rolls back", () => {
    start("A");
    markPendingIncomplete(turn);
    __setAcpLedgerFaultHook((p) => {
      if (p === "flush:before-commit") throw Error("injected");
    });
    expect(flushPendingIncomplete(turn)).toBe(false);
    expect(hasPendingIncomplete(turn)).toBe(true);
    expect(lease().ledger_incomplete).toBe(0);
  });

  it("carries a pending flag through a later writer's cutover (the orphan path)", () => {
    start("A");
    markPendingIncomplete(turn);
    // A is gone (disposed); B starts in the same process
    start("B");
    expect(lease().ledger_incomplete).toBe(1);
    expect(hasPendingIncomplete(turn)).toBe(false);
    const result = decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "B",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    expect(result.winner).toMatchObject({ code: "admission_failed" });
  });

  it("keeps the pending flag and fails the cutover if its write rolls back", () => {
    start("A");
    markPendingIncomplete(turn);
    __setAcpLedgerFaultHook((p) => {
      if (p === "cutover:before-commit") throw Error("injected");
    });
    expect(() => start("B")).toThrow("injected");
    expect(hasPendingIncomplete(turn)).toBe(true);
    expect(lease().attempt_id).toBe("A");
  });
});

describe("replay", () => {
  it("finds every stored row a duplicate, and changes nothing", () => {
    start("A");
    admit("A", { x: 1 });
    admit("A", { x: 2 });
    const before = log();
    const tablesBefore = tables();
    for (const row of listAcpLedgerQueueRows(turn)) {
      expect(replayRow({ turn, row, projector })).toMatchObject({
        result: "duplicate",
        kind: "in",
        class: "live",
        process: true,
      });
    }
    expect(log()).toEqual(before);
    expect(tables()).toEqual(tablesBefore);
  });

  for (const field of ["body", "time", "origin", "n"]) {
    it(`refuses a row whose ${field} changed (collision), before the winner`, () => {
      start("A");
      admit("A", { x: 1 });
      const [row] = listAcpLedgerQueueRows(turn);
      const envelope = JSON.parse(row.envelope);
      if (field === "body") envelope.body = { x: 2 };
      if (field === "time") envelope.time += 1;
      if (field === "origin") envelope.origin = "local";
      if (field === "n") envelope.n = 5;
      const changed = { ...row, envelope: JSON.stringify(envelope) };
      expect(replayRow({ turn, row: changed, projector })).toMatchObject({
        result: "refused",
      });
      expect(getAcpLedgerWinner(turn)).toMatchObject({ outcome: "error" });
    });
  }

  it("invalidates once after the winner, and keeps the winner", () => {
    start("A");
    admit("A", { x: 1 });
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    const winner = getAcpLedgerWinner(turn);
    const [row] = listAcpLedgerQueueRows(turn).filter((r) => r.kind === "in");
    const envelope = JSON.parse(row.envelope);
    envelope.body = { x: 99 };
    const changed = { ...row, envelope: JSON.stringify(envelope) };
    expect(replayRow({ turn, row: changed, projector }).result).toBe("refused");
    expect(replayRow({ turn, row: changed, projector }).result).toBe("refused");
    expect(log().filter((e) => e.type === "turn_invalidated")).toHaveLength(1);
    expect(getAcpLedgerWinner(turn)).toEqual(winner);
  });

  it("refuses a row with no input record (gap)", () => {
    start("A");
    admit("A", { x: 1 });
    const [row] = listAcpLedgerQueueRows(turn);
    const ghost = { ...row, n: 7 };
    expect(replayRow({ turn, row: ghost, projector })).toEqual({
      result: "refused",
      reason: "gap",
      integrity: true,
    });
  });

  it("refuses a changed row from a superseded attempt through the arbiter", () => {
    start("A");
    admit("A", { x: 1 });
    start("B");
    const [row] = listAcpLedgerQueueRows(turn);
    const envelope = JSON.parse(row.envelope);
    envelope.body = { x: 2 };
    replayRow({
      turn,
      row: { ...row, envelope: JSON.stringify(envelope) },
      projector,
    });
    expect(getAcpLedgerWinner(turn)).toMatchObject({
      outcome: "error",
      code: "source_conflict",
      attempt_id: "B",
      cause: { attempt_id: "A" },
    });
  });

  it("validates a stored close row exactly (replay-close)", () => {
    start("A");
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    const [close] = listAcpLedgerQueueRows(turn).filter(
      (r) => r.kind === "close",
    );
    expect(replayRow({ turn, row: close, projector })).toMatchObject({
      result: "duplicate",
      kind: "close",
      process: false,
    });
    const envelope = JSON.parse(close.envelope);
    envelope.candidate.F = "changed";
    expect(
      replayRow({
        turn,
        row: { ...close, envelope: JSON.stringify(envelope) },
        projector,
      }).result,
    ).toBe("refused");
    expect(getAcpLedgerWinner(turn)).toMatchObject({ F: "done" });
    expect(log().filter((e) => e.type === "turn_invalidated")).toHaveLength(1);
  });
});

describe("the terminal winner", () => {
  it("makes a later candidate a loser, whatever it says", () => {
    start("A");
    const first = decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "one" },
      projector,
    });
    for (const candidate of [
      { outcome: "interrupted" as const },
      { outcome: "completed" as const, F: "two" },
      { outcome: "error" as const, code: "x" },
    ]) {
      const later = decideClose({
        turn,
        caller: "ordinary",
        attempt_id: "A",
        candidate,
        projector,
      });
      expect(later).toEqual({ role: "loser", winner: first.winner });
    }
    expect(log().filter((e) => e.type === "turn_finished")).toHaveLength(1);
    expect(log().filter((e) => e.type === "turn_invalidated")).toHaveLength(0);
  });

  it("gives a stale ordinary caller no winner", () => {
    start("A");
    start("B");
    expect(
      decideClose({
        turn,
        caller: "ordinary",
        attempt_id: "A",
        candidate: { outcome: "completed", F: "x" },
        projector,
      }),
    ).toEqual({ role: "stale", winner: null });
    expect(getAcpLedgerWinner(turn)).toBeUndefined();
  });

  it("lets a later writer adopt the existing winner", () => {
    start("A");
    const first = decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "one" },
      projector,
    });
    start("B");
    expect(
      decideClose({
        turn,
        caller: "ordinary",
        attempt_id: "B",
        candidate: { outcome: "completed", F: "two" },
        projector,
      }),
    ).toEqual({ role: "loser", winner: first.winner });
  });

  it("ignores a failed admission after the winner", () => {
    start("A");
    const first = decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "one" },
      projector,
    });
    markPendingIncomplete(turn);
    // a later decision and finalization still adopt the winner
    expect(
      decideClose({
        turn,
        caller: "ordinary",
        attempt_id: "A",
        candidate: { outcome: "completed", F: "two" },
        projector,
      }),
    ).toEqual({ role: "loser", winner: first.winner });
    const a = lease();
    expect(
      finalizeAcpLedgerLease({
        turn,
        owner_instance_id: "worker-1",
        attempt_id: "A",
        attempt_gen: a.attempt_gen,
        projector,
      }),
    ).toMatchObject({ ended: true, state: "completed", winner: first.winner });
  });
});

describe("the lease", () => {
  it("stops a stale writer's heartbeat", () => {
    const a = start("A");
    const b = start("B");
    const key = turn;
    expect(
      heartbeatAcpLedgerLease({
        key,
        owner_instance_id: "worker-1",
        attempt_id: "A",
        attempt_gen: a.attempt_gen,
        pid: 1,
      }),
    ).toBe(false);
    expect(
      heartbeatAcpLedgerLease({
        key,
        owner_instance_id: "worker-1",
        attempt_id: "B",
        attempt_gen: b.attempt_gen,
        pid: 1,
      }),
    ).toBe(true);
  });

  it("never lets a stale writer end the current lease", () => {
    const a = start("A");
    start("B");
    const result = finalizeAcpLedgerLease({
      turn,
      owner_instance_id: "worker-1",
      attempt_id: "A",
      attempt_gen: a.attempt_gen,
      projector,
    });
    expect(result).toEqual({ ended: false, stale: true, winner: null });
    expect(lease()).toMatchObject({ state: "running", attempt_id: "B" });
    expect(getAcpLedgerWinner(turn)).toBeUndefined();
  });

  it("ends the lease with a winner, making one if needed", () => {
    const a = start("A");
    const result = finalizeAcpLedgerLease({
      turn,
      owner_instance_id: "worker-1",
      attempt_id: "A",
      attempt_gen: a.attempt_gen,
      projector,
    });
    expect(result.ended).toBe(true);
    expect(result.winner).toMatchObject({ code: "lease_finalized" });
    expect(lease().state).toBe("error");
  });

  it("keeps the lease running when finalization fails", () => {
    const a = start("A");
    __setAcpLedgerFaultHook((p) => {
      if (p === "finalize:before-update") throw Error("injected");
    });
    expect(() =>
      finalizeAcpLedgerLease({
        turn,
        owner_instance_id: "worker-1",
        attempt_id: "A",
        attempt_gen: a.attempt_gen,
        projector,
      }),
    ).toThrow("injected");
    __setAcpLedgerFaultHook(undefined);
    expect(lease().state).toBe("running");
    expect(getAcpLedgerWinner(turn)).toBeUndefined();
  });

  it("fences running leases with an aborted winner", () => {
    start("A");
    expect(
      fenceAcpLedgerProject({
        project_id: turn.project_id,
        reason: "worker gone",
        projector,
      }),
    ).toBe(1);
    expect(lease().state).toBe("aborted");
    expect(getAcpLedgerWinner(turn)).toMatchObject({
      outcome: "error",
      code: "aborted",
      attempt_id: "A",
    });
  });
});

describe("the fence and turns it didn't decide", () => {
  // A second turn in the same project, for leases written by the legacy
  // lease API only.
  const legacy = {
    project_id: turn.project_id,
    path: "other.chat",
    message_date: "2026-10-29T00:00:01.000Z",
  };

  function legacyLease(identity: { message_id?: string; thread_id?: string }) {
    startAcpTurnLease({
      context: { ...legacy, ...identity } as any,
      owner_instance_id: "worker-1",
      pid: 1,
      approver_account_id: "account-1",
    });
  }

  function legacyState(): string | undefined {
    return (
      getAcpDatabase()
        .prepare(
          `SELECT state FROM acp_turns
           WHERE project_id = ? AND path = ? AND message_date = ?`,
        )
        .get(legacy.project_id, legacy.path, legacy.message_date) as any
    )?.state;
  }

  it("keeps a completed winner's state when the worker died before finalizing", () => {
    start("A");
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    expect(lease().state).toBe("running");
    expect(
      fenceAcpLedgerProject({
        project_id: turn.project_id,
        reason: "worker gone",
        projector,
      }),
    ).toBe(1);
    expect(lease().state).toBe("completed");
    expect(getAcpLedgerWinner(turn)).toMatchObject({
      outcome: "completed",
      F: "done",
    });
    expect(log().filter((e) => e.type === "turn_finished")).toHaveLength(1);
  });

  it("keeps an error winner's state", () => {
    start("A");
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "error", code: "provider_error" },
      projector,
    });
    fenceAcpLedgerProject({
      project_id: turn.project_id,
      reason: "worker gone",
      projector,
    });
    expect(lease().state).toBe("error");
    expect(getAcpLedgerWinner(turn)).toMatchObject({ code: "provider_error" });
  });

  it("leaves running leases it can't decide for the legacy fence", () => {
    legacyLease({});
    expect(
      fenceAcpLedgerProject({
        project_id: turn.project_id,
        reason: "worker gone",
        projector,
      }),
    ).toBe(0);
    expect(legacyState()).toBe("running");
    legacyLease({ message_id: "m-legacy", thread_id: "t-legacy" });
    expect(
      fenceAcpLedgerProject({
        project_id: turn.project_id,
        reason: "worker gone",
        projector,
      }),
    ).toBe(0);
    expect(legacyState()).toBe("running");
    expect(
      getAcpDatabase()
        .prepare(`SELECT COUNT(*) AS c FROM acp_ledger_close`)
        .get(),
    ).toMatchObject({ c: 0 });
    expect(
      getAcpDatabase()
        .prepare(`SELECT COUNT(*) AS c FROM acp_ledger_log`)
        .get(),
    ).toMatchObject({ c: 0 });
  });

  it("ends only its own turns in a mixed project; the legacy fence ends the rest", () => {
    start("A");
    legacyLease({});
    expect(
      fenceAcpLedgerProject({
        project_id: turn.project_id,
        reason: "worker gone",
        projector,
      }),
    ).toBe(1);
    expect(lease().state).toBe("aborted");
    expect(getAcpLedgerWinner(turn)).toMatchObject({ code: "aborted" });
    expect(legacyState()).toBe("running");
    expect(
      fenceAcpTurnLeasesForProject({
        project_id: turn.project_id,
        reason: "worker gone",
      }),
    ).toBe(1);
    expect(legacyState()).toBe("aborted");
    expect(lease().state).toBe("aborted");
  });
});

describe("objects", () => {
  it("publishes an object with its event, and deleteAcpLedgerTurnObjects removes it and its dependency rows", () => {
    start("A");
    admit("A", { object: "tool_body" });
    const ids = getAcpDatabase()
      .prepare(`SELECT object_id FROM acp_ledger_object`)
      .all() as any[];
    expect(ids).toHaveLength(1);
    const thread = {
      project_id: turn.project_id,
      path: turn.path,
      thread_id: turn.thread_id,
    };
    expect(readAcpLedgerObject(ids[0].object_id, thread)?.bytes).toBe(4);
    expect(
      readAcpLedgerObject(ids[0].object_id, { ...thread, thread_id: "other" }),
    ).toBeUndefined();
    expect(deleteAcpLedgerTurnObjects(turn)).toBe(1);
    expect(readAcpLedgerObject(ids[0].object_id, thread)).toBeUndefined();
    expect(
      getAcpDatabase()
        .prepare(`SELECT COUNT(*) AS c FROM acp_ledger_object_dep`)
        .get(),
    ).toMatchObject({ c: 0 });
  });

  it("expires derived objects only", () => {
    start("A");
    admit("A", { object: "page" });
    admit("A", { object: "diff" });
    expect(
      expireAcpLedgerDerivedObjects(Date.now() + 25 * 60 * 60 * 1000),
    ).toBe(1);
    const left = getAcpDatabase()
      .prepare(`SELECT class FROM acp_ledger_object`)
      .all() as any[];
    expect(left.map((x) => x.class)).toEqual(["diff"]);
  });
});

describe("replay eligibility, order and identity", () => {
  it("never makes a stale, late or malformed row processable on replay", () => {
    start("A");
    start("B");
    admit("A", { x: "stale" });
    admit("B", { malformed: true });
    admit("B", { x: "late" });
    const rows = listAcpLedgerQueueRows(turn).filter((r) => r.kind === "in");
    expect(rows).toHaveLength(3);
    // never "duplicate": each stays refused with its class, and nothing else
    // happens (the turn's winner is the malformed refusal, unchanged)
    const winner = getAcpLedgerWinner(turn);
    expect(rows.map((row) => replayRow({ turn, row, projector }))).toEqual([
      { result: "refused", reason: "stale", integrity: false },
      { result: "refused", reason: "malformed", integrity: false },
      { result: "refused", reason: "late", integrity: false },
    ]);
    expect(getAcpLedgerWinner(turn)).toEqual(winner);
    expect(log().filter((e) => e.type === "turn_invalidated")).toHaveLength(0);
  });

  it("returns the queue in commit order, inputs and closes merged", () => {
    start("A");
    admit("A", { x: 1 });
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    admit("A", { x: 2 });
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "interrupted" },
      projector,
    });
    const rows = listAcpLedgerQueueRows(turn);
    expect(rows.map((r) => r.kind)).toEqual(["in", "close", "in", "close"]);
    expect(rows.map((r) => r.qseq)).toEqual([1, 2, 3, 4]);
  });

  it("refuses a stored row that doesn't parse, as a collision", () => {
    start("A");
    admit("A", { x: 1 });
    const [row] = listAcpLedgerQueueRows(turn);
    expect(
      replayRow({ turn, row: { ...row, envelope: "{not json" }, projector }),
    ).toEqual({ result: "refused", reason: "collision", integrity: true });
    expect(
      replayRow({ turn, row: { ...row, envelope: "null" }, projector }),
    ).toEqual({ result: "refused", reason: "collision", integrity: true });
    expect(getAcpLedgerWinner(turn)).toMatchObject({ code: "source_conflict" });
  });

  it("includes attempt_gen in the identity", () => {
    start("A");
    admit("A", { x: 1 });
    const [row] = listAcpLedgerQueueRows(turn);
    const envelope = JSON.parse(row.envelope);
    envelope.attempt_gen += 1;
    expect(
      replayRow({
        turn,
        row: { ...row, envelope: JSON.stringify(envelope) },
        projector,
      }).result,
    ).toBe("refused");
    expect(
      replayRow({
        turn,
        row: { ...row, attempt_gen: row.attempt_gen + 1 },
        projector,
      }).result,
    ).toBe("refused");
  });
});

describe("the owned body snapshot", () => {
  it("queues, projects and returns copies, never the caller's object", () => {
    start("A");
    const body: any = { type: "event", nested: { text: "one" } };
    const result = admit("A", body);
    if (result.result !== "admitted") throw Error("not admitted");
    body.nested.text = "changed";
    expect(result.envelope.body).not.toBe(body);
    expect((result.envelope.body as any).nested.text).toBe("one");
    const [row] = listAcpLedgerQueueRows(turn);
    expect(JSON.parse(row.envelope).body.nested.text).toBe("one");
    expect(replayRow({ turn, row, projector }).result).toBe("duplicate");
  });

  it("treats a body with no canonical JSON as a storage failure", () => {
    start("A");
    // a sparse array has no JSON form
    const holey: unknown[] = [];
    holey[1] = 1;
    expect(admit("A", { list: holey }).result).toBe("storage_failed");
    expect(admit("A", { n: Number.NaN }).result).toBe("storage_failed");
    expect(listAcpLedgerQueueRows(turn)).toHaveLength(0);
    expect(hasPendingIncomplete(turn)).toBe(true);
  });
});

describe("the pending flag needs a real lease row", () => {
  it("keeps the entry when there is no lease row, and the next cutover inherits it", () => {
    markPendingIncomplete(turn);
    expect(flushPendingIncomplete(turn)).toBe(false);
    expect(hasPendingIncomplete(turn)).toBe(true);
    start("A");
    expect(lease().ledger_incomplete).toBe(1);
    expect(hasPendingIncomplete(turn)).toBe(false);
  });
});

describe("finalization", () => {
  it("does nothing for the wrong owner", () => {
    const a = start("A");
    const result = finalizeAcpLedgerLease({
      turn,
      owner_instance_id: "someone-else",
      attempt_id: "A",
      attempt_gen: a.attempt_gen,
      projector,
    });
    expect(result).toEqual({ ended: false, stale: true, winner: null });
    expect(getAcpLedgerWinner(turn)).toBeUndefined();
    expect(lease().state).toBe("running");
  });

  it("does nothing once the lease is terminal", () => {
    start("A");
    fenceAcpLedgerProject({
      project_id: turn.project_id,
      reason: "x",
      projector,
    });
    const after = lease();
    const result = finalizeAcpLedgerLease({
      turn,
      owner_instance_id: "worker-1",
      attempt_id: "A",
      attempt_gen: after.attempt_gen,
      projector,
    });
    expect(result.ended).toBe(false);
    expect(lease().state).toBe("aborted");
  });

  it("sets the lease state from the winner", () => {
    const a = start("A");
    __setAcpLedgerFaultHook((p) => {
      if (p === "admit:after-queue") throw Error("injected");
    });
    admit("A", { x: 1 });
    __setAcpLedgerFaultHook(undefined);
    const result = finalizeAcpLedgerLease({
      turn,
      owner_instance_id: "worker-1",
      attempt_id: "A",
      attempt_gen: a.attempt_gen,
      projector,
    });
    expect(result).toMatchObject({ ended: true, state: "error" });
    expect(result.winner).toMatchObject({ code: "admission_failed" });
    expect(lease().state).toBe("error");
  });

  it("maps a completed winner to a completed lease", () => {
    const a = start("A");
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    expect(
      finalizeAcpLedgerLease({
        turn,
        owner_instance_id: "worker-1",
        attempt_id: "A",
        attempt_gen: a.attempt_gen,
        projector,
      }),
    ).toMatchObject({ ended: true, state: "completed" });
  });
});

describe("more fault points", () => {
  it("leaves no winner and no close row when decide-close fails", () => {
    start("A");
    __setAcpLedgerFaultHook((p) => {
      if (p === "decide:before-commit") throw Error("injected");
    });
    expect(() =>
      decideClose({
        turn,
        caller: "ordinary",
        attempt_id: "A",
        candidate: { outcome: "completed", F: "x" },
        projector,
      }),
    ).toThrow("injected");
    __setAcpLedgerFaultHook(undefined);
    expect(getAcpLedgerWinner(turn)).toBeUndefined();
    expect(listAcpLedgerQueueRows(turn)).toHaveLength(0);
    expect(log()).toHaveLength(0);
  });

  it("aborts nothing and decides nothing when the fence fails", () => {
    start("A");
    __setAcpLedgerFaultHook((p) => {
      if (p === "fence:after-decide") throw Error("injected");
    });
    expect(() =>
      fenceAcpLedgerProject({
        project_id: turn.project_id,
        reason: "x",
        projector,
      }),
    ).toThrow("injected");
    __setAcpLedgerFaultHook(undefined);
    expect(lease().state).toBe("running");
    expect(getAcpLedgerWinner(turn)).toBeUndefined();
  });

  it("rolls back an object and its dependency rows with the input", () => {
    start("A");
    __setAcpLedgerFaultHook((p) => {
      if (p === "projection:after-object") throw Error("injected");
    });
    expect(admit("A", { object: "tool_body" }).result).toBe("storage_failed");
    __setAcpLedgerFaultHook(undefined);
    const db = getAcpDatabase();
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM acp_ledger_object`).get(),
    ).toMatchObject({ c: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM acp_ledger_object_dep`).get(),
    ).toMatchObject({ c: 0 });
  });

  it("writes nothing when the commit itself is refused", () => {
    start("A");
    __setAcpLedgerFaultHook((p) => {
      if (p === "tx:before-commit") throw Error("injected");
    });
    expect(admit("A", { x: 1 }).result).toBe("storage_failed");
    __setAcpLedgerFaultHook(undefined);
    expect(listAcpLedgerQueueRows(turn)).toHaveLength(0);
    expect(log()).toHaveLength(0);
  });
});

describe("derived objects at read time", () => {
  it("refuses an expired page or reset at read time, before any sweep", () => {
    start("A");
    admit("A", { object: "page" });
    admit("A", { object: "tool_body" });
    const db = getAcpDatabase();
    const rows = db
      .prepare(`SELECT object_id, class FROM acp_ledger_object`)
      .all() as any[];
    const thread = {
      project_id: turn.project_id,
      path: turn.path,
      thread_id: turn.thread_id,
    };
    const later = Date.now() + 24 * 60 * 60 * 1000 + 1;
    for (const row of rows) {
      const read = readAcpLedgerObject(row.object_id, thread, later);
      if (row.class === "page") expect(read).toBeUndefined();
      else expect(read?.bytes).toBe(4);
    }
  });

  it("sweeps in batches", () => {
    start("A");
    for (let i = 0; i < 450; i++) admit("A", { object: "reset", i });
    let batches = 0;
    const sizes: number[] = [];
    __setAcpLedgerFaultHook((p) => {
      if (p === "expire:batch") batches += 1;
      if (p.startsWith("expire:deleted:")) sizes.push(Number(p.slice(15)));
    });
    expect(
      expireAcpLedgerDerivedObjects(Date.now() + 25 * 60 * 60 * 1000),
    ).toBe(450);
    __setAcpLedgerFaultHook(undefined);
    // 200 + 200 + 50, each in its own short transaction
    expect(batches).toBe(3);
    expect(sizes).toEqual([200, 200, 50]);
  });

  it("finds expired derived objects through the (class, created_at) index", () => {
    start("A");
    const plan = getAcpDatabase()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT object_id FROM acp_ledger_object
         WHERE class IN ('page', 'reset') AND created_at <= ? LIMIT 200`,
      )
      .all(0) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "acp_ledger_object_class_created_idx",
    );
  });
});

describe("whole-state rollback and retry", () => {
  for (const point of [
    "admit:after-record",
    "admit:after-queue",
    "projection:after-object",
    "projection:after-event",
    "admit:before-commit",
    "tx:before-commit",
  ]) {
    it(`leaves every table as it was (fault at ${point}), and a retry has no hole`, () => {
      start("A");
      admit("A", { x: 0 });
      const before = tables();
      __setAcpLedgerFaultHook((p) => {
        if (p === point) throw Error("injected");
      });
      expect(admit("A", { object: "tool_body" }).result).toBe("storage_failed");
      __setAcpLedgerFaultHook(undefined);
      expect(tables()).toEqual(before);
      __clearPendingIncompleteForTests();
      const retry = admit("A", { x: 1 });
      expect(retry).toMatchObject({ result: "admitted", envelope: { n: 1 } });
      expect(log().map((e) => e.seq)).toEqual([1, 2]);
    });
  }

  it("reports a real BEGIN failure as a storage failure", () => {
    start("A");
    const db = getAcpDatabase();
    db.exec("BEGIN");
    try {
      expect(admit("A", { x: 1 }).result).toBe("storage_failed");
    } finally {
      db.exec("ROLLBACK");
    }
    expect(hasPendingIncomplete(turn)).toBe(true);
    expect(listAcpLedgerQueueRows(turn)).toHaveLength(0);
  });

  it("sets the pending flag on a genuine storage failure during replay", () => {
    start("A");
    admit("A", { x: 1 });
    const [row] = listAcpLedgerQueueRows(turn);
    __setAcpLedgerFaultHook((p) => {
      if (p === "tx:before-commit") throw Error("injected");
    });
    expect(replayRow({ turn, row, projector }).result).toBe("storage_failed");
    __setAcpLedgerFaultHook(undefined);
    expect(hasPendingIncomplete(turn)).toBe(true);
  });

  it("rolls back an invalidation that fails, and a retry invalidates once", () => {
    start("A");
    admit("A", { x: 1 });
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    const [row] = listAcpLedgerQueueRows(turn).filter((r) => r.kind === "in");
    const envelope = JSON.parse(row.envelope);
    envelope.body = { x: 2 };
    const changed = { ...row, envelope: JSON.stringify(envelope) };
    const before = tables();
    __setAcpLedgerFaultHook((p) => {
      if (p === "projection:after-event") throw Error("injected");
    });
    expect(replayRow({ turn, row: changed, projector }).result).toBe(
      "storage_failed",
    );
    __setAcpLedgerFaultHook(undefined);
    expect(tables()).toEqual(before);
    expect(replayRow({ turn, row: changed, projector }).result).toBe("refused");
    expect(log().filter((e) => e.type === "turn_invalidated")).toHaveLength(1);
  });
});

describe("projector exceptions", () => {
  const throwing = (hook: keyof AcpLedgerProjector): AcpLedgerProjector => ({
    ...projector,
    [hook]: () => {
      throw Error(`projector ${hook} failed`);
    },
  });

  for (const hook of ["validate", "input"] as const) {
    it(`rolls back an admission whose projector ${hook} throws`, () => {
      start("A");
      const before = tables();
      expect(
        admitInitial({
          turn,
          attempt_id: "A",
          origin: "source",
          body: { x: 1 },
          projector: throwing(hook),
        }).result,
      ).toBe("storage_failed");
      expect(tables()).toEqual(before);
    });
  }

  it("rolls back a decision whose projector close throws", () => {
    start("A");
    const before = tables();
    expect(() =>
      decideClose({
        turn,
        caller: "ordinary",
        attempt_id: "A",
        candidate: { outcome: "completed", F: "x" },
        projector: throwing("close"),
      }),
    ).toThrow("projector close failed");
    expect(tables()).toEqual(before);
    expect(getAcpLedgerWinner(turn)).toBeUndefined();
  });

  it("rolls back a refusal whose projector invalidate throws", () => {
    start("A");
    admit("A", { x: 1 });
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    const [row] = listAcpLedgerQueueRows(turn).filter((r) => r.kind === "in");
    const before = tables();
    expect(
      replayRow({
        turn,
        row: { ...row, envelope: "{}" },
        projector: throwing("invalidate"),
      }).result,
    ).toBe("storage_failed");
    expect(tables()).toEqual(before);
  });
});

describe("commit order is bound to the input record", () => {
  it("refuses a row whose qseq was changed", () => {
    start("A");
    admit("A", { x: 1 });
    admit("A", { x: 2 });
    const [row] = listAcpLedgerQueueRows(turn);
    expect(replayRow({ turn, row: { ...row, qseq: 9 }, projector })).toEqual({
      result: "refused",
      reason: "collision",
      integrity: true,
    });
  });

  it("refuses two rows whose qseqs were swapped, after the winner too", () => {
    start("A");
    admit("A", { x: 1 });
    admit("A", { x: 2 });
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "A",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    const [first, second] = listAcpLedgerQueueRows(turn);
    const swapped = [
      { ...first, qseq: second.qseq },
      { ...second, qseq: first.qseq },
    ];
    for (const row of swapped) {
      expect(replayRow({ turn, row, projector })).toMatchObject({
        result: "refused",
        integrity: true,
      });
    }
    expect(log().filter((e) => e.type === "turn_invalidated")).toHaveLength(1);
  });

  it("refuses a row that claims another row's position (a duplicate qseq)", () => {
    start("A");
    admit("A", { x: 1 });
    admit("A", { x: 2 });
    const [first, second] = listAcpLedgerQueueRows(turn);
    expect(
      replayRow({ turn, row: { ...second, qseq: first.qseq }, projector }),
    ).toMatchObject({ result: "refused", integrity: true });
    expect(getAcpLedgerWinner(turn)).toMatchObject({ code: "source_conflict" });
  });

  it("replays every row of a restart in its committed order as a duplicate", () => {
    start("A");
    admit("A", { x: 1 });
    start("B");
    admit("B", { x: 2 });
    decideClose({
      turn,
      caller: "ordinary",
      attempt_id: "B",
      candidate: { outcome: "completed", F: "done" },
      projector,
    });
    const rows = listAcpLedgerQueueRows(turn);
    expect(rows.map((r) => r.qseq)).toEqual([1, 2, 3]);
    expect(
      rows.map((row) => replayRow({ turn, row, projector }).result),
    ).toEqual(["duplicate", "duplicate", "duplicate"]);
  });
});

describe("a real COMMIT failure", () => {
  // A deferred foreign key, on the same connection, that the hook violates
  // inside the transaction: SQLite then refuses the COMMIT itself.
  function withDeferredViolation(run: () => void): void {
    const db = getAcpDatabase();
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      `CREATE TABLE IF NOT EXISTS acp_ledger_test_parent (id INTEGER PRIMARY KEY)`,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS acp_ledger_test_child (
      parent INTEGER REFERENCES acp_ledger_test_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
    __setAcpLedgerFaultHook((p) => {
      if (p === "tx:before-commit") {
        db.prepare(
          `INSERT INTO acp_ledger_test_child (parent) VALUES (999)`,
        ).run();
      }
    });
    try {
      run();
    } finally {
      __setAcpLedgerFaultHook(undefined);
      db.exec("DELETE FROM acp_ledger_test_child");
      db.exec("PRAGMA foreign_keys = OFF");
    }
  }

  it("rolls back an admission whose COMMIT SQLite refuses, sets pending, and a retry works", () => {
    start("A");
    admit("A", { x: 0 });
    const before = tables();
    let reached = false;
    let outcome: any;
    withDeferredViolation(() => {
      const hook = (p: string) => {
        if (p === "tx:before-commit") {
          getAcpDatabase()
            .prepare(`INSERT INTO acp_ledger_test_child (parent) VALUES (999)`)
            .run();
          reached = true;
        }
      };
      __setAcpLedgerFaultHook(hook);
      outcome = admit("A", { object: "tool_body" });
      // the violating child row was rolled back with everything else
      expect(
        getAcpDatabase()
          .prepare(`SELECT COUNT(*) AS c FROM acp_ledger_test_child`)
          .get(),
      ).toMatchObject({ c: 0 });
    });
    // the body finished, and it was COMMIT itself that SQLite refused
    expect(reached).toBe(true);
    expect(outcome.result).toBe("storage_failed");
    expect(String(outcome.error)).toMatch(/FOREIGN KEY/i);
    expect(tables()).toEqual(before);
    expect(hasPendingIncomplete(turn)).toBe(true);
    __clearPendingIncompleteForTests();
    expect(admit("A", { x: 1 })).toMatchObject({
      result: "admitted",
      envelope: { n: 1 },
    });
    expect(log().map((e) => e.seq)).toEqual([1, 2]);
  });

  it("takes the same handler for a failure at the COMMIT call itself", () => {
    start("A");
    const before = tables();
    __setAcpLedgerFaultHook((p) => {
      if (p === "tx:commit") throw Error("injected at COMMIT");
    });
    expect(admit("A", { x: 1 }).result).toBe("storage_failed");
    __setAcpLedgerFaultHook(undefined);
    expect(tables()).toEqual(before);
    // and the connection is usable: the failed transaction was rolled back
    expect(admit("A", { x: 2 }).result).toBe("admitted");
  });
});

describe("mutating validators and projectors can't change what was admitted", () => {
  it("keeps the queued bytes, the hash and the returned body", () => {
    start("A");
    const mutating: AcpLedgerProjector = {
      ...projector,
      validate: (state, envelope) => {
        (envelope.body as any).nested.text = "validator";
        return projector.validate(state, envelope);
      },
      input: (state, envelope, ctx) => {
        expect((envelope.body as any).nested.text).toBe("one");
        (envelope.body as any).nested.text = "projector";
        return projector.input(state, envelope, ctx);
      },
    };
    const result = admitInitial({
      turn,
      attempt_id: "A",
      origin: "source",
      body: { nested: { text: "one" } },
      projector: mutating,
    });
    if (result.result !== "admitted") throw Error("not admitted");
    expect((result.envelope.body as any).nested.text).toBe("one");
    const [row] = listAcpLedgerQueueRows(turn);
    expect(JSON.parse(row.envelope).body.nested.text).toBe("one");
    expect(replayRow({ turn, row, projector })).toMatchObject({
      result: "duplicate",
      process: true,
    });
  });
});

describe("the 24-hour boundary, exactly", () => {
  const T0 = 5_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  for (const klass of ["page", "reset"] as const) {
    it(`reads a ${klass} just before 24 hours, and not at or after it`, () => {
      start("A");
      admitInitial({
        turn,
        attempt_id: "A",
        origin: "source",
        body: { object: klass },
        projector,
        now: T0,
      });
      const [row] = getAcpDatabase()
        .prepare(`SELECT object_id, created_at FROM acp_ledger_object`)
        .all() as any[];
      expect(row.created_at).toBe(T0);
      const thread = {
        project_id: turn.project_id,
        path: turn.path,
        thread_id: turn.thread_id,
      };
      expect(
        readAcpLedgerObject(row.object_id, thread, T0 + DAY - 1)?.bytes,
      ).toBe(4);
      expect(
        readAcpLedgerObject(row.object_id, thread, T0 + DAY),
      ).toBeUndefined();
      expect(
        readAcpLedgerObject(row.object_id, thread, T0 + DAY + 1),
      ).toBeUndefined();
      // the sweep agrees with the read at the same instant
      expect(expireAcpLedgerDerivedObjects(T0 + DAY - 1)).toBe(0);
      expect(expireAcpLedgerDerivedObjects(T0 + DAY)).toBe(1);
    });
  }
});

describe("the COMMIT-catch control detects its mutant", () => {
  it("has the mutation switch off by default", () => {
    expect(__getAcpLedgerMutationForTests()).toBeUndefined();
  });

  it("is set by nothing outside the tests", () => {
    // every non-test source file under lite/hub
    const hub = join(__dirname, "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") {
            walk(path);
          }
        } else if (
          /\.tsx?$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name)
        ) {
          files.push(path);
        }
      }
    };
    walk(hub);
    const uses = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes("__setAcpLedgerMutationForTests"))
        .map((line) => `${file}: ${line.trim()}`),
    );
    // only its own definition, in acp-turn-ledger.ts
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(
      /acp-turn-ledger\.ts: export function __setAcpLedgerMutationForTests\(/,
    );
  });

  it("fails the deferred-FK COMMIT control when the COMMIT catch skips its ROLLBACK", () => {
    start("A");
    admit("A", { x: 0 });
    const db = getAcpDatabase();
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      `CREATE TABLE IF NOT EXISTS acp_ledger_test_parent (id INTEGER PRIMARY KEY)`,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS acp_ledger_test_child (
      parent INTEGER REFERENCES acp_ledger_test_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
    let failed: any;
    let retry: any;
    let childRows: any;
    try {
      __setAcpLedgerMutationForTests("skip-commit-rollback");
      __setAcpLedgerFaultHook((p) => {
        if (p === "tx:before-commit") {
          db.prepare(
            `INSERT INTO acp_ledger_test_child (parent) VALUES (999)`,
          ).run();
        }
      });
      failed = admit("A", { x: 1 });
      __setAcpLedgerFaultHook(undefined);
      // the deliberately leaked transaction is still open, so what the real
      // control asserts no longer holds
      childRows = db
        .prepare(`SELECT COUNT(*) AS c FROM acp_ledger_test_child`)
        .get();
      retry = admit("A", { x: 2 });
    } finally {
      __setAcpLedgerFaultHook(undefined);
      __setAcpLedgerMutationForTests(undefined);
      try {
        db.exec("ROLLBACK"); // unwind the leaked transaction
      } catch {
        // already gone
      }
      db.exec("DELETE FROM acp_ledger_test_child");
      db.exec("PRAGMA foreign_keys = OFF");
      __clearPendingIncompleteForTests();
    }
    expect(failed.result).toBe("storage_failed");
    expect(String(failed.error)).toMatch(/FOREIGN KEY/i);
    // the control detects the mutant: the child row survived, and the retry
    // couldn't even begin
    expect(childRows).toMatchObject({ c: 1 });
    expect(retry.result).toBe("storage_failed");
    expect(String(retry.error)).toMatch(/within a transaction/i);
    // and after the finally, the store works again
    expect(admit("A", { x: 3 }).result).toBe("admitted");
  });
});
