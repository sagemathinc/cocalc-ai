import {
  BOARD_ADMISSION,
  BoardAdmission,
  type CommitResult,
  HostAdmission,
  type Outcome,
  TokenBucket,
  editWorkMs,
} from "./admission";

const KiB = 1024;

// The tests' clock: the faked Date, which advances with the fake timers.
const testClock = () => Date.now();
const newHost = (limits = BOARD_ADMISSION) =>
  new HostAdmission({ limits, now: testClock });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
});

afterEach(() => {
  jest.useRealTimers();
});

// A board whose commits are recorded, acknowledged unless told otherwise.
function board({
  host = newHost(),
  measure = (edits: number[]) => edits.reduce((a, b) => a + b, 0),
  result = async (): Promise<CommitResult> => ({ status: "acknowledged" }),
}: {
  host?: HostAdmission;
  measure?: (edits: number[]) => number;
  result?: (edits: number[]) => Promise<CommitResult>;
} = {}) {
  const commits: { at: number; edits: number[] }[] = [];
  const b = new BoardAdmission<number>({
    host,
    measure,
    commit: async (edits) => {
      commits.push({ at: Date.now(), edits });
      return await result(edits);
    },
  });
  // Edits are their own sizes, so a commit's size is their sum.
  const submit = (bytes: number, client = "a") =>
    b.submit(client, bytes, bytes);
  return { b, host, commits, submit };
}

// A refusal comes at once; undefined: the edit was admitted and waits.
function now(p: Promise<Outcome>): Promise<Outcome | undefined> {
  return Promise.race([p, Promise.resolve(undefined)]);
}

async function settle(ms = 0) {
  await jest.advanceTimersByTimeAsync(ms);
}

test("a token bucket refills at its rate, up to its burst", () => {
  const t = new TokenBucket(2, 4, 0);
  expect(t.wait(2, 0)).toBe(0);
  t.take(2, 0);
  expect(t.wait(1, 0)).toBe(250);
  expect(t.wait(1, 250)).toBe(0);
  expect(t.wait(2, 10_000)).toBe(0);
  t.take(2, 10_000);
  t.give(5, 10_000);
  expect(t.wait(3, 10_000)).toBeGreaterThan(0);
});

test("an edit's work is 0.23 ms plus 0.34 ms per KiB", () => {
  expect(editWorkMs(0)).toBeCloseTo(0.23);
  expect(editWorkMs(10 * KiB)).toBeCloseTo(0.23 + 3.4);
});

test("edits in one interval are one commit, acknowledged when it is written", async () => {
  const { commits, submit } = board();
  const outcomes = [submit(10), submit(20), submit(30)];
  await settle();
  expect(commits).toEqual([{ at: Date.now(), edits: [10, 20, 30] }]);
  expect(await Promise.all(outcomes)).toEqual([
    { status: "committed" },
    { status: "committed" },
    { status: "committed" },
  ]);
});

test("an edit is not committed before its write is acknowledged", async () => {
  let ack!: () => void;
  const { submit } = board({
    result: () =>
      new Promise((resolve) => {
        ack = () => resolve({ status: "acknowledged" });
      }),
  });
  let outcome: Outcome | undefined;
  void submit(10).then((o) => (outcome = o));
  await settle(1000);
  expect(outcome).toBeUndefined();
  ack();
  await settle();
  expect(outcome).toEqual({ status: "committed" });
});

test("commits are at least 250 ms apart: at most 4 a second", async () => {
  const { commits, submit } = board();
  const all: Promise<Outcome>[] = [];
  // 5 edits a second (the board's rate) from 3 clients, for 4 seconds.
  for (let i = 0; i < 20; i++) {
    all.push(submit(1, `c${i % 3}`));
    await settle(200);
  }
  await settle(1000);
  await Promise.all(all);
  for (let i = 1; i < commits.length; i++) {
    expect(commits[i].at - commits[i - 1].at).toBeGreaterThanOrEqual(250);
  }
  const first = commits[0].at;
  const inFirstSecond = commits.filter((c) => c.at < first + 1000);
  expect(inFirstSecond.length).toBeLessThanOrEqual(4);
});

