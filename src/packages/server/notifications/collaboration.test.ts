import type { PoolClient } from "@cocalc/database/pool";
import type { CreateNotificationEventInput } from "@cocalc/database/postgres/notifications-core";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { reconcileCollaborationAttention } from "@cocalc/util/collaboration-attention";
import {
  receiveCollaborationMessageNotification,
  receiveCollaborationNotificationBatch,
} from "./collaboration";
import type {
  CollaborationNotificationAuthority,
  CollaborationNotificationDelivery,
  CollaborationNotificationHooks,
} from "./collaboration";

jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraphInTransaction: jest.fn(),
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeWriteFence: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "recipient-home",
}));

const alice = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const carol = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const delivery: CollaborationNotificationDelivery = {
  account_id: bob,
  access_generation: "membership-1",
  event: {
    version: 1,
    project_id: "11111111-1111-4111-8111-111111111111",
    room_id: "22222222-2222-4222-8222-222222222222",
    thread_id: "thread-1",
    message_id: "message-1",
    actor_account_id: alice,
    activity: 11,
    mode: "live",
    mentioned_account_ids: [bob, carol],
    mention_all: false,
  },
};

it("preserves the captured grant request through service-internal normalization", async () => {
  await receiveCollaborationMessageNotification(
    { ...delivery, grant_request_id: alice.toUpperCase() },
    hooks,
  );
  expect(hooks.lockAttention).toHaveBeenCalledWith(
    expect.objectContaining({
      delivery: expect.objectContaining({ grant_request_id: alice }),
    }),
  );
});

const graph = createNotificationEventGraphInTransaction as jest.Mock;
const fence = withAccountRehomeWriteFence as jest.Mock;
let authority: CollaborationNotificationAuthority;
let hooks: CollaborationNotificationHooks;
let state: ReturnType<typeof reconcileCollaborationAttention>;
let committed: Map<string, CreateNotificationEventInput>;
let stages: Map<string, CreateNotificationEventInput>;
let db: PoolClient;
let calls: string[];

beforeEach(() => {
  jest.clearAllMocks();
  committed = new Map();
  calls = [];
  authority = {
    project_id: delivery.event.project_id,
    room_id: delivery.event.room_id,
    thread_id: delivery.event.thread_id,
    owning_bay_id: "project-owner",
    chat_path: "/home/user/.cocalc/collaborators.chat",
    access_generation: delivery.access_generation,
    actor_role: "collaborator",
    recipient_role: "owner",
  };
  state = reconcileCollaborationAttention({
    account_id: bob,
    initial_activity: 10,
  });
  hooks = {
    authorize: jest.fn(async () => {
      calls.push("authorize");
      return authority;
    }),
    lockAttention: jest.fn(async () => {
      calls.push("attention");
      return { access_generation: delivery.access_generation, state };
    }),
  };
  db = {
    query: jest.fn(async (_sql: string, [event_id]: string[]) => {
      calls.push("dedup");
      const input = stages.get(event_id);
      return {
        rows: input
          ? input.targets.map((target) => ({
              target_account_id: target.target_account_id,
              notification_id: target.notification_id,
              payload_json: input.payload_json,
            }))
          : [],
      };
    }),
  } as unknown as PoolClient;
  // Model the production transaction's serialization and rollback, including a
  // lost acknowledgment after COMMIT. SQL integration is covered separately.
  let tail = Promise.resolve();
  fence.mockImplementation(async ({ fn }) => {
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      calls.push("fence");
      stages = new Map(committed);
      const result = await fn(db);
      committed = stages;
      return result;
    } finally {
      unlock();
    }
  });
  graph.mockImplementation(async ({ db: client, input }) => {
    expect(client).toBe(db);
    calls.push("graph");
    stages.set(input.event_id, input);
    return {};
  });
});

const receive = (input = delivery) =>
  receiveCollaborationMessageNotification(input, hooks);

it("uses the existing graph/outbox at the recipient home, with no transcript or recipient list", async () => {
  state.muted = true;
  const result = await receive();
  expect(result.status).toBe("created");
  expect(calls).toEqual(["authorize", "fence", "attention", "dedup", "graph"]);
  expect(fence).toHaveBeenCalledWith(
    expect.objectContaining({ account_id: bob }),
  );
  const input = graph.mock.calls[0][0].input;
  expect(input).toMatchObject({
    kind: "mention",
    source_bay_id: "recipient-home",
    source_project_id: delivery.event.project_id,
    actor_account_id: alice,
    payload_json: {
      notification_reason: "mention",
      thread_id: "thread-1",
      message_id: "message-1",
    },
    targets: [{ target_account_id: bob, target_home_bay_id: "recipient-home" }],
  });
  expect(JSON.stringify(input)).not.toContain(carol);
  expect(input.payload_json.body).toBeUndefined();
  expect(input.payload_json.mentioned_account_ids).toBeUndefined();
});

it("deduplicates sequential retry, lost response, simultaneous workers and moved locators", async () => {
  const first = await receive();
  authority.chat_path = "/home/user/moved.chat";
  const results = await Promise.all([receive(), receive(), receive()]);
  for (const result of results)
    expect(result).toEqual({ ...first, status: "duplicate" });
  expect(committed.size).toBe(1);
  expect(graph).toHaveBeenCalledTimes(1);
});

it("rejects changed immutable event facts rather than treating them as a valid replay", async () => {
  await receive();
  await expect(
    receive({ ...delivery, event: { ...delivery.event, activity: 12 } }),
  ).rejects.toThrow("conflicting");
  expect(graph).toHaveBeenCalledTimes(1);
});

