import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { closePglite } from "@cocalc/database/pglite";
import { SCHEMA } from "@cocalc/util/db-schema";

const mockNotify = jest.fn(async (_opts: any) => {});
const mockBanned = new Set<string>();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "bay-0" }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraph: (opts: any) => mockNotify(opts),
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
jest.mock("@cocalc/server/accounts/usernames", () => ({
  resolveUsernameOwner: async (name: string) => {
    if (name === "bea") {
      return {
        account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        username: "bea",
        redirect: false,
      };
    }
    throw Error("no such user");
  },
}));

import { directHubApi, retryDirectFanouts } from "./direct";

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
      "direct_conversations",
      "direct_messages",
      "direct_fanout_pending",
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
    mockNotify.mockClear();
    mockBanned.clear();
    await getPool().query(
      "TRUNCATE projects, account_collaborator_index, direct_conversations, direct_messages, direct_fanout_pending, account_direct_conversations, account_direct_blocks",
    );
  });

  async function shareProject() {
    await getPool().query(
      "INSERT INTO projects (project_id, users) VALUES ($1, $2)",
      [
        project_id,
        JSON.stringify({
          [ada]: { group: "owner" },
          [bea]: { group: "collaborator" },
        }),
      ],
    );
  }

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
    // Bea has it, unread, and was notified.
    const [forBea] = (await directHubApi.listDirect({ account_id: bea }))
      .conversations;
    expect(forBea.conversation_id).toBe(started.conversation_id);
    expect(forBea.state).toBe("active");
    expect(forBea.last_sender_id).toBe(ada);
    expect(titles()).toEqual(["Message from Ada Tester"]);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({
      kind: "account_notice",
      source_project_id: null,
      payload_json: {
        notice_type: "direct_message",
        action_link: `/people/messages/${started.conversation_id}`,
      },
    });
    // Bea replies; Ada (not Bea) is notified.
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
    expect(messages.map((m) => [m.sender_id, m.body])).toEqual([
      [ada, "Hi Bea"],
      [bea, "Hi Ada"],
    ]);
    expect(conversation.last_sender_id).toBe(bea);
    // Starting again reuses the pair's conversation.
    const again = await directHubApi.startDirect({
      account_id: bea,
      member_ids: [ada],
    });
    expect(again.conversation_id).toBe(started.conversation_id);
  });

  test("someone who isn't a collaborator gets one request, until they accept by replying", async () => {
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Hello, may I ask about your paper?",
    });
    const [forBea] = (await directHubApi.listDirect({ account_id: bea }))
      .conversations;
    expect(forBea.state).toBe("requested");
    expect(titles()).toEqual(["Ada Tester sent you a message request"]);
    // More messages before she accepts don't notify her again.
    await directHubApi.sendDirect({
      account_id: ada,
      conversation_id: started.conversation_id,
      body: "Following up",
    });
    expect(notifiedTo(bea)).toBe(1);
    // She can read it to decide, and replying accepts.
    const { messages } = await directHubApi.getDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
    });
    expect(messages).toHaveLength(2);
    await directHubApi.sendDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      body: "Sure",
    });
    const [after] = (await directHubApi.listDirect({ account_id: bea }))
      .conversations;
    expect(after.state).toBe("active");
    expect(notifiedTo(ada)).toBe(1);
  });

  test("declining hides it and stops notifications; blocking also stops new conversations", async () => {
    const started = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      body: "Hi",
    });
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      action: "decline",
    });
    expect(
      (await directHubApi.listDirect({ account_id: bea })).conversations,
    ).toEqual([]);
    mockNotify.mockClear();
    await directHubApi.sendDirect({
      account_id: ada,
      conversation_id: started.conversation_id,
      body: "Are you there?",
    });
    expect(notifiedTo(bea)).toBe(0);
    await expect(
      directHubApi.getDirect({
        account_id: bea,
        conversation_id: started.conversation_id,
      }),
    ).rejects.toThrow("not found");

    // A new request, blocked: Ada can't start another.
    const second = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      title: "Another topic",
      body: "Hi again",
    });
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: second.conversation_id,
      action: "block",
    });
    await expect(
      directHubApi.startDirect({
        account_id: ada,
        member_ids: [bea],
        title: "Third",
        body: "Hello?",
      }),
    ).rejects.toThrow("you can't message this person");
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

  test("limits: group size, empty messages, banned senders", async () => {
    const many = Array.from(
      { length: 8 },
      (_, i) => `dddddddd-dddd-4ddd-8ddd-00000000000${i}`,
    );
    await expect(
      directHubApi.startDirect({ account_id: ada, member_ids: many }),
    ).rejects.toThrow("at most 8");
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
    let [forBea] = (await directHubApi.listDirect({ account_id: bea }))
      .conversations;
    expect(forBea.last_read).toBeNull();
    await directHubApi.markDirectRead({
      account_id: bea,
      conversation_id: started.conversation_id,
      read_through: forBea.last_activity,
    });
    await directHubApi.setDirectMuted({
      account_id: bea,
      conversation_id: started.conversation_id,
      muted: true,
    });
    [forBea] = (
      await directHubApi.listDirect({ account_id: bea })
    ).conversations;
    expect(forBea.last_read).toBe(forBea.last_activity);
    expect(forBea.muted).toBe(true);
    mockNotify.mockClear();
    await directHubApi.sendDirect({
      account_id: ada,
      conversation_id: started.conversation_id,
      body: "Two",
    });
    // Muted: no notification, but the list still updates.
    expect(notifiedTo(bea)).toBe(0);
    [forBea] = (
      await directHubApi.listDirect({ account_id: bea })
    ).conversations;
    expect(forBea.preview).toBe("Two");
  });

  test("a username finds someone to message; other lookups find nothing", async () => {
    await expect(
      directHubApi.findDirectRecipient({ account_id: ada, username: "@bea" }),
    ).resolves.toEqual({ account_id: bea, name: "Bea Tester" });
    await expect(
      directHubApi.findDirectRecipient({
        account_id: ada,
        username: "bea@example.com",
      }),
    ).resolves.toBeNull();
  });

  test("retries deliver the latest state", async () => {
    await expect(retryDirectFanouts()).resolves.toBeUndefined();
  });
});
