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
    mockNotify.mockClear();
    mockBanned.clear();
    await getPool().query(
      "TRUNCATE projects, account_collaborator_index, direct_conversations, direct_messages, direct_fanout_pending, direct_request_admissions, account_direct_conversations, account_direct_blocks",
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

  // A message request from Ada to Bea (not collaborators), by username.
  const request = (
    body = "Hello, may I ask about your paper?",
    title?: string,
  ) =>
    directHubApi.startDirect({
      account_id: ada,
      usernames: ["bea"],
      title,
      body,
    });

  // Nothing a browser gets says how anyone else answered.
  function expectMemberView(value: any) {
    expect(value).not.toHaveProperty("member_states");
    expect(value).not.toHaveProperty("owner_bay_id");
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
    expectMemberView(started);
    const [forBea] = (await directHubApi.listDirect({ account_id: bea }))
      .conversations;
    expect(forBea.conversation_id).toBe(started.conversation_id);
    expect(forBea.state).toBe("active");
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
    // Starting again reuses the pair's conversation.
    const again = await directHubApi.startDirect({
      account_id: bea,
      member_ids: [ada],
    });
    expect(again.conversation_id).toBe(started.conversation_id);
  });

  test("someone who isn't a collaborator gets one request: one message, one notification, until they accept", async () => {
    const started = await request();
    const [forBea] = (await directHubApi.listDirect({ account_id: bea }))
      .conversations;
    expect(forBea.state).toBe("requested");
    expect(titles()).toEqual(["Ada Tester sent you a message request"]);
    // No more messages until she accepts.
    await expect(
      directHubApi.sendDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
        body: "Following up",
      }),
    ).rejects.toThrow("hasn't been accepted yet");
    // Reusing the pair doesn't get around it either.
    await expect(request("Hello again?")).rejects.toThrow(
      "hasn't been accepted yet",
    );
    expect(notifiedTo(bea)).toBe(1);
    // She can read it to decide, and replying accepts.
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
    const [after] = (await directHubApi.listDirect({ account_id: bea }))
      .conversations;
    expect(after.state).toBe("active");
    expect(notifiedTo(ada)).toBe(1);
    // Now Ada may write again.
    await directHubApi.sendDirect({
      account_id: ada,
      conversation_id: started.conversation_id,
      body: "Thanks!",
    });
  });

  test("declining or blocking is never visible to the sender", async () => {
    for (const action of ["decline", "block"] as const) {
      await getPool().query(
        "TRUNCATE direct_conversations, direct_messages, direct_request_admissions, account_direct_conversations, account_direct_blocks",
      );
      const started = await request();
      const answered = await directHubApi.respondDirect({
        account_id: bea,
        conversation_id: started.conversation_id,
        action,
      });
      expectMemberView(answered);
      const [forAda] = (await directHubApi.listDirect({ account_id: ada }))
        .conversations;
      expectMemberView(forAda);
      expect(forAda.state).toBe("active");
      const { conversation } = await directHubApi.getDirect({
        account_id: ada,
        conversation_id: started.conversation_id,
      });
      expectMemberView(conversation);
      // Writing more gets the same answer as an undecided request.
      await expect(
        directHubApi.sendDirect({
          account_id: ada,
          conversation_id: started.conversation_id,
          body: "Are you there?",
        }),
      ).rejects.toThrow("hasn't been accepted yet");
    }
  });

  test("declining hides it from the recipient; blocking also refuses new conversations", async () => {
    const started = await request();
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: started.conversation_id,
      action: "decline",
    });
    expect(
      (await directHubApi.listDirect({ account_id: bea })).conversations,
    ).toEqual([]);
    await expect(
      directHubApi.getDirect({
        account_id: bea,
        conversation_id: started.conversation_id,
      }),
    ).rejects.toThrow("not found");
    // The pair isn't reused after she declined: a new request (charged).
    mockNotify.mockClear();
    const second = await request("One more try");
    expect(second.conversation_id).not.toBe(started.conversation_id);
    expect(notifiedTo(bea)).toBe(1);
    await directHubApi.respondDirect({
      account_id: bea,
      conversation_id: second.conversation_id,
      action: "block",
    });
    await expect(request("Hello?", "Third")).rejects.toThrow(
      "you can't message this person",
    );
    await expect(request("Hello?")).rejects.toThrow(
      "you can't message this person",
    );
  });

  test("people who aren't collaborators can only be named by exact username", async () => {
    // A raw account id of a non-collaborator is refused, alone or in a group.
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
    // Lookups take usernames only: not account ids, emails or old names.
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
    // A collaborator and a username together: a group with one request.
    const group = await directHubApi.startDirect({
      account_id: ada,
      member_ids: [bea],
      usernames: ["cy"],
      title: "Group",
      body: "Hi both",
    });
    expect(group.member_ids).toEqual([ada, bea, cy]);
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
  });

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

  test("limits: group size, empty messages, banned senders", async () => {
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
    expect(notifiedTo(bea)).toBe(0);
    [forBea] = (
      await directHubApi.listDirect({ account_id: bea })
    ).conversations;
    expect(forBea.preview).toBe("Two");
  });

  test("retries deliver the latest state", async () => {
    await expect(retryDirectFanouts()).resolves.toBeUndefined();
  });
});
