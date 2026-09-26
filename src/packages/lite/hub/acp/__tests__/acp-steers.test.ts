import {
  closeAcpDatabase,
  initAcpDatabase,
  getAcpDatabase,
} from "../../sqlite/acp-database";
import {
  ACP_STEER_CLAIM_LEASE_MS,
  claimAcpSteer,
  decodeAcpSteerCandidateIds,
  decodeAcpSteerFallbackRequest,
  decodeAcpSteerRequest,
  enqueueAcpSteer,
  getAcpSteer,
  heartbeatAcpSteerClaim,
  listPendingAcpSteers,
  markAcpSteerError,
  markAcpSteerHandled,
  ownsAcpSteerClaim,
  releaseAcpSteerClaim,
} from "../../sqlite/acp-steers";
import type { AcpSteerRow } from "../../sqlite/acp-steers";

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

let migratedLegacySteer: AcpSteerRow;

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  const db = getAcpDatabase();
  db.exec(`CREATE TABLE acp_steers (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL,
    thread_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
    candidate_ids_json TEXT NOT NULL, request_json TEXT NOT NULL,
    state TEXT NOT NULL, claim_token TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, handled_at INTEGER,
    UNIQUE(project_id, path, user_message_id)
  )`);
  const request = makeRequest();
  db.prepare(
    `INSERT INTO acp_steers
    (id, project_id, path, thread_id, user_message_id, candidate_ids_json,
     request_json, state, created_at, updated_at)
    VALUES ('legacy', ?, ?, ?, ?, '[]', ?, 'pending', 1, 1)`,
  ).run(
    request.project_id,
    request.chat.path,
    request.chat.thread_id,
    request.chat.parent_message_id,
    JSON.stringify(request),
  );
  migratedLegacySteer = listPendingAcpSteers()[0];
});

beforeEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_steers").run();
});

afterAll(() => {
  closeAcpDatabase();
});

