import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  encryptSecretSettingValue,
  decryptSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";
import { normalizePeopleInvitationPayload } from "@cocalc/util/people-invitations";
import type {
  PeopleInvitationPayload,
  PeopleInvitationOperation,
  SendPeopleInvitationInput,
} from "@cocalc/util/people-invitations";
import { PeopleInvitationStore } from "./invitations-store";
import {
  PeopleInvitationService,
  invitationReviewRequired,
} from "./invitations";
import type { PeopleInvitationServices } from "./invitations";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("people invitation durable orchestration", () => {
  const pool = getPool();
  const account_id = randomUUID(),
    recipient_id = randomUUID(),
    project_id = randomUUID();
  const key = Buffer.alloc(32, 7);
  const store = new PeopleInvitationStore(pool, {
    seal: async (value) =>
      encryptSecretSettingValue("test", JSON.stringify(value), key),
    open: async (value) =>
      JSON.parse(decryptSecretSettingValue("test", value, key)),
  });
  let dependencies: PeopleInvitationServices;
  let service: PeopleInvitationService;
  const payload = (): PeopleInvitationPayload =>
    normalizePeopleInvitationPayload({
      recipient: { kind: "account", account_id: recipient_id },
      projects: [{ project_id, action: "notify" }],
      message: "Authored invitation",
      channels: { notification: true, email: false },
    });
  async function prepare(p = payload()) {
    return service.prepare(
      account_id,
      { draft_id: randomUUID(), expected_revision: 0, payload: p },
      "session",
    );
  }
  async function reviewed(p = payload()): Promise<SendPeopleInvitationInput> {
    const draft = await prepare(p);
    const review = await service.review(account_id, draft, "session");
    return {
      draft_id: draft.draft_id,
      revision: draft.revision,
      review_id: review.review_id,
      idempotency_key: randomUUID(),
    };
  }
  async function due(operation_id: string) {
    await pool.query(
      "UPDATE people_invitation_operations SET lease_until=0,next_attempt_at=0 WHERE account_id=$1 AND operation_id=$2",
      [account_id, operation_id],
    );
  }
  beforeAll(async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS accounts(account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await pool.query("INSERT INTO accounts(account_id) VALUES($1)", [
      account_id,
    ]);
    await store.ensureSchema();
    await pool.query(
      "CREATE TABLE invitation_test_notifications(id UUID PRIMARY KEY)",
    );
  });
  beforeEach(async () => {
    await pool.query(
      "DELETE FROM people_invitation_drafts WHERE account_id=$1",
      [account_id],
    );
    await pool.query(
      "DELETE FROM people_invitation_operations WHERE account_id=$1",
      [account_id],
    );
    await pool.query("DELETE FROM invitation_test_notifications");
    dependencies = {
      refreshDelivery: jest.fn(async () => {}),
      authorizeHome: jest.fn(async () => {}),
      preflight: jest.fn(async (_account, _payload, action) => ({
        project_id: action.project_id,
        action: action.action,
        recipient_access:
          action.action === "notify" ? "sufficient" : "insufficient",
        warnings: [],
      })),
      inspectAccess: jest.fn(async () => undefined),
      executeAccess: jest.fn(async (input) => ({
        child_operation_id: input.child_operation_id,
        project_id: input.action.project_id,
        action: input.action.action,
        status: "created",
        access_invite_id: randomUUID(),
        delivery: [],
      })),
      prepareDelivery: jest.fn(async () => async (db, operation) => {
        await db.query(
          "INSERT INTO invitation_test_notifications VALUES($1) ON CONFLICT DO NOTHING",
          [operation.operation_id],
        );
        for (const r of operation.outcomes.filter((r) =>
          ["created", "reused", "notified"].includes(r.status),
        )) {
          r.collaboration_invitation_id = r.child_operation_id;
          r.delivery = [
            {
              channel: "notification",
              status: "queued",
              receipt_id: operation.operation_id,
            },
          ];
        }
      }),
      projectOutcome: jest.fn(async () => {}),
    };
    service = new PeopleInvitationService(store, dependencies);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM accounts WHERE account_id=$1", [account_id]);
    await pool.query("DROP TABLE invitation_test_notifications");
  });
  it("prepares and reviews without contact, access or delivery mutations", async () => {
    const draft = await prepare();
    await service.review(account_id, draft, "session");
    expect(dependencies.executeAccess).not.toHaveBeenCalled();
    expect(dependencies.projectOutcome).not.toHaveBeenCalled();
    expect(dependencies.prepareDelivery).not.toHaveBeenCalled();
    const stored = (
      await pool.query(
        "SELECT ciphertext FROM people_invitation_drafts WHERE account_id=$1",
        [account_id],
      )
    ).rows[0].ciphertext;
    expect(stored).not.toContain("Authored invitation");
  });
  it("serializes racing revisions and invalidates old reviews", async () => {
    const input = await reviewed();
    const attempts = await Promise.allSettled(
      ["first", "second"].map((message) =>
        service.prepare(
          account_id,
          {
            draft_id: input.draft_id,
            expected_revision: 1,
            payload: { ...payload(), message },
          },
          "session",
        ),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(service.send(account_id, input, "session")).rejects.toThrow(
      "review required",
    );
  });
  it("replays initial preparation without renewing expiry", async () => {
    const id = randomUUID();
    const input = { draft_id: id, expected_revision: 0, payload: payload() };
    expect(await service.prepare(account_id, input, "session")).toEqual(
      await service.prepare(account_id, input, "session"),
    );
  });
  it("binds send to the exact session, revision, review and idempotency key", async () => {
    const input = await reviewed();
    await expect(service.send(account_id, input, "forged")).rejects.toThrow(
      "review required",
    );
    const operation = await service.send(account_id, input, "session");
    expect(operation.status).toBe("complete");
    expect(await service.send(account_id, input, "session")).toEqual(operation);
    await expect(
      service.send(account_id, { ...input, revision: 2 }, "session"),
    ).rejects.toThrow("already used");
    await expect(
      service.send(
        account_id,
        { ...input, idempotency_key: randomUUID() },
        "session",
      ),
    ).rejects.toThrow("review required");
    expect(dependencies.executeAccess).not.toHaveBeenCalled();
    expect(dependencies.prepareDelivery).toHaveBeenCalledTimes(1);
  });
  it("rejects expired reviews before durable admission", async () => {
    const input = await reviewed();
    await pool.query(
      "UPDATE people_invitation_drafts SET review_expires_at=0 WHERE account_id=$1",
      [account_id],
    );
    await expect(service.send(account_id, input, "session")).rejects.toThrow(
      "review required",
    );
    expect(
      (
        await pool.query(
          "SELECT * FROM people_invitation_operations WHERE account_id=$1",
          [account_id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("never turns stale notify review into an access offer", async () => {
    const input = await reviewed();
    jest
      .mocked(dependencies.preflight)
      .mockRejectedValue(invitationReviewRequired());
    const operation = await service.send(account_id, input, "session");
    expect(operation.outcomes[0].status).toBe("review_required");
    expect(dependencies.executeAccess).not.toHaveBeenCalled();
    expect(dependencies.prepareDelivery).not.toHaveBeenCalled();
  });
  it("inspects a lost owner acknowledgement before any retry or current access check", async () => {
    const p = payload();
    p.projects = [{ project_id, action: "offer_access", role: "collaborator" }];
    const input = await reviewed(p);
    let committed: PeopleInvitationOperation["outcomes"][number] | undefined;
    jest
      .mocked(dependencies.executeAccess)
      .mockImplementation(async (request) => {
        committed = {
          child_operation_id: request.child_operation_id,
          project_id,
          action: "offer_access",
          status: "created",
          access_invite_id: randomUUID(),
          delivery: [],
        };
        throw Error("lost acknowledgement");
      });
    const unknown = await service.send(account_id, input, "session");
    expect(unknown.status).toBe("unknown");
    jest.mocked(dependencies.inspectAccess).mockResolvedValue(committed);
    jest
      .mocked(dependencies.preflight)
      .mockRejectedValue(invitationReviewRequired());
    await due(input.idempotency_key);
    await service.run(account_id, input.idempotency_key);
    const recovered = await service.status(
      account_id,
      input.idempotency_key,
      "session",
    );
    expect(recovered.outcomes[0].access_invite_id).toBe(
      committed!.access_invite_id,
    );
    expect(dependencies.executeAccess).toHaveBeenCalledTimes(1);
  });
  it("does not execute when inspecting the owner outcome is unavailable", async () => {
    const p = payload();
    p.projects = [{ project_id, action: "offer_access", role: "collaborator" }];
    const input = await reviewed(p);
    jest
      .mocked(dependencies.inspectAccess)
      .mockRejectedValue(Error("owner unavailable"));
    expect((await service.send(account_id, input, "session")).status).toBe(
      "unknown",
    );
    expect(dependencies.executeAccess).not.toHaveBeenCalled();
  });
  it("persists success independently and never repeats it after another project fails", async () => {
    const p = payload(),
      other = randomUUID();
    p.projects = [
      { project_id, action: "offer_access", role: "collaborator" },
      { project_id: other, action: "offer_access", role: "viewer" },
    ];
    const input = await reviewed(p);
    const original = dependencies.preflight;
    dependencies.preflight = jest.fn(async (a, p, action) => {
      if (action.project_id === other) throw invitationReviewRequired();
      return original(a, p, action);
    });
    const operation = await service.send(account_id, input, "session");
    expect(operation.status).toBe("partial");
    expect(operation.outcomes.map((r) => r.status)).toEqual([
      "created",
      "review_required",
    ]);
    await service.send(account_id, input, "session");
    expect(dependencies.executeAccess).toHaveBeenCalledTimes(1);
  });
  it("rolls back notification intent with a failed receipt transaction, then resumes", async () => {
    const input = await reviewed();
    const original = dependencies.prepareDelivery;
    dependencies.prepareDelivery = jest.fn(async (operation) => {
      const write = await original(operation);
      return async (db, op) => {
        await write(db, op);
        throw Error("receipt failure");
      };
    });
    await service.send(account_id, input, "session");
    expect(
      (await pool.query("SELECT * FROM invitation_test_notifications")).rows,
    ).toHaveLength(0);
    dependencies.prepareDelivery = original;
    await due(input.idempotency_key);
    await service.run(account_id, input.idempotency_key);
    expect(
      (await pool.query("SELECT * FROM invitation_test_notifications")).rows,
    ).toHaveLength(1);
  });
  it("preserves jobs after a process crash and fences superseded workers", async () => {
    const input = await reviewed();
    await store.admit(account_id, input, "session");
    const first = (await store.claim(account_id, input.idempotency_key))!;
    expect(
      await store.claim(account_id, input.idempotency_key),
    ).toBeUndefined();
    await due(input.idempotency_key);
    const next = (await store.claim(account_id, input.idempotency_key))!;
    expect(next.lease_id).not.toBe(first.lease_id);
    await expect(
      store.save(first.operation, first.lease_id, true),
    ).rejects.toThrow("superseded");
  });
  it("does not perform new actions after delayed admission authorization expires", async () => {
    const input = await reviewed();
    await store.admit(account_id, input, "session");
    const claim = (await store.claim(account_id, input.idempotency_key))!;
    claim.operation.authorization_expires_at = 0;
    await store.save(claim.operation, claim.lease_id, true, true);
    await due(input.idempotency_key);
    await service.run(account_id, input.idempotency_key);
    expect(
      (await store.operation(account_id, input.idempotency_key)).outcomes[0]
        .status,
    ).toBe("review_required");
    expect(dependencies.prepareDelivery).not.toHaveBeenCalled();
  });
  it("refuses reads and writes for a different account and writes on a stale home", async () => {
    const input = await reviewed();
    await expect(store.draft(randomUUID(), input.draft_id)).rejects.toThrow(
      "not found",
    );
    await pool.query(
      "UPDATE accounts SET home_bay_id='other-bay' WHERE account_id=$1",
      [account_id],
    );
    try {
      await expect(store.admit(account_id, input, "session")).rejects.toThrow(
        "homed on other-bay",
      );
    } finally {
      await pool.query(
        "UPDATE accounts SET home_bay_id=NULL WHERE account_id=$1",
        [account_id],
      );
    }
  });
});
