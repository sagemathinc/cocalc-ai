import {
  closeDatabase,
  initDatabase,
  getDatabase,
} from "../../sqlite/database";
import {
  decodeAcpSteerCandidateIds,
  decodeAcpSteerRequest,
  enqueueAcpSteer,
  listPendingAcpSteers,
  markAcpSteerHandled,
} from "../../sqlite/acp-steers";

function makeRequest() {
  return {
    project_id: "00000000-1000-4000-8000-000000000000",
    account_id: "00000000-1000-4000-8000-000000000001",
    session_id: "thr-live-1",
    prompt: "please keep going",
    chat: {
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/steer.chat",
      thread_id: "thread-1",
      parent_message_id: "user-1",
      message_id: "assistant-1",
      message_date: "2026-04-09T00:00:00.000Z",
      sender_id: "openai-codex-agent",
    },
  };
}

beforeAll(() => {
  closeDatabase();
  initDatabase({ filename: ":memory:" });
  listPendingAcpSteers();
});

beforeEach(() => {
  getDatabase().prepare("DELETE FROM acp_steers").run();
});

afterAll(() => {
  closeDatabase();
});

describe("acp steer queue", () => {
  it("stores and decodes a pending steer request", () => {
    const row = enqueueAcpSteer({
      request: makeRequest(),
      candidate_ids: ["thr-live-1", "thread-1"],
    });
    expect(listPendingAcpSteers()).toHaveLength(1);
    expect(decodeAcpSteerCandidateIds(row)).toEqual(["thr-live-1", "thread-1"]);
    expect(decodeAcpSteerRequest(row).prompt).toBe("please keep going");
  });

  it("deduplicates repeated pending inserts for the same user message", () => {
    const request = makeRequest();
    const first = enqueueAcpSteer({
      request,
      candidate_ids: ["thread-1"],
    });
    const second = enqueueAcpSteer({
      request,
      candidate_ids: ["thr-live-1", "thread-1"],
    });
    expect(first.id).toBe(second.id);
    expect(listPendingAcpSteers()).toHaveLength(1);
    expect(decodeAcpSteerCandidateIds(second)).toEqual([
      "thread-1",
      "thr-live-1",
    ]);
  });

  it("hides handled steer rows from the pending list", () => {
    const row = enqueueAcpSteer({
      request: makeRequest(),
    });
    markAcpSteerHandled({ id: row.id });
    expect(listPendingAcpSteers()).toEqual([]);
    const stored = getDatabase()
      .prepare("SELECT state FROM acp_steers WHERE id = ?")
      .get(row.id);
    expect(stored && stored.state).toBe("handled");
  });
});
