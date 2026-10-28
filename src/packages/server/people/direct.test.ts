import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { closePglite } from "@cocalc/database/pglite";
import { SCHEMA } from "@cocalc/util/db-schema";

const mockNotify = jest.fn(async (_opts: any) => {});
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

import { directControl, directHubApi, retryDirectFanouts } from "./direct";
import {
  createDirectConversationRecord,
  getDirectConversationRecord,
  upsertDirectIndex,
} from "@cocalc/database/postgres/direct-conversations";

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
    await getPool().query(
      "TRUNCATE projects, account_collaborator_index, direct_conversations, direct_messages, direct_fanout_pending, direct_request_admissions, account_direct_conversations, account_direct_blocks",
    );
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
        action_link: `/people/messages/${started.conversation_id}`,
      },
    });
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
      const answered = await directHubApi.respondDirect({
        account_id: bea,
        conversation_id: started.conversation_id,
        action,
      });
      expectMemberView(answered);
      const [forAda] = await listFor(ada);
      expectMemberView(forAda);
      expect(forAda.state).toBe("active");
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
      "maximum number of message requests",
    );
    await getPool().query("TRUNCATE direct_request_admissions");
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        request(`Burst ${i}`, `Burst topic ${i}`),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
  }, 30000);

  test("notifications are plain text: nothing in them loads or renders", async () => {
    await request(
      "![probe](https://attacker.example/pixel) and [link](https://x.example) <img src=x>",
    );
    const body = mockNotify.mock.calls[0][0].payload_json.body_markdown;
    expect(body).not.toContain("https://attacker.example");
    expect(body).not.toContain("](");
    expect(body).not.toContain("<img");
    expect(body).toContain("\\[image\\]");
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
    await directHubApi.setDirectMuted({
      account_id: bea,
      conversation_id: started.conversation_id,
      muted: true,
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
});