test("300 KiB edits: one per commit, one waits in the next slot, the rest are refused before anything is applied", async () => {
  const { commits, submit, host } = board();
  const outcomes: Outcome[] = [];
  const all: Promise<void>[] = [];
  // As fast as the rates allow, from different clients.
  for (let i = 0; i < 12; i++) {
    all.push(submit(300 * KiB, `c${i}`).then((o) => void outcomes.push(o)));
    await settle(50);
  }
  await settle(2000);
  await Promise.all(all);
  for (const c of commits) {
    expect(c.edits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      BOARD_ADMISSION.maxCommitBytes,
    );
  }
  for (let i = 1; i < commits.length; i++) {
    expect(commits[i].at - commits[i - 1].at).toBeGreaterThanOrEqual(250);
  }
  const committed = outcomes.filter((o) => o.status === "committed").length;
  const busy = outcomes.filter(
    (o) => o.status === "refused" && o.reason === "board-busy",
  );
  expect(committed).toBe(commits.length);
  expect(committed + busy.length).toBe(12);
  expect(busy.length).toBeGreaterThan(0);
  expect(busy[0]).toMatchObject({ retryAfter: 250 });
  expect(host.stats.waiting).toBe(0);
});

test("an edit over 512 KiB by itself is refused, and charges nothing", async () => {
  const { commits, submit, host } = board();
  expect(await submit(512 * KiB + 1)).toMatchObject({
    status: "refused",
    reason: "too-large",
  });
  expect(host.stats.waiting).toBe(0);
  // The rate wasn't charged either: a full burst still goes through.
  const ok = [];
  for (let i = 0; i < BOARD_ADMISSION.boardBurst; i++) ok.push(submit(1));
  await settle();
  expect((await Promise.all(ok)).every((o) => o.status === "committed")).toBe(
    true,
  );
  expect(commits).toHaveLength(1);
});

test("the board's rate: a burst of 20, then 5 a second across its clients", async () => {
  const { submit } = board();
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push(submit(1, `c${i}`));
  const over = await now(submit(1, "other"));
  expect(over).toMatchObject({ status: "refused", reason: "rate" });
  expect((over as any).retryAfter).toBeGreaterThan(0);
  await settle(1000);
  await Promise.all(burst);
  const next: (Outcome | undefined)[] = [];
  for (let i = 0; i < 6; i++) next.push(await now(submit(1, `d${i}`)));
  expect(next.filter((o) => o !== undefined)).toEqual([
    expect.objectContaining({ reason: "rate" }),
  ]);
});

test("a client's rate: a burst of 20, then 2 a second; other clients are not held back", async () => {
  const limits = { ...BOARD_ADMISSION, boardBurst: 1000, boardPerSecond: 1000 };
  const { submit } = board({ host: newHost(limits) });
  for (let i = 0; i < 20; i++) {
    expect(await now(submit(1, "a"))).toBeUndefined();
  }
  expect(await now(submit(1, "a"))).toMatchObject({
    reason: "rate",
    retryAfter: 500,
  });
  expect(await now(submit(1, "b"))).toBeUndefined();
  await settle(500);
  expect(await now(submit(1, "a"))).toBeUndefined();
  expect(await now(submit(1, "a"))).toMatchObject({ reason: "rate" });
});

test("a commit over the cap when encoded is refused whole, before anything is applied", async () => {
  // A budget of 200 ms, so a refund matters: the two edits cost about 150.
  const host = newHost({ ...BOARD_ADMISSION, hostWorkBurstMs: 200 });
  // The envelope adds 100 KiB.
  const { commits, submit } = board({
    host,
    measure: (edits) => edits.reduce((a, b) => a + b, 0) + 100 * KiB,
  });
  const outcomes = [submit(300 * KiB, "a"), submit(150 * KiB, "b")];
  await settle();
  expect(commits).toEqual([]);
  for (const o of await Promise.all(outcomes)) {
    expect(o).toMatchObject({ status: "refused", reason: "too-large" });
  }
  // Reservations were released and their work refunded: a 300 KiB edit
  // (about 100 ms) fits again.
  expect(host.stats.waiting).toBe(0);
  expect(host.reserve(300 * KiB)).not.toHaveProperty("reason");
});

test("a write whose outcome is unknown is reported as unknown, never as refused", async () => {
  const { submit, host } = board({
    result: async () => {
      throw Error("timeout");
    },
  });
  const outcome = await (async () => {
    const p = submit(10);
    await settle();
    return await p;
  })();
  expect(outcome).toEqual({ status: "unknown", message: "Error: timeout" });
  expect(host.stats.waiting).toBe(0);
});

test("a refused write refuses its commit's edits", async () => {
  const { submit, host } = board({
    result: async () => ({ status: "refused", message: "history full" }),
  });
  const p = submit(10);
  await settle();
  expect(await p).toEqual({
    status: "refused",
    reason: "write-refused",
    message: "history full",
  });
  expect(host.stats.waiting).toBe(0);
});

