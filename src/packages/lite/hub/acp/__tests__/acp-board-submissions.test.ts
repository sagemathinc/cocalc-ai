import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  BOARD_SUBMISSIONS_PER_THREAD_PER_HOUR as LIMIT,
  BOARD_SUBMISSION_ATTEMPT_MS as ATTEMPT,
  BOARD_SUBMISSION_RETENTION_MS as RETENTION,
  BOARD_SUBMISSION_UNCERTAIN,
  BOARD_SUBMISSION_WINDOW_MS as WINDOW,
  BOARD_UNMARKED_UNCERTAIN_PER_ACCOUNT as UNMARKED_LIMIT,
  admitBoardSubmission,
  claimBoardSubmissionRetry,
  failBoardSubmissionAttempt,
  forgetUncertainBoardSubmission,
  listUnmarkedUncertainBoardSubmissions,
  markBoardSubmissionAdmitted,
  markBoardSubmissionUncertainRecorded,
  resetBoardSubmissionsForTests,
  setBoardSubmissionInjecting,
} from "../../sqlite/acp-board-submissions";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const OTHER = "00000000-1000-4000-8000-000000000002";

const key = (id: string, over: Record<string, unknown> = {}): any => ({
  account_id: ACCOUNT,
  project_id: "p",
  path: "a.chat",
  thread_id: "t",
  user_message_id: id,
  ...over,
});
const admit = (id: string, over: Record<string, unknown> = {}, now = 1_000) =>
  admitBoardSubmission(key(id, over), { now });
const token = (id: string, over: Record<string, unknown> = {}, now = 1_000) => {
  const a = admit(id, over, now);
  if (!a.ok || a.kind !== "new") throw new Error(`not new: ${id}`);
  return a.token;
};
const ids = () =>
  getAcpDatabase()
    .prepare(
      "SELECT user_message_id FROM acp_board_submissions ORDER BY user_message_id",
    )
    .all()
    .map((r: any) => r.user_message_id);

beforeEach(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  resetBoardSubmissionsForTests();
});
afterAll(() => closeAcpDatabase());

test("at most LIMIT new submissions per account and thread in the window", () => {
  for (let i = 0; i < LIMIT; i++) {
    expect(admit(`m${i}`)).toMatchObject({ ok: true, kind: "new" });
  }
  expect(admit("over")).toEqual({ ok: false, retry_after_ms: WINDOW });
  // a retry of one sent takes no slot
  expect(admit("m0")).toMatchObject({ ok: true, kind: "unknown" });
  // other threads, chats, projects and accounts have their own
  expect(admit("x1", { thread_id: "t2" }).ok).toBe(true);
  expect(admit("x2", { path: "b.chat" }).ok).toBe(true);
  expect(admit("x3", { account_id: OTHER }).ok).toBe(true);
  // the hour moves on
  expect(admit("later", {}, 1_000 + WINDOW).ok).toBe(true);
});

test("an admitted submission answers retries with its state", () => {
  const t = token("m");
  markBoardSubmissionAdmitted(key("m"), "queued", t);
  expect(admit("m")).toMatchObject({
    ok: true,
    kind: "admitted",
    state: "queued",
  });
});

test("past the window a record still counts as sent, but not toward the bound", () => {
  for (let i = 0; i < LIMIT; i++) {
    markBoardSubmissionAdmitted(key(`m${i}`), "steered", token(`m${i}`));
  }
  const later = 1_000 + WINDOW + 1;
  expect(admit("m0", {}, later)).toMatchObject({
    ok: true,
    kind: "admitted",
    state: "steered",
  });
  expect(admit("fresh", {}, later)).toMatchObject({ ok: true, kind: "new" });
});