describe("acp steer queue", () => {
  it("migrates legacy pending steers without changing their fallback", () => {
    expect(migratedLegacySteer.id).toBe("legacy");
    expect(migratedLegacySteer.fallback_config_json).toBeNull();
    expect(decodeAcpSteerFallbackRequest(migratedLegacySteer)).toEqual(
      makeRequest(),
    );
    expect(
      getAcpDatabase().prepare("PRAGMA table_info(acp_steers)").all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fallback_config_json" }),
      ]),
    );
  });
  it("stores and decodes a pending steer request", () => {
    const row = enqueueAcpSteer({
      request: makeRequest(),
      candidate_ids: ["thr-live-1", "thread-1"],
    });
    expect(listPendingAcpSteers()).toHaveLength(1);
    expect(decodeAcpSteerCandidateIds(row)).toEqual(["thr-live-1", "thread-1"]);
    expect(decodeAcpSteerRequest(row).prompt).toBe("please keep going");
    expect(decodeAcpSteerFallbackRequest(row)).toEqual(
      decodeAcpSteerRequest(row),
    );
  });

  it("retains separate fallback funding through owner handoff and retry", () => {
    const request = {
      ...makeRequest(),
      config: {
        paymentSource: "subscription-credential" as const,
        credentialId: "live-pin",
      },
    };
    const first = enqueueAcpSteer({
      request,
      fallback_config: { paymentSource: "auto" },
    });
    const claim = claimAcpSteer({ id: first.id })!;
    const handedOff = enqueueAcpSteer({ request, candidate_ids: ["session"] });
    expect(decodeAcpSteerFallbackRequest(handedOff).config).toEqual({
      paymentSource: "auto",
    });
    expect(decodeAcpSteerRequest(handedOff).config).toEqual(request.config);
    markAcpSteerError({ id: first.id, claim_token: claim, error: "retry" });
    const retried = enqueueAcpSteer({ request, fallback_config: {} });
    expect(retried.state).toBe("pending");
    expect(decodeAcpSteerFallbackRequest(retried).config).toEqual({});
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
    const claimToken = claimAcpSteer({ id: row.id });
    expect(claimToken).toEqual(expect.any(String));
    markAcpSteerHandled({ id: row.id, claim_token: claimToken! });
    expect(listPendingAcpSteers()).toEqual([]);
    const stored = getAcpDatabase()
      .prepare("SELECT state FROM acp_steers WHERE id = ?")
      .get(row.id);
    expect(stored && stored.state).toBe("handled");
  });

  it("requeues a failed steer without duplicating its durable identity", () => {
    const first = enqueueAcpSteer({ request: makeRequest() });
    const claimToken = claimAcpSteer({ id: first.id });
    expect(claimToken).toEqual(expect.any(String));
    markAcpSteerError({
      id: first.id,
      claim_token: claimToken!,
      error: "worker stopped",
    });
    expect(listPendingAcpSteers()).toEqual([]);

    const retried = enqueueAcpSteer({
      request: makeRequest(),
      candidate_ids: ["thread-1"],
    });
    expect(retried.id).toBe(first.id);
    expect(retried).toMatchObject({ state: "pending", error: null });
    expect(
      getAcpSteer({
        project_id: retried.project_id,
        path: retried.path,
        user_message_id: retried.user_message_id,
      }),
    ).toMatchObject({ id: first.id, state: "pending" });
  });

  it("serializes delivery claims and recovers an expired claimant", () => {
    const row = enqueueAcpSteer({ request: makeRequest() });
    const now = 1_000_000;
    const firstClaimToken = claimAcpSteer({ id: row.id, now });
    expect(firstClaimToken).toEqual(expect.any(String));
    expect(claimAcpSteer({ id: row.id, now })).toBeUndefined();
    expect(listPendingAcpSteers(50, now)).toEqual([]);
    expect(
      listPendingAcpSteers(50, now + ACP_STEER_CLAIM_LEASE_MS),
    ).toHaveLength(1);
    const secondClaimToken = claimAcpSteer({
      id: row.id,
      now: now + ACP_STEER_CLAIM_LEASE_MS,
    });
    expect(secondClaimToken).toEqual(expect.any(String));
    expect(secondClaimToken).not.toBe(firstClaimToken);
    expect(
      ownsAcpSteerClaim({
        id: row.id,
        claim_token: firstClaimToken!,
      }),
    ).toBe(false);
    expect(
      ownsAcpSteerClaim({
        id: row.id,
        claim_token: secondClaimToken!,
      }),
    ).toBe(true);
    expect(
      heartbeatAcpSteerClaim({
        id: row.id,
        claim_token: firstClaimToken!,
      }),
    ).toBe(false);

    releaseAcpSteerClaim({
      id: row.id,
      claim_token: firstClaimToken!,
    });
    markAcpSteerError({
      id: row.id,
      claim_token: firstClaimToken!,
      error: "stale claimant",
    });
    markAcpSteerHandled({
      id: row.id,
      claim_token: firstClaimToken!,
    });
    expect(
      getAcpSteer({
        project_id: row.project_id,
        path: row.path,
        user_message_id: row.user_message_id,
      }),
    ).toMatchObject({
      state: "processing",
      claim_token: secondClaimToken,
    });

    markAcpSteerHandled({
      id: row.id,
      claim_token: secondClaimToken!,
    });
    expect(
      getAcpSteer({
        project_id: row.project_id,
        path: row.path,
        user_message_id: row.user_message_id,
      }),
    ).toMatchObject({ state: "handled", claim_token: null });
  });

  it("does not extend a processing lease when delivery is re-enqueued", () => {
    const request = makeRequest();
    const row = enqueueAcpSteer({ request });
    const claimedAt = 1_000_000;
    const claimToken = claimAcpSteer({ id: row.id, now: claimedAt });
    expect(claimToken).toEqual(expect.any(String));

    enqueueAcpSteer({ request, candidate_ids: ["thread-1"] });

    const stored = getAcpSteer({
      project_id: row.project_id,
      path: row.path,
      user_message_id: row.user_message_id,
    });
    expect(stored).toMatchObject({
      state: "processing",
      claim_token: claimToken,
      updated_at: claimedAt,
    });
    expect(
      listPendingAcpSteers(50, claimedAt + ACP_STEER_CLAIM_LEASE_MS),
    ).toHaveLength(1);
  });
});
