/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The C7 store (S6a r10 §2.2, §2.5, §2.6) with a stub projector: admission,
// replay, the terminal arbiter, pendingIncomplete, the lease CAS, the fence
// and objects, with injected faults at each transaction step.

import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  __clearPendingIncompleteForTests,
  __setC7FaultHook,
  admitInitial,
  decideClose,
  deleteC7TurnObjects,
  expireC7DerivedObjects,
  fenceC7Project,
  finalizeC7Lease,
  flushPendingIncomplete,
  getC7Winner,
  hasPendingIncomplete,
  heartbeatC7Lease,
  listC7QueueRows,
  markPendingIncomplete,
  readC7Log,
  readC7Object,
  replayRow,
  startC7LeaseAttempt,
  type C7Envelope,
  type C7Projector,
  type C7TurnContext,
} from "../../sqlite/c7-store";

const turn: C7TurnContext = {
  project_id: "project-c7",
  path: "work.chat",
  message_date: "2026-10-29T00:00:00.000Z",
  thread_id: "thread-c7",
  turn_id: "message-c7",
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
const projector: C7Projector = {
  validate: (_state, envelope: C7Envelope) =>
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
  return startC7LeaseAttempt({
    context,
    attempt_id,
    owner_instance_id: "worker-1",
    pid: 1,
    approver_account_id: "account-1",
  });
}

function log(): any[] {
  const out = readC7Log({
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
      `SELECT state, attempt_id, attempt_gen, c7_incomplete FROM acp_turns
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(turn.project_id, turn.path, turn.message_date);
}

function admit(attempt_id: string, body: unknown, origin = "source" as const) {
  return admitInitial({ turn, attempt_id, origin, body, projector });
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterEach(() => {
  __setC7FaultHook(undefined);
  __clearPendingIncompleteForTests();
  const db = getAcpDatabase();
  for (const table of [
    "acp_turns",
    "c7_input",
    "c7_queue",
    "c7_turn",
    "c7_close",
    "c7_thread",
    "c7_log",
    "c7_object",
    "c7_object_dep",
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
    expect(listC7QueueRows(turn)).toHaveLength(2);
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
      .prepare(`SELECT class FROM c7_input WHERE attempt_id = 'A'`)
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
    expect(getC7Winner(turn)).toMatchObject({
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
      __setC7FaultHook((p) => {
        if (p === point) throw Error("injected");
      });
      expect(admit("A", { x: 1 }).result).toBe("storage_failed");
      __setC7FaultHook(undefined);
      expect(listC7QueueRows(turn)).toHaveLength(0);
      expect(log()).toHaveLength(0);
      expect(hasPendingIncomplete(turn)).toBe(true);
    });
  }

  it("forces admission_failed at the writer's own close", () => {
    start("A");
    __setC7FaultHook((p) => {
      if (p === "admit:after-queue") throw Error("injected");
    });
    admit("A", { x: 1 });
    __setC7FaultHook(undefined);
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
    expect(lease().c7_incomplete).toBe(1);
  });

  it("keeps the pending entry when the durable write rolls back", () => {
    start("A");
    markPendingIncomplete(turn);
    __setC7FaultHook((p) => {
      if (p === "flush:before-commit") throw Error("injected");
    });
    expect(flushPendingIncomplete(turn)).toBe(false);
    expect(hasPendingIncomplete(turn)).toBe(true);
    expect(lease().c7_incomplete).toBe(0);
  });

  it("carries a pending flag through a later writer's cutover (the orphan path)", () => {
    start("A");
    markPendingIncomplete(turn);
    // A is gone (disposed); B starts in the same process
    start("B");
    expect(lease().c7_incomplete).toBe(1);
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
    __setC7FaultHook((p) => {
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
    for (const row of listC7QueueRows(turn)) {
      expect(replayRow({ turn, row, projector })).toEqual({
        result: "duplicate",
      });
    }
    expect(log()).toEqual(before);
  });

  for (const field of ["body", "time", "origin", "n"]) {
    it(`refuses a row whose ${field} changed (collision), before the winner`, () => {
      start("A");
      admit("A", { x: 1 });
      const [row] = listC7QueueRows(turn);
      const envelope = JSON.parse(row.envelope);
      if (field === "body") envelope.body = { x: 2 };
      if (field === "time") envelope.time += 1;
      if (field === "origin") envelope.origin = "local";
      if (field === "n") envelope.n = 5;
      const changed = { ...row, envelope: JSON.stringify(envelope) };
      expect(replayRow({ turn, row: changed, projector })).toMatchObject({
        result: "refused",
      });
      expect(getC7Winner(turn)).toMatchObject({ outcome: "error" });
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
    const winner = getC7Winner(turn);
    const [row] = listC7QueueRows(turn).filter((r) => r.kind === "in");
    const envelope = JSON.parse(row.envelope);
    envelope.body = { x: 99 };
    const changed = { ...row, envelope: JSON.stringify(envelope) };
    expect(replayRow({ turn, row: changed, projector }).result).toBe("refused");
    expect(replayRow({ turn, row: changed, projector }).result).toBe("refused");
    expect(log().filter((e) => e.type === "turn_invalidated")).toHaveLength(1);
    expect(getC7Winner(turn)).toEqual(winner);
  });

  it("refuses a row with no input record (gap)", () => {
    start("A");
    admit("A", { x: 1 });
    const [row] = listC7QueueRows(turn);
    const ghost = { ...row, n: 7 };
    expect(replayRow({ turn, row: ghost, projector })).toEqual({
      result: "refused",
      reason: "gap",
    });
  });

  it("refuses a changed row from a superseded attempt through the arbiter", () => {
    start("A");
    admit("A", { x: 1 });
    start("B");
    const [row] = listC7QueueRows(turn);
    const envelope = JSON.parse(row.envelope);
    envelope.body = { x: 2 };
    replayRow({
      turn,
      row: { ...row, envelope: JSON.stringify(envelope) },
      projector,
    });
    expect(getC7Winner(turn)).toMatchObject({
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
    const [close] = listC7QueueRows(turn).filter((r) => r.kind === "close");
    expect(replayRow({ turn, row: close, projector }).result).toBe("duplicate");
    const envelope = JSON.parse(close.envelope);
    envelope.candidate.F = "changed";
    expect(
      replayRow({
        turn,
        row: { ...close, envelope: JSON.stringify(envelope) },
        projector,
      }).result,
    ).toBe("refused");
    expect(getC7Winner(turn)).toMatchObject({ F: "done" });
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
    expect(getC7Winner(turn)).toBeUndefined();
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
    expect(getC7Winner(turn)).toEqual(first.winner);
  });
});

describe("the lease", () => {
  it("stops a stale writer's heartbeat", () => {
    const a = start("A");
    const b = start("B");
    const key = turn;
    expect(
      heartbeatC7Lease({
        key,
        owner_instance_id: "worker-1",
        attempt_id: "A",
        attempt_gen: a.attempt_gen,
        pid: 1,
      }),
    ).toBe(false);
    expect(
      heartbeatC7Lease({
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
    const result = finalizeC7Lease({
      turn,
      owner_instance_id: "worker-1",
      attempt_id: "A",
      attempt_gen: a.attempt_gen,
      state: "completed",
      projector,
    });
    expect(result).toEqual({ ended: false, stale: true, winner: null });
    expect(lease()).toMatchObject({ state: "running", attempt_id: "B" });
    expect(getC7Winner(turn)).toBeUndefined();
  });

  it("ends the lease with a winner, making one if needed", () => {
    const a = start("A");
    const result = finalizeC7Lease({
      turn,
      owner_instance_id: "worker-1",
      attempt_id: "A",
      attempt_gen: a.attempt_gen,
      state: "error",
      projector,
    });
    expect(result.ended).toBe(true);
    expect(result.winner).toMatchObject({ code: "lease_finalized" });
    expect(lease().state).toBe("error");
  });

  it("keeps the lease running when finalization fails", () => {
    const a = start("A");
    __setC7FaultHook((p) => {
      if (p === "finalize:before-update") throw Error("injected");
    });
    expect(() =>
      finalizeC7Lease({
        turn,
        owner_instance_id: "worker-1",
        attempt_id: "A",
        attempt_gen: a.attempt_gen,
        state: "completed",
        projector,
      }),
    ).toThrow("injected");
    __setC7FaultHook(undefined);
    expect(lease().state).toBe("running");
    expect(getC7Winner(turn)).toBeUndefined();
  });

  it("fences running leases with an aborted winner", () => {
    start("A");
    expect(
      fenceC7Project({
        project_id: turn.project_id,
        reason: "worker gone",
        projector,
      }),
    ).toBe(1);
    expect(lease().state).toBe("aborted");
    expect(getC7Winner(turn)).toMatchObject({
      outcome: "error",
      code: "aborted",
      attempt_id: "A",
    });
  });
});

describe("objects", () => {
  it("publishes an object with its event, and deletes it with its turn", () => {
    start("A");
    admit("A", { object: "tool_body" });
    const ids = getAcpDatabase()
      .prepare(`SELECT object_id FROM c7_object`)
      .all() as any[];
    expect(ids).toHaveLength(1);
    const thread = {
      project_id: turn.project_id,
      path: turn.path,
      thread_id: turn.thread_id,
    };
    expect(readC7Object(ids[0].object_id, thread)?.bytes).toBe(4);
    expect(
      readC7Object(ids[0].object_id, { ...thread, thread_id: "other" }),
    ).toBeUndefined();
    expect(deleteC7TurnObjects(turn)).toBe(1);
    expect(readC7Object(ids[0].object_id, thread)).toBeUndefined();
  });

  it("expires derived objects only", () => {
    start("A");
    admit("A", { object: "page" });
    admit("A", { object: "diff" });
    expect(expireC7DerivedObjects(Date.now() + 25 * 60 * 60 * 1000)).toBe(1);
    const left = getAcpDatabase()
      .prepare(`SELECT class FROM c7_object`)
      .all() as any[];
    expect(left.map((x) => x.class)).toEqual(["diff"]);
  });
});