it.each(["actor_role", "recipient_role"] as const)(
  "rejects viewer access in %s, including mention-all",
  async (field) => {
    authority[field] = "viewer";
    expect(
      await receive({
        ...delivery,
        event: { ...delivery.event, mention_all: true },
      }),
    ).toEqual({ status: "revoked" });
    expect(fence).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  },
);

it("fails closed on owner revocation and never rebinds an old event to a rejoin generation", async () => {
  authority.access_generation = "membership-2";
  expect(await receive()).toEqual({ status: "revoked" });
  (hooks.authorize as jest.Mock).mockResolvedValue(null);
  expect(await receive()).toEqual({ status: "revoked" });
  expect(graph).not.toHaveBeenCalled();
});

it("rechecks home access generation after the owner RPC and before delivery", async () => {
  (hooks.lockAttention as jest.Mock).mockResolvedValue({
    access_generation: "membership-2",
    state,
  });
  expect(await receive()).toEqual({ status: "revoked" });
  (hooks.lockAttention as jest.Mock).mockResolvedValue(null);
  expect(await receive()).toEqual({ status: "revoked" });
  expect(graph).not.toHaveBeenCalled();
});

it.each(["authorize", "lockAttention"] as const)(
  "propagates unavailable %s for retry instead of acknowledging",
  async (hook) => {
    (hooks[hook] as jest.Mock).mockRejectedValue(
      Error("temporarily unavailable"),
    );
    await expect(receive()).rejects.toThrow("temporarily unavailable");
    expect(committed.size).toBe(0);
  },
);

it("cannot deliver on the wrong account home or during account rehome", async () => {
  fence.mockRejectedValueOnce(Error("account rehome frozen"));
  await expect(receive()).rejects.toThrow("account rehome frozen");
  expect(hooks.lockAttention).not.toHaveBeenCalled();
  expect(graph).not.toHaveBeenCalled();
});

it("rolls back failures without consuming the delivery and retries the identical graph", async () => {
  const insert = graph.getMockImplementation()!;
  graph.mockImplementationOnce(async (input) => {
    await insert(input);
    throw Error("outbox insert failed");
  });
  await expect(receive()).rejects.toThrow("outbox insert failed");
  expect(committed.size).toBe(0);
  expect((await receive()).status).toBe("created");
  expect(graph.mock.calls[0][0].input).toEqual(graph.mock.calls[1][0].input);
  expect(committed.size).toBe(1);
});

it("skips backfill and self notifications before making owner RPCs", async () => {
  expect(
    await receive({
      ...delivery,
      event: { ...delivery.event, mode: "backfill" },
    }),
  ).toEqual({ status: "suppressed" });
  expect(await receive({ ...delivery, account_id: alice })).toEqual({
    status: "suppressed",
  });
  expect(hooks.authorize).not.toHaveBeenCalled();
});

it("reads current attention under the lock and suppresses join history even for explicit mentions", async () => {
  state.read_through = 11;
  expect(await receive()).toEqual({ status: "suppressed" });
  state.read_through = 0;
  state.notify_after = 11;
  expect(await receive()).toEqual({ status: "suppressed" });
  expect(graph).not.toHaveBeenCalled();
});

it("supports follow without participation and does not turn participation into follow", async () => {
  const noMention = {
    ...delivery,
    event: { ...delivery.event, mentioned_account_ids: [] },
  };
  state.participating = true;
  expect(await receive(noMention)).toEqual({ status: "suppressed" });
  state.following = true;
  expect((await receive(noMention)).status).toBe("created");
  expect(graph.mock.calls[0][0].input.payload_json.notification_reason).toBe(
    "thread_follow",
  );
  state.muted = true;
  expect(await receive(noMention)).toEqual({ status: "suppressed" });
  expect((await receive()).status).toBe("created");
  expect(committed.size).toBe(2); // Different explicit reasons have distinct identities.
});

it.each(["project_id", "room_id", "thread_id"] as const)(
  "rejects mismatched canonical %s",
  async (field) => {
    authority[field] = "wrong-resource";
    await expect(receive()).rejects.toThrow("authority");
    expect(graph).not.toHaveBeenCalled();
  },
);

it.each([
  "/etc/private.chat",
  "/home/user/../private.chat",
  "/home/user/a.chat\n",
  "/home/user/a.txt",
])("rejects invalid locators: %s", async (chat_path) => {
  authority.chat_path = chat_path;
  await expect(receive()).rejects.toThrow("authority");
});

it("keeps batches bounded and replays committed prefixes after partial failure", async () => {
  await expect(
    receiveCollaborationNotificationBatch(Array(26).fill(delivery), hooks),
  ).rejects.toThrow("capacity");
  expect(hooks.authorize).not.toHaveBeenCalled();
  const second = { ...delivery, account_id: carol };
  (hooks.authorize as jest.Mock).mockImplementation(async (input) => {
    if (input.account_id === carol) throw Error("owner unavailable");
    return authority;
  });
  await expect(
    receiveCollaborationNotificationBatch([delivery, second], hooks),
  ).rejects.toThrow("owner unavailable");
  expect(committed.size).toBe(1);
  (hooks.authorize as jest.Mock).mockResolvedValue(authority);
  const results = await receiveCollaborationNotificationBatch(
    [delivery, second],
    hooks,
  );
  expect(results.map((result) => result.status)).toEqual([
    "duplicate",
    "created",
  ]);
  expect(committed.size).toBe(2);
});
