import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { closePglite } from "@cocalc/database/pglite";
import { SCHEMA } from "@cocalc/util/db-schema";

const mockNotify = jest.fn(async (_opts: any, _db?: any) => {});
const mockBanned = new Set<string>();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
const mockHomes: Record<string, string> = {};
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async ({ account_id }) => ({
    home_bay_id: mockHomes[account_id] ?? "bay-0",
  }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
const mockPublish = jest.fn(async (_opts: any) => {});
jest.mock("@cocalc/server/notifications/feed", () => ({
  publishProjectedNotificationFeedUpdatesBestEffort: (opts: any) =>
    mockPublish(opts),
}));
jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraphInTransaction: ({ db, input }: any) =>
    mockNotify(input, db),
  resolveNotificationTargetHomeBays: async ({ account_ids }) =>
    Object.fromEntries(account_ids.map((id: string) => [id, "bay-0"])),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: async (ids: string[]) =>
    ids.map((account_id) => ({
      account_id,
      first_name: account_id.startsWith("aaaa") ? "Ada" : "Bea",
      last_name: "Tester",
    })),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: (id: string) => mockBanned.has(id),
}));
const mockUsers: Record<
  string,
  { account_id: string; redirect?: boolean; username?: string }
> = {
  bea: { account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  cy: { account_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  // An old name that now redirects to Bea's current one.
  oldbea: {
    account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    redirect: true,
    username: "bea",
  },
};
jest.mock("@cocalc/server/accounts/usernames", () => ({
  resolveUsernameOwner: async (name: string) => {
    const user = mockUsers[name];
    if (user == null) throw Error("no such user");
    return {
      account_id: user.account_id,
      username: user.username ?? name,
      redirect: !!user.redirect,
    };
  },
}));
// The account's membership tier usage limits ({} = the tier sets none).
let mockTierLimits: Record<string, number> = {};
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async (account_id: string) => ({ account_id }),
}));
jest.mock("@cocalc/server/membership/effective-limits", () => ({
  getEffectiveMembershipUsageLimits: () => ({ ...mockTierLimits }),
}));

import { directControl, directHubApi, retryDirectFanouts } from "./direct";
import * as directDb from "@cocalc/database/postgres/direct-conversations";
import {
  clearDirectFanout,
  createDirectConversationRecord,
  deleteDirectMessage as deleteDirectMessageRecord,
  getDirectConversationRecord,
  pendingDirectFanouts,
  upsertDirectIndex,
} from "@cocalc/database/postgres/direct-conversations";
import { directPairKey } from "@cocalc/util/direct-conversations";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
const ada = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bea = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cy = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const project_id = "11111111-1111-4111-8111-111111111111";

const titles = () =>
  mockNotify.mock.calls.map(([opts]) => opts.payload_json.title);
const notifiedTo = (id: string) =>
  mockNotify.mock.calls.filter(
    ([opts]) => opts.targets[0].target_account_id === id,
  ).length;

