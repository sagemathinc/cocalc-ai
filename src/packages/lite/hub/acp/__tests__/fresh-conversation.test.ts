import { freshThreadConfig } from "../fresh-conversation";
import { buildThreadConfigRecord } from "@cocalc/chat";
import {
  initAcpDatabase,
  closeAcpDatabase,
  getAcpDatabase,
} from "../../sqlite/acp-database";
import {
  installThreadSuccessorFence,
  reserveThreadSuccessor,
  claimThreadPreparation,
  finishThreadPreparation,
} from "../../sqlite/acp-thread-successors";

const key = {
  project_id: "project",
  path: "/home/user/test.chat",
  thread_id: "old",
};
beforeEach(() => {
  initAcpDatabase({ filename: ":memory:" });
  const db = getAcpDatabase();
  for (const table of ["acp_jobs", "acp_turns", "acp_steers"] as const) {
    db.exec(
      `CREATE TABLE ${table} (project_id TEXT, path TEXT, thread_id TEXT, state TEXT)`,
    );
    installThreadSuccessorFence(table);
  }
});
afterEach(closeAcpDatabase);

test("only one live worker initializes a successor and completed retries never rewrite it", () => {
  reserveThreadSuccessor(key);
  const token = claimThreadPreparation(key)!;
  expect(token).toBeTruthy();
  expect(() => claimThreadPreparation(key)).toThrow("already being prepared");
  finishThreadPreparation(key, "not-the-owner", true);
  expect(() => claimThreadPreparation(key)).toThrow("already being prepared");
  finishThreadPreparation(key, token, false);
  const retry = claimThreadPreparation(key)!;
  expect(retry).not.toBe(token);
  finishThreadPreparation(key, retry, true);
  expect(claimThreadPreparation(key)).toBeUndefined();
});

test.each([
  ["acp_jobs", "queued"],
  ["acp_jobs", "running"],
  ["acp_turns", "running"],
  ["acp_steers", "pending"],
  ["acp_steers", "processing"],
])(
  "%s %s prevents a fresh conversation without installing a fence",
  (table, state) => {
    const db = getAcpDatabase();
    db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(
      key.project_id,
      key.path,
      key.thread_id,
      state,
    );
    expect(() => reserveThreadSuccessor(key)).toThrow("Finish or cancel");
    expect(
      db.prepare("SELECT * FROM acp_thread_successors").all(),
    ).toHaveLength(0);
  },
);

test("reservation is idempotent and fences admission and retry but not other threads", () => {
  const db = getAcpDatabase();
  db.prepare("INSERT INTO acp_jobs VALUES (?,?,?,'completed')").run(
    key.project_id,
    key.path,
    key.thread_id,
  );
  const next = reserveThreadSuccessor(key);
  expect(reserveThreadSuccessor(key)).toBe(next);
  for (const table of ["acp_jobs", "acp_turns", "acp_steers"] as const) {
    const state = table === "acp_steers" ? "pending" : "running";
    expect(() =>
      db
        .prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`)
        .run(key.project_id, key.path, key.thread_id, state),
    ).toThrow("conversation is closed");
    db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(
      key.project_id,
      key.path,
      next,
      state,
    );
  }
  expect(() =>
    db
      .prepare("UPDATE acp_jobs SET state='queued' WHERE thread_id=?")
      .run(key.thread_id),
  ).toThrow("conversation is closed");
});

test("fresh configuration preserves appearance and settings but not session, goals, or automation", () => {
  const old = buildThreadConfigRecord({
    thread_id: "old",
    updated_by: "human",
    name: "Assistant",
    agent_kind: "acp",
    thread_color: "blue",
    thread_icon: "robot",
    acp_config: {
      sessionId: "provider-session",
      model: "model",
      workingDirectory: "/work",
      paymentSource: "project-api-key",
    },
    automation_config: { enabled: false },
  });
  const next = freshThreadConfig(old, "new", "human");
  expect(next.thread_id).toBe("new");
  expect(next.thread_color).toBe(old.thread_color);
  expect(next.thread_icon).toBe(old.thread_icon);
  expect(next.acp_config).toEqual({
    model: "model",
    workingDirectory: "/work",
    paymentSource: "project-api-key",
  });
  expect(next.automation_config).toBeUndefined();
  expect(next.acp_goal).toBeUndefined();
  expect(old.acp_config?.sessionId).toBe("provider-session");
});
