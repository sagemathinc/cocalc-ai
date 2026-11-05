import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  finalizeAcpTurnLease,
  listAcpTurnLeasesForProtection,
  startAcpTurnLease,
} from "../../sqlite/acp-turns";

const NOW = 1_800_000_000_000;

function start(project_id: string, message_date: string) {
  startAcpTurnLease({
    context: {
      project_id,
      path: "work.chat",
      message_date,
      message_id: `m-${message_date}`,
      thread_id: "t",
      sender_id: "s",
    } as any,
    approver_account_id: "account",
    owner_instance_id: "worker",
    pid: process.pid,
  });
  return { project_id, path: "work.chat", message_date };
}

function setTimes(
  key: { project_id: string; message_date: string },
  times: { heartbeat_at?: number; ended_at?: number },
) {
  const db = getAcpDatabase();
  if (times.heartbeat_at != null) {
    db.prepare(
      "UPDATE acp_turns SET heartbeat_at = ? WHERE project_id = ? AND message_date = ?",
    ).run(times.heartbeat_at, key.project_id, key.message_date);
  }
  if (times.ended_at != null) {
    db.prepare(
      "UPDATE acp_turns SET ended_at = ? WHERE project_id = ? AND message_date = ?",
    ).run(times.ended_at, key.project_id, key.message_date);
  }
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_turns").run();
});

afterAll(() => {
  closeAcpDatabase();
});

test("running leases are returned only with a heartbeat in [since, now]", () => {
  setTimes(start("p-fresh", "d1"), { heartbeat_at: NOW - 1_000 });
  setTimes(start("p-stale", "d2"), { heartbeat_at: NOW - 200_000 });
  setTimes(start("p-future", "d3"), { heartbeat_at: NOW + 1_000 });
  const { running, ended } = listAcpTurnLeasesForProtection({
    now: NOW,
    heartbeat_since: NOW - 120_000,
  });
  expect(running.map((row) => row.project_id)).toEqual(["p-fresh"]);
  expect(ended).toEqual([]);
});

test("ended leases are returned in (ended_after, now], oldest first, with truncation", () => {
  const keys = ["a", "b", "c"].map((id, i) => {
    const key = start(`p-${id}`, `d${i}`);
    finalizeAcpTurnLease({
      key,
      state: "completed",
      owner_instance_id: "worker",
    });
    return key;
  });
  setTimes(keys[0], { ended_at: NOW - 90_000 }); // before the cursor
  setTimes(keys[1], { ended_at: NOW - 30_000 });
  setTimes(keys[2], { ended_at: NOW - 10_000 });
  const all = listAcpTurnLeasesForProtection({
    now: NOW,
    heartbeat_since: NOW - 120_000,
    ended_after: NOW - 60_000,
  });
  expect(all.ended.map((row) => row.project_id)).toEqual(["p-b", "p-c"]);
  expect(all.ended_truncated).toBe(false);
  // The cursor itself is exclusive.
  const exclusive = listAcpTurnLeasesForProtection({
    now: NOW,
    heartbeat_since: NOW - 120_000,
    ended_after: NOW - 30_000,
  });
  expect(exclusive.ended.map((row) => row.project_id)).toEqual(["p-c"]);
  const limited = listAcpTurnLeasesForProtection({
    now: NOW,
    heartbeat_since: NOW - 120_000,
    ended_after: NOW - 60_000,
    ended_limit: 1,
  });
  expect(limited.ended.map((row) => row.project_id)).toEqual(["p-b"]);
  expect(limited.ended_truncated).toBe(true);
});