describe("attempts", () => {
  test("a failure before the hand-off may be retried, once", () => {
    const t = token("m");
    failBoardSubmissionAttempt(key("m"), t);
    expect(admit("m")).toMatchObject({ kind: "unknown", injecting: false });
    const t2 = claimBoardSubmissionRetry(key("m"), { now: 2_000 });
    expect(t2).toEqual(expect.any(String));
    expect(claimBoardSubmissionRetry(key("m"), { now: 2_001 })).toBeNull();
  });

  test("a failure during the hand-off is uncertain for good", () => {
    const t = token("m");
    expect(setBoardSubmissionInjecting(key("m"), t, 1_500)).toBe(true);
    failBoardSubmissionAttempt(key("m"), t);
    expect(admit("m")).toMatchObject({
      ok: true,
      kind: "admitted",
      state: BOARD_SUBMISSION_UNCERTAIN,
    });
    expect(
      claimBoardSubmissionRetry(key("m"), { now: 10 * ATTEMPT }),
    ).toBeNull();
  });

  test("a hand-off that answered without injecting is cleared", () => {
    const t = token("m");
    setBoardSubmissionInjecting(key("m"), t, 1_500);
    setBoardSubmissionInjecting(key("m"), t, null);
    failBoardSubmissionAttempt(key("m"), t);
    expect(admit("m")).toMatchObject({ kind: "unknown", injecting: false });
  });

  test("a started hand-off is never taken over; silent too long, it is uncertain", () => {
    const t = token("m", {}, 1_000);
    setBoardSubmissionInjecting(key("m"), t, 1_000);
    // still possibly in flight
    expect(admit("m", {}, 1_000 + ATTEMPT - 1)).toMatchObject({
      kind: "unknown",
      injecting: true,
    });
    expect(
      claimBoardSubmissionRetry(key("m"), { now: 1_000 + 2 * ATTEMPT }),
    ).toBeNull();
    // silent past an attempt's time: uncertain
    expect(admit("m", {}, 1_000 + ATTEMPT)).toMatchObject({
      ok: true,
      kind: "admitted",
      state: BOARD_SUBMISSION_UNCERTAIN,
      recorded: false,
    });
  });

  test("a stale attempt can neither hand off nor clear a newer claim (CORR-E69-2)", () => {
    const old = token("m", {}, 1_000);
    // the old attempt stalls before its hand-off; a retry takes over
    const fresh = claimBoardSubmissionRetry(key("m"), {
      now: 1_000 + ATTEMPT,
    })!;
    expect(fresh).toEqual(expect.any(String));
    expect(setBoardSubmissionInjecting(key("m"), old, 2_000)).toBe(false);
    // the old attempt's failure doesn't free the new one's claim
    failBoardSubmissionAttempt(key("m"), old);
    expect(
      claimBoardSubmissionRetry(key("m"), { now: 1_000 + ATTEMPT + 1 }),
    ).toBeNull();
    // nor can the old attempt record an outcome
    markBoardSubmissionAdmitted(key("m"), "steered", old);
    expect(admit("m", {}, 1_000 + ATTEMPT + 2)).toMatchObject({
      kind: "unknown",
    });
    // the current one can
    expect(setBoardSubmissionInjecting(key("m"), fresh, 2_000)).toBe(true);
    markBoardSubmissionAdmitted(key("m"), "steered", fresh);
    expect(admit("m", {}, 1_000 + ATTEMPT + 3)).toMatchObject({
      kind: "admitted",
      state: "steered",
    });
  });
});

test("records go after their retention, never while an attempt is live", () => {
  const late = 1_000 + RETENTION + 1;
  markBoardSubmissionAdmitted(key("done"), "queued", token("done"));
  failBoardSubmissionAttempt(key("ended"), token("ended")); // never handed off
  // a hand-off silent for long: resolved as uncertain, and kept until its
  // marker is on its message (ROBUST-F386-1)
  setBoardSubmissionInjecting(key("silent"), token("silent"), 1_000);
  // an old record whose attempt was just claimed: live, so it stays
  failBoardSubmissionAttempt(key("live"), token("live"));
  expect(claimBoardSubmissionRetry(key("live"), { now: late - 1 })).toEqual(
    expect.any(String),
  );
  admit("new", {}, late);
  expect(ids()).toEqual(["live", "new", "silent"]);
});

