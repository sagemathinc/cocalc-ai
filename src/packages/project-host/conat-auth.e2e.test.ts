/*
A project-scoped agent on a project host, end to end: a real Conat server with
the project-host authorization and real clients.  The agent's client takes
its reply inbox from the server (as the CLI does), so request/reply to its
own project works; it cannot subscribe to its account's inbox, so it never
receives replies meant for the human.

pnpm test `pwd`/conat-auth.e2e.test.ts
*/

const mockVerifyProjectHostAuthToken = jest.fn();

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  verifyProjectHostAuthToken: (opts: any) =>
    mockVerifyProjectHostAuthToken(opts),
}));
jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: () => ({ users: { [ACCOUNT_ID]: { group: "collaborator" } } }),
}));
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./auth-public-key", () => ({
  getProjectHostAuthPublicKey: jest.fn(() => "public-key"),
}));
jest.mock("./sqlite/projects", () => ({
  getProject: () => ({
    users: { [ACCOUNT_ID]: { group: "collaborator" } },
  }),
}));
jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: () => undefined,
}));
jest.mock("./master-status", () => ({
  getMasterConatClient: () => undefined,
}));
jest.mock("./managed-egress-runtime", () => ({
  getProjectHostManagedEgressBlockedMessage: () => undefined,
}));

const ACCOUNT_ID = "00000000-1000-4000-8000-000000000001";
const PROJECT_ID = "00000000-1000-4000-8000-000000000000";
const HOST_ID = "00000000-1000-4000-8000-000000000099";

import { initConatServer } from "@cocalc/backend/conat/test/setup";
import { connect, type Client } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import { createProjectHostConatAuth } from "./conat-auth";

jest.setTimeout(30_000);

const CLAIMS = {
  "hub-token": {
    act: "hub",
    sub: "hub",
    jti: "00000000-1000-4000-8000-0000000000c0",
  },
  "human-token": {
    act: "account",
    sub: ACCOUNT_ID,
    iat: 1000,
    auth_actor: "account",
    jti: "00000000-1000-4000-8000-0000000000c1",
  },
  "agent-token": {
    act: "account",
    sub: ACCOUNT_ID,
    iat: 1000,
    auth_actor: "agent",
    project_id: PROJECT_ID,
    jti: "00000000-1000-4000-8000-0000000000c2",
    sid: "00000000-1000-4000-8000-0000000000c3",
  },
};

describe("a project-scoped agent's replies on a project host", () => {
  let server;
  const clients: Client[] = [];

  // a client that takes its reply inbox from the server, as the CLI does
  function client(bearer: string): Client {
    const c = connect({
      address: server.address(),
      noCache: true,
      reconnection: false,
      auth: (cb) => cb({ bearer }),
    });
    c.inboxPrefixHook = (info) =>
      info?.user ? inboxPrefix(info.user as any) : undefined;
    clients.push(c);
    return c;
  }

  beforeAll(async () => {
    mockVerifyProjectHostAuthToken.mockImplementation(({ token }) => {
      const claims = CLAIMS[token];
      if (claims == null) throw new Error("bad token");
      return claims;
    });
    const auth = createProjectHostConatAuth({ host_id: HOST_ID });
    server = await initConatServer({
      getUser: auth.getUser,
      isAllowed: auth.isAllowed,
    });
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await server?.close();
  });

  const subject = `project.${PROJECT_ID}.e2e-echo`;

  it("serves a request in the agent's own project", async () => {
    const service = client("hub-token");
    await service.waitUntilSignedIn();
    const sub = await service.subscribe(subject);
    (async () => {
      for await (const mesg of sub) {
        mesg.respondSync({ echo: mesg.data });
      }
    })();

    const agent = client("agent-token");
    await agent.waitUntilSignedIn();
    expect(agent.info?.user?.auth_api_key_reply_prefix).toMatch(
      /^_INBOX\.api-key-/,
    );
    const resp = await agent.request(subject, "hi", { timeout: 10_000 });
    expect(resp.data).toEqual({ echo: "hi" });

    // the human's request/reply still works too
    const human = client("human-token");
    await human.waitUntilSignedIn();
    const resp2 = await human.request(subject, "hello", { timeout: 10_000 });
    expect(resp2.data).toEqual({ echo: "hello" });
  });

  it("does not let the agent receive replies meant for its account", async () => {
    const agent = client("agent-token");
    await agent.waitUntilSignedIn();
    const human = client("human-token");
    await human.waitUntilSignedIn();

    // the agent tries to listen on its account's inbox
    const eavesdropped: unknown[] = [];
    let subscribeError: unknown;
    try {
      const sub = await agent.subscribe(`_INBOX.account-${ACCOUNT_ID}.>`);
      (async () => {
        for await (const mesg of sub) {
          eavesdropped.push(mesg.data);
        }
      })();
    } catch (err) {
      subscribeError = err;
    }

    const resp = await human.request(subject, "private", { timeout: 10_000 });
    expect(resp.data).toEqual({ echo: "private" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(eavesdropped).toEqual([]);
    // and it was told so, rather than silently subscribed
    expect(`${subscribeError ?? ""}`).not.toBe("");
  });
});
