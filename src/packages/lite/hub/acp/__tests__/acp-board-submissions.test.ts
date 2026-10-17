import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  BOARD_SUBMISSIONS_PER_THREAD_PER_HOUR as LIMIT,
  BOARD_SUBMISSION_ATTEMPT_MS as ATTEMPT,
  BOARD_SUBMISSION_WINDOW_MS as WINDOW,
  admitBoardSubmission,
  claimBoardSubmissionRetry,
  endBoardSubmissionAttempt,
  markBoardSubmissionAdmitted,
  resetBoardSubmissionsForTests,
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
const rows = () =>
  (
    getAcpDatabase()
      .prepare("SELECT COUNT(*) AS n FROM acp_board_submissions")
      .get() as any
  ).n;

beforeEach(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  resetBoardSubmissionsForTests();
});
afterAll(() => closeAcpDatabase());

test("at most LIMIT new submissions per account and thread in the window", () => {
  for (let i = 0; i < LIMIT; i++) {
    expect(admit(`m${i}`)).toEqual({ ok: true, kind: "new" });
  }
  expect(admit("over")).toEqual({ ok: false, retry_after_ms: WINDOW });
  // a retry of one sent takes no slot
  expect(admit("m0")).toMatchObject({ ok: true, kind: "unknown" });
  // other threads, chats, projects and accounts have their own
  expect(admit("x1", { thread_id: "t2" }).ok).toBe(true);
  expect(admit("x2", { path: "b.chat" }).ok).toBe(true);
  expect(admit("x3", { account_id: OTHER }).ok).toBe(true);
  // the window moves on: the oldest goes, one slot frees
  expect(admit("later", {}, 1_000 + WINDOW).ok).toBe(true);
});

test("an admitted submission answers retries with its state", () => {
  admit("m");
  markBoardSubmissionAdmitted(key("m"), "queued");
  expect(admit("m")).toEqual({ ok: true, kind: "admitted", state: "queued" });
});

test("an unknown outcome is taken over only once its attempt has ended", () => {
  admit("m", {}, 1_000);
  // the first attempt may still be in flight
  expect(claimBoardSubmissionRetry(key("m"), { now: 1_001 })).toBe(false);
  // it ended without an outcome: a retry may take over, once
  endBoardSubmissionAttempt(key("m"));
  expect(claimBoardSubmissionRetry(key("m"), { now: 2_000 })).toBe(true);
  expect(claimBoardSubmissionRetry(key("m"), { now: 2_001 })).toBe(false);
  // an attempt that never ended (the hub stopped) is taken over in time
  expect(claimBoardSubmissionRetry(key("m"), { now: 2_000 + ATTEMPT })).toBe(
    true,
  );
  // an admitted one is never sent again
  markBoardSubmissionAdmitted(key("m"), "steered");
  endBoardSubmissionAttempt(key("m"));
  expect(claimBoardSubmissionRetry(key("m"), { now: 10 * ATTEMPT })).toBe(
    false,
  );
});

test("another account's message id is not the same submission", () => {
  admit("m0");
  expect(() => admit("m0", { account_id: OTHER })).toThrow("another account");
});

test("old admissions are deleted, so the table holds only the window", () => {
  for (let i = 0; i < 10; i++) admit(`old${i}`, { thread_id: `t${i}` });
  expect(rows()).toBe(10);
  admit("new", {}, 1_000 + WINDOW + 1);
  expect(rows()).toBe(1);
});

test("a missing identity is refused", () => {
  expect(() => admit("")).toThrow();
  expect(() => admit("m", { account_id: "" })).toThrow();
});