test("the next-commit slot is promoted with its reservations, each ended exactly once", async () => {
  const host = newHost();
  const end = jest.spyOn(host, "end");
  const { submit, commits } = board({ host });
  const a = submit(400 * KiB, "a");
  const b = submit(400 * KiB, "b"); // into the next slot
  expect(host.stats.waiting).toBe(2);
  await settle();
  expect(commits).toHaveLength(1);
  expect(host.stats.waiting).toBe(1);
  await settle(250);
  expect(commits).toHaveLength(2);
  expect(await Promise.all([a, b])).toEqual([
    { status: "committed" },
    { status: "committed" },
  ]);
  expect(end).toHaveBeenCalledTimes(2);
  expect(host.stats.waiting).toBe(0);
});

test("the host holds at most 64 waiting edits across its boards", async () => {
  const host = newHost();
  const boards = Array.from({ length: 5 }, () =>
    board({ host, result: () => new Promise(() => {}) }),
  );
  const outcomes: Promise<Outcome>[] = [];
  for (let i = 0; i < 64; i++) {
    outcomes.push(boards[i % 4].submit(1, `c${i}`));
  }
  expect(host.stats.waiting).toBe(64);
  expect(await boards[4].submit(1)).toMatchObject({
    status: "refused",
    reason: "host-busy",
  });
});

test("at most 2 commits apply at once across the host", async () => {
  const host = newHost();
  const acks: (() => void)[] = [];
  let applying = 0;
  let most = 0;
  const boards = Array.from({ length: 4 }, () =>
    board({
      host,
      result: () =>
        new Promise((resolve) => {
          applying += 1;
          most = Math.max(most, applying);
          acks.push(() => {
            applying -= 1;
            resolve({ status: "acknowledged" });
          });
        }),
    }),
  );
  const outcomes = boards.map((b) => b.submit(1));
  await settle();
  expect(applying).toBe(2);
  while (acks.length > 0) {
    acks.shift()!();
    await settle();
  }
  expect((await Promise.all(outcomes)).map((o) => o.status)).toEqual([
    "committed",
    "committed",
    "committed",
    "committed",
  ]);
  expect(most).toBe(2);
});

test("the host's work budget refuses edits once spent, then refills", async () => {
  const host = newHost();
  const boards = Array.from({ length: 8 }, () => board({ host }));
  // 500 KiB edits cost about 170 ms each; the budget is 500 ms.
  const outcomes: (Outcome | undefined)[] = [];
  for (const b of boards) outcomes.push(await now(b.submit(500 * KiB)));
  expect(outcomes.slice(0, 2)).toEqual([undefined, undefined]);
  const busy = outcomes.find((o) => o !== undefined);
  expect(busy).toMatchObject({ reason: "host-busy" });
  const retryAfter = (busy as any).retryAfter;
  expect(retryAfter).toBeGreaterThan(0);
  await settle(retryAfter + 1000);
  expect(await now(boards[7].submit(500 * KiB))).toBeUndefined();
});

test("a commit is charged the time its apply took", async () => {
  const host = newHost();
  const { submit } = board({
    host,
    result: async () => {
      // An apply that takes most of the burst.
      jest.setSystemTime(Date.now() + 480);
      return { status: "acknowledged" };
    },
  });
  const p = submit(1);
  await settle();
  await p;
  // The budget is spent: a 100 KiB edit (34 ms) waits.
  expect(host.reserve(100 * KiB)).toMatchObject({ reason: "host-busy" });
});

test("closing refuses what waits and releases its reservations", async () => {
  let ack!: () => void;
  const { b, submit, host } = board({
    result: () =>
      new Promise((resolve) => {
        ack = () => resolve({ status: "acknowledged" });
      }),
  });
  const first = submit(10);
  await settle(); // the first commit is applying
  const second = submit(10);
  const closing = b.close();
  expect(await second).toMatchObject({ status: "refused", reason: "closed" });
  let closed = false;
  void closing.then(() => (closed = true));
  await settle();
  expect(closed).toBe(false); // waits for the commit that is applying
  ack();
  await settle();
  expect(closed).toBe(true);
  expect(await first).toEqual({ status: "committed" });
  expect(host.stats.waiting).toBe(0);
  expect(await submit(10)).toMatchObject({ reason: "closed" });
});

test("a board closed while its commit waits for a host slot applies nothing", async () => {
  const host = newHost();
  const hold: (() => void)[] = [];
  const busy = () =>
    new Promise<CommitResult>((resolve) =>
      hold.push(() => resolve({ status: "acknowledged" })),
    );
  const a = board({ host, result: busy });
  const b = board({ host, result: busy });
  const c = board({ host });
  const held = [a.submit(1), b.submit(1)];
  const waiting = c.submit(1);
  await settle();
  expect(host.stats.applying).toBe(2);
  const closing = c.b.close();
  hold.shift()!();
  await settle();
  await closing;
  expect(await waiting).toMatchObject({ status: "refused", reason: "closed" });
  expect(c.commits).toEqual([]);
  hold.shift()!();
  await settle();
  await Promise.all(held);
  expect(host.stats).toEqual({ waiting: 0, applying: 0 });
});