test("an uncertain record outlives its retention until its marker is written (ROBUST-F386-1)", () => {
  const late = 1_000 + RETENTION + 1;
  for (const id of ["unmarked", "marked"]) {
    const t = token(id);
    setBoardSubmissionInjecting(key(id), t, 1_000);
    expect(failBoardSubmissionAttempt(key(id), t)).toBe(true);
  }
  markBoardSubmissionUncertainRecorded(key("marked"), 1_200);
  admit("new", {}, late);
  expect(ids()).toEqual(["new", "unmarked"]);
  expect(admit("unmarked", {}, late)).toEqual({
    ok: true,
    kind: "admitted",
    state: BOARD_SUBMISSION_UNCERTAIN,
    recorded: false,
  });
});

describe("unmarked uncertain records (LIMIT-A65-1)", () => {
  const uncertain = (id: string, thread = `t-${id}`, now = 1_000) => {
    const t = token(id, { thread_id: thread }, now);
    setBoardSubmissionInjecting(key(id, { thread_id: thread }), t, now);
    failBoardSubmissionAttempt(key(id, { thread_id: thread }), t);
  };

  test("past the account's cap, its new submissions are refused", () => {
    for (let i = 0; i < UNMARKED_LIMIT; i++) uncertain(`u${i}`);
    expect(admit("fresh", { thread_id: "fresh" })).toEqual({
      ok: false,
      retry_after_ms: ATTEMPT,
      reason: "unresolved",
    });
    // another account is not affected
    expect(admit("other", { account_id: OTHER }).ok).toBe(true);
    // once one is marked on its message, there is room again
    markBoardSubmissionUncertainRecorded(key("u0", { thread_id: "t-u0" }));
    expect(admit("fresh", { thread_id: "fresh" })).toMatchObject({
      ok: true,
      kind: "new",
    });
  });

  test("reconciliation reads a few, oldest first; a forgotten one goes", () => {
    uncertain("b", "tb", 2_000);
    uncertain("a", "ta", 1_000);
    uncertain("c", "tc", 3_000);
    expect(
      listUnmarkedUncertainBoardSubmissions(ACCOUNT, 2).map(
        (k) => k.user_message_id,
      ),
    ).toEqual(["a", "b"]);
    forgetUncertainBoardSubmission(key("a", { thread_id: "ta" }));
    expect(ids()).not.toContain("a");
    // only an unmarked uncertain one can be forgotten
    markBoardSubmissionAdmitted(key("ok"), "steered", token("ok"));
    forgetUncertainBoardSubmission(key("ok"));
    expect(ids()).toContain("ok");
  });

  test("the cap's count uses its partial index", () => {
    admit("m");
    const plan = getAcpDatabase()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM acp_board_submissions
          WHERE account_id = ? AND outcome = 'uncertain' AND uncertain_recorded IS NULL`,
      )
      .all(ACCOUNT)
      .map((r: any) => r.detail)
      .join("\\n");
    expect(plan).toMatch(/acp_board_submissions_unmarked_idx/);
  });
});

test("a failure before the hand-off is not uncertain", () => {
  expect(failBoardSubmissionAttempt(key("m"), token("m"))).toBe(false);
});

test("the silence check searches its partial index, not the table (LIMIT-F386-2)", () => {
  admit("m"); // creates the table and its indexes
  const plan = getAcpDatabase()
    .prepare(
      `EXPLAIN QUERY PLAN UPDATE acp_board_submissions SET outcome = ?
        WHERE outcome IS NULL AND injected_at IS NOT NULL AND injected_at <= ?`,
    )
    .all("uncertain", 0)
    .map((r: any) => r.detail)
    .join("\\n");
  expect(plan).toMatch(/USING INDEX acp_board_submissions_injecting_idx/);
  expect(plan).not.toMatch(/^SCAN acp_board_submissions$/m);
});

test("another account's message id is not the same submission", () => {
  admit("m0");
  expect(() => admit("m0", { account_id: OTHER })).toThrow("another account");
});

test("a missing identity is refused", () => {
  expect(() => admit("")).toThrow();
  expect(() => admit("m", { account_id: "" })).toThrow();
});