describeDb("direct conversations", () => {
  beforeAll(async () => {
    const tables = [
      "accounts",
      "projects",
      "account_collaborator_index",
      "account_project_index",
      "notification_events",
      "notification_targets",
      "notification_target_outbox",
      "notification_email_outbox",
      "account_notification_index",
      "account_direct_deleted_messages",
      "direct_conversations",
      "direct_messages",
      "direct_fanout_pending",
      "direct_request_admissions",
      "account_direct_conversations",
      "account_direct_blocks",
    ];
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  }, 30000);
  afterAll(async () => {
    await closePglite();
  });
  beforeEach(async () => {
    for (const id of Object.keys(mockHomes)) delete mockHomes[id];
    mockNotify.mockReset().mockResolvedValue(undefined);
    mockBanned.clear();
    mockTierLimits = {};
    await getPool().query(
      "TRUNCATE accounts, projects, account_collaborator_index, account_project_index, notification_events, notification_targets, notification_target_outbox, notification_email_outbox, account_notification_index, account_direct_deleted_messages, direct_conversations, direct_messages, direct_fanout_pending, direct_request_admissions, account_direct_conversations, account_direct_blocks",
    );
    // Each one homed here: direct-message state is written only on its
    // owner's home bay (the account-rehome fence checks).
    for (const account_id of [ada, bea, cy]) {
      await getPool().query(
        "INSERT INTO accounts (account_id, created, home_bay_id) VALUES ($1, NOW(), NULL)",
        [account_id],
      );
    }
  });

  async function shareProject(owning_bay_id: string | null = null) {
    await getPool().query(
      "INSERT INTO projects (project_id, users, owning_bay_id) VALUES ($1, $2, $3)",
      [
        project_id,
        JSON.stringify({
          [ada]: { group: "owner" },
          [bea]: { group: "collaborator" },
        }),
        owning_bay_id,
      ],
    );
  }

  // A message request from Ada to Bea (not collaborators), by username.
  const request = (
    body: string | null = "Hello, may I ask about your paper?",
    title?: string,
  ) =>
    directHubApi.startDirect({
      account_id: ada,
      usernames: ["bea"],
      title,
      body,
    });

  const listFor = async (account_id: string) =>
    (await directHubApi.listDirect({ account_id })).conversations;

  // Nothing a browser gets says how anyone else answered.
  function expectMemberView(value: any) {
    expect(value).not.toHaveProperty("member_states");
    expect(value).not.toHaveProperty("owner_bay_id");
    expect(value).not.toHaveProperty("revision");
  }

  const NOT_ACCEPTED = "hasn't been accepted yet";

  test("collaborators message each other directly; each is notified of the other's messages", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Hi Bea",
    });
    expect(started.state).toBe("active");
    expect(started.member_ids).toEqual([ada, bea]);
    expect(started.preview).toBe("Hi Bea");
    expectMemberView(started);
    const [forBea] = await listFor(bea);
    expect(forBea.conversation_id).toBe(started.conversation_id);
    expect(titles()).toEqual(["Message from Ada Tester"]);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({
      kind: "account_notice",
      source_project_id: null,
      payload_json: {
        notice_type: "direct_message",
        conversation_id: started.conversation_id,
      },
    });
    // Opened by clicking the notification, in the app: no separate link.
    expect(mockNotify.mock.calls[0][0].payload_json).not.toHaveProperty(
      "action_link",
    );
    await directHubApi.sendDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      body: "Hi Ada",
    });
    expect(notifiedTo(ada)).toBe(1);
    const { messages, conversation } = await directHubApi.getDirect({
      account_id: ada,
      conversation_id: started.conversation_id,
    });
    expectMemberView(conversation);
    expect(messages.map((m) => [m.sender_id, m.body])).toEqual([
      [ada, "Hi Bea"],
      [bea, "Hi Ada"],
    ]);
    const again = await directHubApi.startDirect({
      account_id: bea,
      member_ids: [ada],
    });
    expect(again.conversation_id).toBe(started.conversation_id);
  });

  test("a request is one message and one notification until accepted; replying accepts", async () => {
    const started = await request();
    const [forBea] = await listFor(bea);
    expect(forBea.state).toBe("requested");
    expect(titles()).toEqual(["Ada Tester sent you a message request"]);
    await expect(
      directHubApi.sendDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
        body: "Following up",
      }),
    ).rejects.toThrow(NOT_ACCEPTED);
    // Starting again is the same conversation, with the same rule.
    await expect(request("Hello again?")).rejects.toThrow(NOT_ACCEPTED);
    expect(notifiedTo(bea)).toBe(1);
    const { messages } = await directHubApi.getDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
    });
    expect(messages).toHaveLength(1);
    await directHubApi.sendDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      body: "Sure",
    });
    expect((await listFor(bea))[0].state).toBe("active");
    expect(notifiedTo(ada)).toBe(1);
    await directHubApi.sendDirect({
      account_id: ada,
      conversation_id: started.conversation_id,
      body: "Thanks!",
    });
  });

  test("concurrent sends to an empty request: exactly one gets through", async () => {
    const started = await request(null);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        directHubApi.sendDirect({
          account_id: ada,
          conversation_id: started.conversation_id,
          body: `Try ${i}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM direct_messages WHERE conversation_id = $1",
      [started.conversation_id],
    );
    expect(rows[0].n).toBe(1);
  });

  test("a group holds only its first message until every request is accepted", async () => {
    await shareProject();
    const group = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      usernames: ["cy"],
      title: "Group",
      body: "Hi both",
    });
    expect(group.member_ids).toEqual([ada, bea, cy]);
    for (const sender of [ada, bea]) {
      await expect(
        directHubApi.sendDirect({
          account_id: sender,
          conversation_id: group.conversation_id,
          body: "More",
        }),
      ).rejects.toThrow(NOT_ACCEPTED);
    }
    await directHubApi.respondDirect({
      account_id: cy,
      conversation_id: group.conversation_id,
      action: "accept",
    });
    await directHubApi.sendDirect({
      account_id: bea,
      conversation_id: group.conversation_id,
      body: "Now we can talk",
    });
  });

  test("declining or blocking is never visible to the sender", async () => {
    for (const action of ["decline", "block"] as const) {
      await getPool().query(
        "TRUNCATE direct_conversations, direct_messages, direct_fanout_pending, direct_request_admissions, account_direct_conversations, account_direct_blocks",
      );
      const started = await request();
      const [before] = await listFor(ada);
      const answered = await directHubApi.respondDirect({
        account_id: bea,
        conversation_id: started.conversation_id,
        action,
      });
      expectMemberView(answered);
      const [forAda] = await listFor(ada);
      expectMemberView(forAda);
      expect(forAda.state).toBe("active");
      // What the sender's view reloads on doesn't move either.
      expect(forAda.messages_version).toBe(before.messages_version);
      const { conversation } = await directHubApi.getDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
      });
      expectMemberView(conversation);
      await expect(
        directHubApi.sendDirect({
          account_id: ada,
          conversation_id: started.conversation_id,
          body: "Are you there?",
        }),
      ).rejects.toThrow(NOT_ACCEPTED);
    }
  });

  test("after a decline the pair keeps its one conversation; the recipient can still start talking", async () => {
    const started = await request();
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      action: "decline",
    });
    expect(await listFor(bea)).toEqual([]);
    mockNotify.mockClear();
    await expect(request("One more try")).rejects.toThrow(NOT_ACCEPTED);
    expect(notifiedTo(bea)).toBe(0);
    // Bea changes her mind: the same conversation, back in her list.
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      action: "accept",
    });
    expect((await listFor(bea))[0].conversation_id).toBe(
      started.conversation_id,
    );
  });

  test("a block refuses new conversations, and a request already in flight is never recorded", async () => {
    const started = await request();
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      action: "block",
    });
    await expect(request("Hello?", "Another topic")).rejects.toThrow(
      "you can't message this person",
    );
    // A request created past the check (the race): Bea's home refuses it.
    mockNotify.mockClear();
    await createDirectConversationRecord({
      owner_bay_id: "bay-0",
      created_by: ada,
      member_ids: [ada, bea],
      member_states: { [ada]: "active", [bea]: "requested" },
      title: "Raced",
      pair_key: null,
      body: "Sneaky",
    });
    await getPool().query(
      "UPDATE direct_fanout_pending SET next_attempt = NOW()",
    );
    await retryDirectFanouts();
    expect(await listFor(bea)).toEqual([]);
    expect(notifiedTo(bea)).toBe(0);
  });

  test("opposite starts at the same time get the pair's one conversation", async () => {
    await shareProject();
    const [a, b] = await Promise.all([
      directHubApi.startDirect({ account_id: ada, member_ids: [bea] }),
      directHubApi.startDirect({ account_id: bea, member_ids: [ada] }),
    ]);
    expect(a.conversation_id).toBe(b.conversation_id);
  });

  test("a stale local copy of another bay's project doesn't make people collaborators", async () => {
    await shareProject("bay-9");
    const started = await directHubApi.startDirect({
      account_id: ada,
      usernames: ["bea"],
      body: "Hi",
    });
    expect((await listFor(bea))[0].state).toBe("requested");
    await expect(
      directHubApi.startDirect({ account_id: ada, member_ids: [bea] }),
    ).rejects.toThrow("by their username");
    void started;
  });

  test("another bay's project in the account's project index makes people collaborators", async () => {
    await getPool().query(
      "INSERT INTO account_project_index (account_id, project_id, owning_bay_id, users_summary) VALUES ($1, $2, 'bay-9', $3)",
      [
        ada,
        project_id,
        JSON.stringify({
          [ada]: { group: "collaborator" },
          [bea]: { group: "owner" },
        }),
      ],
    );
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Hi",
    });
    expect(started.state).toBe("active");
    expect((await listFor(bea))[0].state).toBe("active");
  });

  test("an older revision arriving late can't undo a newer answer", async () => {
    const started = await request();
    const before = await getDirectConversationRecord(
      started.conversation_id,
      "bay-0",
    );
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      action: "decline",
    });
    await upsertDirectIndex({ account_id: bea, conversation: before! });
    expect(await listFor(bea)).toEqual([]);
  });

  test("while an account is being rehomed, its direct-message state takes no writes; a delivery waits and lands afterwards", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Hi Bea",
    });
    const conversation_id = started.conversation_id;
    // A rehome of Bea is running (the canonical fence reads this table).
    await getPool().query(
      `CREATE TABLE IF NOT EXISTS account_rehome_operations (
         op_id UUID, account_id UUID, source_bay_id TEXT, dest_bay_id TEXT,
         stage TEXT, status TEXT, created_at TIMESTAMP)`,
    );
    await getPool().query(
      `INSERT INTO account_rehome_operations
         VALUES ($1, $2, 'bay-0', 'bay-1', 'source_flipped', 'running', NOW())`,
      [randomUUID(), bea],
    );
    try {
      const refused = /account rehome .* is running/;
      // Ada can still write: her message is kept for Bea's new home.
      await directHubApi.sendDirect({
        account_id: ada,
        conversation_id,
        body: "during the move",
      });
      expect((await listFor(bea))[0].preview).toBe("Hi Bea");
      const { rows: pending } = await getPool().query(
        "SELECT count(*)::int AS n FROM direct_fanout_pending WHERE account_id = $1",
        [bea],
      );
      expect(pending[0].n).toBe(1);
      // Nothing of Bea's changes meanwhile: blocks, settings, read state, a
      // request's charge, a deleted message's tombstone.
      await expect(
        directControl.block({ account_id: bea, blocked_account_id: cy }),
      ).rejects.toThrow(refused);
      await expect(
        directControl.setPersonal({
          account_id: bea,
          conversation_id,
          patch: { pinned: true },
        }),
      ).rejects.toThrow(refused);
      await expect(
        directControl.markRead({
          account_id: bea,
          conversation_id,
          read_through: Date.now(),
        }),
      ).rejects.toThrow(refused);
      await expect(
        directDb.admitDirectRequest({
          account_id: bea,
          conversation_id: randomUUID(),
          recipients: 1,
          requests_per_day: 20,
          recipients_per_day: 40,
        }),
      ).rejects.toThrow(refused);
      await expect(
        directDb.recordDirectMessageDeletion({
          account_id: bea,
          message_id: randomUUID(),
        }),
      ).rejects.toThrow(refused);
      const { rows: written } = await getPool().query(
        `SELECT (SELECT count(*) FROM account_direct_blocks WHERE account_id = $1)::int AS blocks,
                (SELECT count(*) FROM direct_request_admissions WHERE account_id = $1)::int AS admissions,
                (SELECT count(*) FROM account_direct_deleted_messages WHERE account_id = $1)::int AS tombstones`,
        [bea],
      );
      expect(written[0]).toEqual({ blocks: 0, admissions: 0, tombstones: 0 });
    } finally {
      await getPool().query(
        "UPDATE account_rehome_operations SET status = 'completed' WHERE account_id = $1",
        [bea],
      );
    }
    // Once the move is over, the delivery is retried (at the account's home).
    await getPool().query(
      "UPDATE direct_fanout_pending SET next_attempt = NOW()",
    );
    await retryDirectFanouts();
    expect((await listFor(bea))[0].preview).toBe("during the move");
    await getPool().query("DROP TABLE account_rehome_operations");
  });

  test("a failed notification is retried until it is created, and only once", async () => {
    await shareProject();
    mockNotify.mockRejectedValueOnce(Error("notifications down"));
    await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Hi",
    });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM direct_fanout_pending WHERE account_id = $1",
      [bea],
    );
    expect(rows[0].n).toBe(1);
    await getPool().query(
      "UPDATE direct_fanout_pending SET next_attempt = NOW()",
    );
    await retryDirectFanouts();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    await getPool().query(
      "UPDATE direct_fanout_pending SET next_attempt = NOW()",
    );
    await retryDirectFanouts();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    const { rows: left } = await getPool().query(
      "SELECT count(*)::int AS n FROM direct_fanout_pending",
    );
    expect(left[0].n).toBe(0);
  });

  test("people who aren't collaborators can only be named by exact username", async () => {
    await expect(
      directHubApi.startDirect({
        account_id: ada,
        member_ids: [cy],
        body: "Hi",
      }),
    ).rejects.toThrow("by their username");
    await shareProject();
    await expect(
      directHubApi.startDirect({
        account_id: ada,
        member_ids: [bea, cy],
        body: "Hi",
      }),
    ).rejects.toThrow("by their username");
    for (const username of [
      cy,
      cy.replace(/-/g, ""),
      "cy@example.com",
      "oldbea",
    ]) {
      await expect(
        directHubApi.findDirectRecipient({ account_id: ada, username }),
      ).resolves.toBeNull();
    }
    await expect(
      directHubApi.findDirectRecipient({ account_id: ada, username: "@cy" }),
    ).resolves.toEqual({ account_id: cy, name: "Bea Tester", username: "cy" });
    await expect(
      directHubApi.startDirect({
        account_id: ada,
        usernames: [cy],
        body: "Hi",
      }),
    ).rejects.toThrow("no one has the username");
  });

  test("a lost reply keeps the request's charge; only proof of creating nothing releases one", async () => {
    const admissions = async () =>
      (
        await getPool().query(
          "SELECT count(*)::int AS n FROM direct_request_admissions",
        )
      ).rows[0].n;
    const conversations = async () =>
      (
        await getPool().query(
          "SELECT count(*)::int AS n FROM direct_conversations",
        )
      ).rows[0].n;
    const create = directControl.create;
    // The owner commits, then the reply is lost (a timeout after commit).
    const lost = jest
      .spyOn(directControl, "create")
      .mockImplementationOnce(async (opts) => {
        await create(opts);
        throw Error("timeout");
      });
    await expect(request("Hi")).rejects.toThrow("timeout");
    expect(await conversations()).toBe(1);
    expect(await admissions()).toBe(1);
    // The person tries again: the pair's conversation exists (a different
    // id), so this attempt's own charge is released; the first stays.
    await expect(request("Hi again")).rejects.toThrow(NOT_ACCEPTED);
    expect(await conversations()).toBe(1);
    expect(await admissions()).toBe(1);
    lost.mockRestore();

    // A transport retry of the same create reports it as existing: still
    // this attempt's, so its charge stays.
    await getPool().query(
      "TRUNCATE direct_conversations, direct_messages, direct_fanout_pending, direct_request_admissions, account_direct_conversations",
    );
    const retried = jest
      .spyOn(directControl, "create")
      .mockImplementationOnce(async (opts) => {
        await create(opts);
        return await create(opts);
      });
    await request("Hello");
    expect(await conversations()).toBe(1);
    expect(await admissions()).toBe(1);
    retried.mockRestore();
  });

  test("the daily request quota isn't refunded by answers and holds under concurrency", async () => {
    for (let i = 0; i < 20; i++) {
      const started = await request(`Request ${i}`, `Topic ${i}`);
      await directHubApi.respondDirect({
        account_id: bea,
        conversation_id: started.conversation_id,
        action: "decline",
      });
    }
    await expect(request("One too many", "Topic 20")).rejects.toThrow(
      "daily limit on message requests",
    );
    await getPool().query("TRUNCATE direct_request_admissions");
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        request(`Burst ${i}`, `Burst topic ${i}`),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
  }, 30000);

  test("the membership tier sets the daily request and recipient limits", async () => {
    // Requests per day.
    mockTierLimits = { direct_message_requests_per_day: 2 };
    await request("One", "Topic 1");
    await request("Two", "Topic 2");
    await expect(request("Three", "Topic 3")).rejects.toThrow(
      "(2 requests to at most 40 people)",
    );
    // People reached per day: a group request counts each of them.
    await getPool().query("TRUNCATE direct_request_admissions");
    mockTierLimits = { direct_message_request_recipients_per_day: 2 };
    await directHubApi.startDirect({
      account_id: ada,
      usernames: ["bea", "cy"],
      title: "Group",
      body: "Hi both",
    });
    await expect(request("One more person", "Topic 4")).rejects.toThrow(
      "(20 requests to at most 2 people)",
    );
    // A tier may turn requests off; collaborators are unaffected.
    await getPool().query("TRUNCATE direct_request_admissions");
    mockTierLimits = { direct_message_requests_per_day: 0 };
    await expect(request("Hello", "Topic 5")).rejects.toThrow(
      "daily limit on message requests",
    );
    await shareProject();
    await expect(
      directHubApi.startDirect({
        account_id: ada,
        member_ids: [bea],
        body: "Hi collaborator",
      }),
    ).resolves.toMatchObject({ state: "active" });
  });

  test("notifications carry plain text, never Markdown", async () => {
    await request(
      "![probe](https://attacker.example/pixel) and [link](https://x.example) <img src=x> http://2130706433:3000/admin [x] \\(x\\) $y$",
    );
    const payload = mockNotify.mock.calls[0][0].payload_json;
    // No Markdown at all: the notification row and email show body_text
    // literally (see notification-row-plain-text.test.tsx).
    expect(payload.body_markdown).toBeUndefined();
    expect(payload.body_text).not.toContain("https://attacker.example");
    expect(payload.body_text).not.toContain("<img");
    expect(payload.body_text).toContain("[image]");
    expect(payload.body_text).toContain(
      "http://2130706433:3000/admin [x] \\(x\\) $y$",
    );
  });

  test("only members can read or write", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Private",
    });
    for (const call of [
      () =>
        directHubApi.getDirect({
          account_id: cy,
          conversation_id: started.conversation_id,
        }),
      () =>
        directHubApi.sendDirect({
          account_id: cy,
          conversation_id: started.conversation_id,
          body: "Let me in",
        }),
    ]) {
      await expect(call()).rejects.toThrow("not found");
    }
  });

  test("oversized recipient lists are refused before any lookup", async () => {
    await expect(
      directHubApi.startDirect({
        account_id: ada,
        member_ids: Array.from({ length: 1000 }, () => bea),
      }),
    ).rejects.toThrow("at most 8");
    await expect(
      directHubApi.startDirect({
        account_id: ada,
        usernames: Array.from({ length: 1000 }, () => "bea"),
      }),
    ).rejects.toThrow("at most 8");
  });

  test("the owner validates a create request on its own", async () => {
    const base = {
      conversation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      account_id: ada,
      member_ids: [ada, bea],
      member_states: { [ada]: "active", [bea]: "requested" } as any,
      title: "Group",
      pair_key: null,
      body: "Hi",
    };
    // The starter isn't a member (or not first).
    await expect(
      directControl.create({ ...base, member_ids: [bea, cy] }),
    ).rejects.toThrow("invalid members");
    // States must cover exactly the members, the starter active.
    await expect(
      directControl.create({
        ...base,
        member_states: { [ada]: "requested", [bea]: "active" },
      }),
    ).rejects.toThrow("invalid member states");
    await expect(
      directControl.create({ ...base, member_states: { [ada]: "active" } }),
    ).rejects.toThrow("invalid member states");
    // A group belongs on its starter's home bay.
    mockHomes[ada] = "bay-1";
    await expect(directControl.create(base)).rejects.toThrow(
      "stale account-home route",
    );
    // A pair on its fixed bay only.
    await expect(
      directControl.create({
        ...base,
        title: null,
        pair_key: "not-a-pair",
      }),
    ).rejects.toThrow("invalid pair");
    // Whether it's a pair is derived from the canonical envelope, never
    // taken from the caller: two people and no title is a pair, with its key.
    const pair_key = directPairKey(ada, bea);
    await expect(
      directControl.create({ ...base, title: null, pair_key: null }),
    ).rejects.toThrow("invalid pair");
    await expect(directControl.create({ ...base, pair_key })).rejects.toThrow(
      "invalid pair",
    );
    await expect(
      directControl.create({ ...base, title: "  Group  " }),
    ).rejects.toThrow("invalid title");
    // A pair belongs on the smaller account's home bay only.
    mockHomes[ada] = "bay-1";
    mockHomes[bea] = "bay-1";
    await expect(
      directControl.create({ ...base, title: null, pair_key }),
    ).rejects.toThrow("stale pair route");
    delete mockHomes[ada];
    delete mockHomes[bea];
    // Canonical member ids are what is stored, whatever the caller's casing.
    const { created, conversation } = await directControl.create({
      ...base,
      member_ids: [ada, bea.toUpperCase()],
      title: null,
      pair_key,
    });
    expect(created).toBe(true);
    expect(conversation.member_ids).toEqual([ada, bea]);
  });

  test("limits: empty messages, banned senders", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
    });
    await expect(
      directHubApi.sendDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
        body: "   ",
      }),
    ).rejects.toThrow("empty");
    mockBanned.add(ada);
    await expect(
      directHubApi.sendDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
        body: "spam",
      }),
    ).rejects.toThrow("you can't message this person");
  });

  test("read state and mute are per member", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "One",
    });
    let [forBea] = await listFor(bea);
    expect(forBea.last_read).toBeNull();
    await directHubApi.markDirectRead({
      account_id: bea,
      conversation_id: started.conversation_id,
      read_through: forBea.last_activity,
    });
    await directHubApi.setDirectState({
      account_id: bea,
      conversation_id: started.conversation_id,
      patch: { muted: true },
    });
    [forBea] = await listFor(bea);
    expect(forBea.last_read).toBe(forBea.last_activity);
    expect(forBea.muted).toBe(true);
    mockNotify.mockClear();
    await directHubApi.sendDirect({
      account_id: ada,
      conversation_id: started.conversation_id,
      body: "Two",
    });
    expect(notifiedTo(bea)).toBe(0);
    [forBea] = await listFor(bea);
    expect(forBea.preview).toBe("Two");
  });

  test("pin and archive are each member's own, and survive new messages", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "One",
    });
    const conversation_id = started.conversation_id;
    await directHubApi.setDirectState({
      account_id: bea,
      conversation_id,
      patch: { pinned: true, archived_through: Date.now() + 3_600_000 },
    });
    let [forBea] = await listFor(bea);
    expect(forBea.pinned).toBe(true);
    // Archiving can't reach into the future: at most now.
    expect(forBea.archived_through).not.toBeNull();
    expect(forBea.archived_through!).toBeLessThanOrEqual(Date.now());
    const archivedThrough = forBea.archived_through;
    // A new message (a new snapshot from the owner) keeps both.
    await directHubApi.sendDirect({
      account_id: ada,
      conversation_id,
      body: "Two",
    });
    [forBea] = await listFor(bea);
    expect(forBea.pinned).toBe(true);
    expect(forBea.archived_through).toBe(archivedThrough);
    expect(forBea.last_activity).toBeGreaterThan(archivedThrough!);
    // Archive hides nothing for anyone else, and deletes nothing.
    const [forAda] = await listFor(ada);
    expect(forAda.pinned).toBe(false);
    expect(forAda.archived_through).toBeNull();
    const { messages } = await directHubApi.getDirect({
      account_id: bea,
      conversation_id,
    });
    expect(messages.map((m) => m.body)).toEqual(["One", "Two"]);
    // Show everything again; unknown, ill-typed or malformed settings are
    // refused, not ignored.
    await directHubApi.setDirectState({
      account_id: bea,
      conversation_id,
      patch: { archived_through: null },
    });
    [forBea] = await listFor(bea);
    expect(forBea.archived_through).toBeNull();
    await expect(
      directHubApi.setDirectState({
        account_id: bea,
        conversation_id,
        patch: { pinned: "yes" } as any,
      }),
    ).rejects.toThrow("invalid pinned");
    for (const [patch, error] of [
      [{ pinned: true, owner_bay_id: "bay-9" }, "invalid field: owner_bay_id"],
      [{ bogus: true }, "invalid field: bogus"],
      [[{ pinned: true }], "invalid patch"],
      ["pinned", "invalid patch"],
      [null, "invalid patch"],
    ] as const) {
      await expect(
        directHubApi.setDirectState({
          account_id: bea,
          conversation_id,
          patch: patch as any,
        }),
      ).rejects.toThrow(error);
    }
    // Nothing was changed by the refused patches.
    [forBea] = await listFor(bea);
    expect(forBea.pinned).toBe(true);
    // Only members.
    await expect(
      directHubApi.setDirectState({
        account_id: cy,
        conversation_id,
        patch: { pinned: true },
      }),
    ).rejects.toThrow();
  });

  test("a sender deletes their own message for everyone; nobody else can", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Oops, wrong paste",
    });
    const conversation_id = started.conversation_id;
    const reply = await directHubApi.sendDirect({
      account_id: bea,
      conversation_id,
      body: "What was that?",
    });
    const first = (
      await directHubApi.getDirect({ account_id: ada, conversation_id })
    ).messages[0];
    // Not yours: refused, for the other member too.
    await expect(
      directHubApi.deleteDirectMessage({
        account_id: bea,
        conversation_id,
        message_id: first.message_id,
      }),
    ).rejects.toThrow("message not found");
    await directHubApi.deleteDirectMessage({
      account_id: ada,
      conversation_id,
      message_id: first.message_id,
    });
    const { messages } = await directHubApi.getDirect({
      account_id: bea,
      conversation_id,
    });
    expect(messages[0]).toMatchObject({
      message_id: first.message_id,
      body: "",
      deleted: true,
    });
    expect(messages[1].body).toBe("What was that?");
    // Deleting the latest message shows the one before it in the list.
    await directHubApi.deleteDirectMessage({
      account_id: bea,
      conversation_id,
      message_id: reply.message_id,
    });
    const [forAda] = await listFor(ada);
    expect(forAda.preview).toBe("");
    // Once deleted, it can't be deleted again.
    await expect(
      directHubApi.deleteDirectMessage({
        account_id: ada,
        conversation_id,
        message_id: first.message_id,
      }),
    ).rejects.toThrow("message not found");
  });

  test("deleting a message takes its text out of the recipient's notice, and cancels email not yet sent", async () => {
    await shareProject();
    mockPublish.mockClear();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "my password is hunter2",
    });
    // The notice Bea got, as the notification pipeline stores it on her
    // home bay (event, target, outbox, her list and a queued email).
    const call = mockNotify.mock.calls.find(
      (c) => c[0].targets[0].target_account_id === bea,
    )![0];
    const dedupe_key = call.targets[0].dedupe_key;
    const summary = call.payload_json;
    expect(summary.body_text).toBe("my password is hunter2");
    const event_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const notification_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const db = getPool();
    await db.query(
      "INSERT INTO notification_events (event_id, kind, payload_json, created_at) VALUES ($1, 'account_notice', $2, NOW())",
      [event_id, JSON.stringify(summary)],
    );
    await db.query(
      "INSERT INTO notification_targets (event_id, target_account_id, target_home_bay_id, notification_id, dedupe_key, created_at) VALUES ($1, $2, 'bay-0', $3, $4, NOW())",
      [event_id, bea, notification_id, dedupe_key],
    );
    await db.query(
      "INSERT INTO notification_target_outbox (outbox_id, target_home_bay_id, target_account_id, notification_id, kind, event_type, payload_json, created_at) VALUES (gen_random_uuid(), 'bay-0', $1, $2, 'account_notice', 'notification.upserted', $3, NOW())",
      [bea, notification_id, JSON.stringify({ summary })],
    );
    await db.query(
      "INSERT INTO account_notification_index (account_id, notification_id, kind, summary, read_state, revision, created_at, updated_at) VALUES ($1, $2, 'account_notice', $3, '{}', 1, NOW(), NOW())",
      [bea, notification_id, JSON.stringify(summary)],
    );
    await db.query(
      "INSERT INTO notification_email_outbox (email_id, notification_id, target_account_id, status, summary_json, scheduled_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'queued', $3, NOW() + INTERVAL '1 hour', NOW(), NOW())",
      [
        notification_id,
        bea,
        JSON.stringify({
          summary,
          event_payload: summary,
          projection_notification_id: notification_id,
        }),
      ],
    );
    const first = (
      await directHubApi.getDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
      })
    ).messages[0];
    await directHubApi.deleteDirectMessage({
      account_id: ada,
      conversation_id: started.conversation_id,
      message_id: first.message_id,
    });
    // No copy keeps the text, anywhere.
    for (const [table, column] of [
      ["notification_events", "payload_json"],
      ["notification_target_outbox", "payload_json"],
      ["account_notification_index", "summary"],
      ["notification_email_outbox", "summary_json"],
    ]) {
      const { rows } = await db.query(`SELECT ${column} AS v FROM ${table}`);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].v)).not.toContain("hunter2");
      expect(JSON.stringify(rows[0].v)).toContain("Message deleted");
    }
    // The email that wasn't sent yet never will be.
    const { rows: emails } = await db.query(
      "SELECT status FROM notification_email_outbox",
    );
    expect(emails[0].status).toBe("skipped_preference");
    // Her open notification list hears of the change.
    const { rows: listed } = await db.query(
      "SELECT revision FROM account_notification_index",
    );
    expect(Number(listed[0].revision)).toBe(2);
    expect(mockPublish).toHaveBeenCalledWith({
      account_id: bea,
      reason: "projected_upsert",
      notification_ids: [notification_id],
    });
  });

  test("a deletion queued while an earlier one is being delivered is never acknowledged with it", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "first secret",
    });
    const conversation_id = started.conversation_id;
    const second = await directHubApi.sendDirect({
      account_id: ada,
      conversation_id,
      body: "second secret",
    });
    const first = (
      await directHubApi.getDirect({ account_id: ada, conversation_id })
    ).messages[0];
    // Deletion A is queued; delivery reads Bea's pending row ([A]).
    await deleteDirectMessageRecord({
      conversation_id,
      message_id: first.message_id,
      sender_id: ada,
      owner_bay_id: "bay-0",
    });
    const [read] = (await pendingDirectFanouts({ conversation_id })).filter(
      (row) => row.account_id === bea,
    );
    expect(read.deleted_message_ids).toEqual([first.message_id]);
    // Meanwhile deletion B lands on the same row.
    await deleteDirectMessageRecord({
      conversation_id,
      message_id: second.message_id,
      sender_id: ada,
      owner_bay_id: "bay-0",
    });
    const current = await getDirectConversationRecord(conversation_id, "bay-0");
    // Delivery acknowledges what it read, at the conversation's revision now.
    await clearDirectFanout({ ...read, revision: current!.revision });
    const [left] = (await pendingDirectFanouts({ conversation_id })).filter(
      (row) => row.account_id === bea,
    );
    // B is still owed to Bea's home bay.
    expect(left?.deleted_message_ids).toEqual(
      expect.arrayContaining([second.message_id]),
    );
  });

  // A notice as the notification pipeline stores it on Bea's home bay.
  async function seedNotice(
    dedupe_key: string,
    body_text: string,
    db: { query: (sql: string, params?: any[]) => Promise<any> } = getPool(),
  ) {
    const summary = { notice_type: "direct_message", body_text };
    const event_id = randomUUID();
    const notification_id = randomUUID();
    await db.query(
      "INSERT INTO notification_events (event_id, kind, payload_json, created_at) VALUES ($1, 'account_notice', $2, NOW())",
      [event_id, JSON.stringify(summary)],
    );
    await db.query(
      "INSERT INTO notification_targets (event_id, target_account_id, target_home_bay_id, notification_id, dedupe_key, created_at) VALUES ($1, $2, 'bay-0', $3, $4, NOW())",
      [event_id, bea, notification_id, dedupe_key],
    );
    await db.query(
      "INSERT INTO account_notification_index (account_id, notification_id, kind, summary, read_state, revision, created_at, updated_at) VALUES ($1, $2, 'account_notice', $3, '{}', 1, NOW(), NOW())",
      [bea, notification_id, JSON.stringify(summary)],
    );
  }
  const noticeTexts = async () =>
    (
      await getPool().query("SELECT summary FROM account_notification_index")
    ).rows.map((row) => row.summary.body_text);

  test("a delivery that read a message before it was deleted never notifies after the redaction", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
    });
    const conversation_id = started.conversation_id;
    const stale = await getDirectConversationRecord(conversation_id, "bay-0");
    const message = {
      message_id: randomUUID(),
      sender_id: ada,
      body: "a secret",
    };
    mockNotify.mockClear();
    // The deletion's delivery lands first (nothing to redact yet) ...
    await directControl.upsertIndex({
      account_id: bea,
      conversation: { ...stale!, revision: stale!.revision + 5 },
      deleted_message_ids: [message.message_id],
    });
    // ... then the stalled send delivery resumes with the message it read.
    await directControl.upsertIndex({
      account_id: bea,
      conversation: stale!,
      message,
    });
    expect(
      mockNotify.mock.calls.filter(
        (c) => c[0].targets[0].target_account_id === bea,
      ),
    ).toHaveLength(0);
  });

  test("a notice whose bookkeeping fails leaves no copy, and a later deletion keeps it that way", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
    });
    const conversation = await getDirectConversationRecord(
      started.conversation_id,
      "bay-0",
    );
    const message = {
      message_id: randomUUID(),
      sender_id: ada,
      body: "a secret",
    };
    // The notice graph is written (in the notify transaction) ...
    mockNotify.mockImplementation(async (input: any, db: any) => {
      if (input.targets[0].target_account_id !== bea) return;
      await seedNotice(
        input.targets[0].dedupe_key,
        input.payload_json.body_text,
        db,
      );
    });
    // ... and then its bookkeeping fails (or the process dies).
    const failing = jest
      .spyOn(directDb, "recordDirectNotified")
      .mockRejectedValueOnce(Error("connection lost"));
    await expect(
      directControl.upsertIndex({
        account_id: bea,
        conversation: conversation!,
        message,
      }),
    ).rejects.toThrow("connection lost");
    failing.mockRestore();
    // Nothing of it was committed.
    expect(await noticeTexts()).toEqual([]);
    // The deletion is delivered and acknowledged; the stale send delivery is
    // retried afterwards and must not create the notice.
    await directControl.upsertIndex({
      account_id: bea,
      conversation: { ...conversation!, revision: conversation!.revision + 5 },
      deleted_message_ids: [message.message_id],
    });
    await directControl.upsertIndex({
      account_id: bea,
      conversation: conversation!,
      message,
    });
    expect(await noticeTexts()).toEqual([]);
  });

  test("a notice committed before the deletion is redacted by it", async () => {
    await shareProject();
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
    });
    const conversation = await getDirectConversationRecord(
      started.conversation_id,
      "bay-0",
    );
    const message = {
      message_id: randomUUID(),
      sender_id: ada,
      body: "a secret",
    };
    mockNotify.mockImplementation(async (input: any, db: any) => {
      if (input.targets[0].target_account_id !== bea) return;
      await seedNotice(
        input.targets[0].dedupe_key,
        input.payload_json.body_text,
        db,
      );
    });
    await directControl.upsertIndex({
      account_id: bea,
      conversation: conversation!,
      message,
    });
    expect(await noticeTexts()).toEqual(["a secret"]);
    await directControl.upsertIndex({
      account_id: bea,
      conversation: { ...conversation!, revision: conversation!.revision + 5 },
      deleted_message_ids: [message.message_id],
    });
    expect(await noticeTexts()).toEqual(["Message deleted"]);
  });

  test("a deletion delivered while the request is blocked is still redacted", async () => {
    const started = await request("my phone number is 555-0100");
    const conversation = await getDirectConversationRecord(
      started.conversation_id,
      "bay-0",
    );
    const call = mockNotify.mock.calls.find(
      (c) => c[0].targets[0].target_account_id === bea,
    )![0];
    await seedNotice(call.targets[0].dedupe_key, call.payload_json.body_text);
    const first = (
      await directHubApi.getDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
      })
    ).messages[0];
    // Bea's block is on her home bay; the owner still says "requested".
    await getPool().query(
      "INSERT INTO account_direct_blocks (account_id, blocked_account_id, created) VALUES ($1, $2, NOW())",
      [bea, ada],
    );
    await directControl.upsertIndex({
      account_id: bea,
      conversation: { ...conversation!, revision: conversation!.revision + 5 },
      deleted_message_ids: [first.message_id],
    });
    expect(await noticeTexts()).toEqual(["Message deleted"]);
  });
});