test("a board remembers a bounded number of clients", async () => {
  const limits = { ...BOARD_ADMISSION, maxClients: 2 };
  const host = newHost(limits);
  const { submit } = board({ host });
  expect(await now(submit(1, "a"))).toBeUndefined();
  expect(await now(submit(1, "b"))).toBeUndefined();
  expect(await now(submit(1, "c"))).toMatchObject({ reason: "rate" });
  // Once their buckets are full again, they are forgotten.
  await settle(20_000);
  expect(await now(submit(1, "c"))).toBeUndefined();
});

test("the default clock is monotonic", () => {
  const host = new HostAdmission();
  const t = host.now();
  expect(host.now()).toBeGreaterThanOrEqual(t);
  // Not the wall clock.
  jest.setSystemTime(Date.now() - 3_600_000);
  expect(host.now()).toBeGreaterThanOrEqual(t);
});

describe("an injected clock that jumps", () => {
  let t = 0;
  const clock = () => t;
  const host = () => new HostAdmission({ now: clock });

  beforeEach(() => {
    t = 1_000_000;
  });

  test("back: buckets grant nothing for the jump, refill from there, and commits aren't held back", async () => {
    const { submit, commits } = board({ host: host() });
    const burst = [];
    for (let i = 0; i < 20; i++) burst.push(submit(1, `c${i}`));
    await settle();
    await Promise.all(burst);
    t -= 3_600_000;
    expect(await now(submit(1, "x"))).toMatchObject({ reason: "rate" });
    t += 1000; // 5 edits' worth, counted from the jump
    const later = submit(1, "y");
    expect(await now(later)).toBeUndefined();
    await settle(250);
    expect(await later).toEqual({ status: "committed" });
    expect(commits).toHaveLength(2);
  });

  test("forward: buckets refill only up to their burst", async () => {
    const { submit } = board({ host: host() });
    t += 3_600_000;
    for (let i = 0; i < 20; i++) {
      expect(await now(submit(1, `c${i}`))).toBeUndefined();
    }
    expect(await now(submit(1, "x"))).toMatchObject({ reason: "rate" });
  });

  test("back during an apply: the commit is charged nothing, not a negative time", async () => {
    const h = host();
    const { submit } = board({
      host: h,
      result: async () => {
        t -= 10_000;
        return { status: "acknowledged" };
      },
    });
    const p = submit(1);
    await settle();
    expect(await p).toEqual({ status: "committed" });
    // The work bucket was not credited: a 500 ms burst still holds back a
    // second 500 KiB edit after one.
    expect(h.reserve(500 * KiB)).not.toHaveProperty("reason");
    expect(h.reserve(500 * KiB)).not.toHaveProperty("reason");
    expect(h.reserve(500 * KiB)).toMatchObject({ reason: "host-busy" });
  });
});

test("a write that never settles is unknown after the deadline, and frees the host", async () => {
  const host = newHost();
  const never = () => new Promise<CommitResult>(() => {});
  const a = board({ host, result: never });
  const b = board({ host, result: never });
  const c = board({ host });
  const stuck = [a.submit(1), b.submit(1)];
  await settle();
  expect(host.stats.applying).toBe(2);
  const waiting = c.submit(1);
  await settle(BOARD_ADMISSION.commitTimeoutMs - 1);
  expect(await now(waiting)).toBeUndefined();
  await settle(1);
  for (const o of await Promise.all(stuck)) {
    expect(o).toMatchObject({ status: "unknown" });
  }
  await settle();
  expect(await waiting).toEqual({ status: "committed" });
  await a.b.close();
  await b.b.close();
  expect(host.stats).toEqual({ waiting: 0, applying: 0 });
});

test("a commit's measured size must be a whole number of bytes within the cap", async () => {
  for (const bad of [-1, -Infinity, NaN, 1.5, Infinity, 512 * KiB + 1]) {
    const { submit, commits, host } = board({ measure: () => bad });
    const p = submit(1);
    await settle();
    expect(await p).toMatchObject({ status: "refused", reason: "too-large" });
    expect(commits).toEqual([]);
    expect(host.stats.waiting).toBe(0);
  }
  for (const ok of [0, 512 * KiB]) {
    const { submit } = board({ measure: () => ok });
    const p = submit(1);
    await settle();
    expect(await p).toEqual({ status: "committed" });
  }
});

test("an edit of exactly 512 KiB is admitted", async () => {
  const { submit } = board();
  const p = submit(512 * KiB);
  await settle();
  expect(await p).toEqual({ status: "committed" });
});
