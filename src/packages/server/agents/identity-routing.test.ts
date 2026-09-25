import { randomUUID } from "node:crypto";
import {
  listIdentities,
  resolveIdentity,
  registerIdentity,
  getIdentity,
  getMentionIdentity,
  recoverIdentity,
  startFreshConversation,
  startFreshConversationLocal,
} from "./api";
import { agentIdentityControl } from "./identity-control";

const account_id = randomUUID(),
  project_id = randomUUID();
const owner = jest.fn(),
  actor = jest.fn(),
  fresh = jest.fn();
const query = jest.fn(),
  find = jest.fn(),
  get = jest.fn(),
  fabric = jest.fn();
const transaction = jest.fn(async (fn) => fn({ query }));
const remote = {
  list: jest.fn(),
  resolve: jest.fn(),
  register: jest.fn(),
  recover: jest.fn(),
  startFreshConversation: jest.fn(),
  get: jest.fn(),
};
const remoteClient = jest.fn(() => remote);
const sourceHostAccess = jest.fn();
const localProject = jest.fn();
const chatReady = jest.fn();
const prepareFresh = jest.fn();
jest.mock("@cocalc/conat/ai/acp/client", () => ({
  controlAcp: (...args) => prepareFresh(...args),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRoutingForAccount: () => ({ routed: true }),
}));
let bay = "entry";
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => owner(...a),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => fabric(),
}));
jest.mock("@cocalc/conat/inter-bay/agent-identities", () => ({
  createInterBayAgentIdentityClient: (o) => remoteClient(o),
}));
jest.mock("./access", () => ({
  assertActor: (...a) => actor(...a),
  assertLocalAgentProject: (...a) => localProject(...a),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: (...a) => sourceHostAccess(...a),
}));
jest.mock("./store", () => ({
  agentStore: () => ({ query, find, get, transaction }),
  normalizeAgentPath: (s) => s,
}));
jest.mock("./chat", () => ({
  withAgentChat: async (a, fn) => {
    await chatReady();
    return fn({}, { name: "test" });
  },
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (o) => fresh(o),
}));

const request = {
  account_id,
  project_id,
  path: "/home/user/test.chat",
  thread_id: randomUUID(),
};
beforeEach(() => {
  jest.clearAllMocks();
  bay = "entry";
  owner.mockReset().mockResolvedValue({ bay_id: "owner", epoch: 3 });
  actor.mockReset().mockResolvedValue(undefined);
  fresh.mockReset().mockResolvedValue(undefined);
  sourceHostAccess.mockReset().mockResolvedValue(undefined);
  localProject.mockReset().mockResolvedValue(undefined);
  chatReady.mockReset().mockResolvedValue(undefined);
  query.mockReset().mockResolvedValue({ rows: [{ agent_id: "registered" }] });
  find.mockReset().mockResolvedValue({ agent_id: "resolved" });
  get.mockReset().mockResolvedValue({
    project_id,
    agent_id: request.thread_id,
    created_by: account_id,
  });
  remote.get.mockReset().mockResolvedValue({ agent_id: "remote" });
  remote.list.mockReset().mockResolvedValue([]);
  remote.resolve.mockReset().mockResolvedValue({ agent_id: "remote" });
  remote.register
    .mockReset()
    .mockResolvedValue({ agent_id: "registered-remote" });
  remote.recover
    .mockReset()
    .mockResolvedValue({ agent_id: "recovered-remote" });
});

const inspections = [{ read: getIdentity, method: "get" as const }];

test("fresh conversations route by project owner", async () => {
  const opts = {
    account_id,
    project_id,
    agent_id: randomUUID(),
    expected_thread_id: "old",
  };
  remote.startFreshConversation.mockResolvedValue({ thread_id: "new" });
  await expect(startFreshConversation(opts)).resolves.toEqual({
    thread_id: "new",
  });
  expect(remote.startFreshConversation).toHaveBeenCalledWith({
    ...opts,
    route: { bay_id: "owner", epoch: 3 },
  });
  expect(prepareFresh).not.toHaveBeenCalled();
});

test("fresh preparation precedes database locking and retries do not switch twice", async () => {
  const agent_id = randomUUID(),
    successor = randomUUID();
  const opts = { account_id, project_id, agent_id, expected_thread_id: "old" };
  const identity = {
    agent_id,
    project_id,
    created_by: account_id,
    thread_id: "old",
    path: request.path,
  };
  get.mockResolvedValue(identity);
  prepareFresh.mockImplementation(async () => {
    expect(transaction).not.toHaveBeenCalled();
    return { ok: true, successor_thread_id: successor };
  });
  query.mockImplementation(async (sql, params) => {
    if (sql.startsWith("SELECT * FROM agent_identities"))
      return { rows: [identity] };
    if (sql.startsWith("UPDATE agent_identities SET thread_id")) {
      expect(params[0]).toBe(agent_id);
      expect(JSON.parse(params[2])[0].thread_id).toBe("old");
      return {
        rows: [
          {
            ...identity,
            thread_id: successor,
            conversation_history: JSON.parse(params[2]),
          },
        ],
      };
    }
    return { rows: [] };
  });
  const next = await startFreshConversationLocal(opts);
  expect(next.agent_id).toBe(agent_id);
  expect(next.thread_id).toBe(successor);
  expect(
    query.mock.calls.some(([sql]) =>
      sql.startsWith("UPDATE agent_identity_runs"),
    ),
  ).toBe(true);
  get.mockResolvedValue(next);
  await expect(startFreshConversationLocal(opts)).resolves.toEqual(next);
  expect(prepareFresh).toHaveBeenCalledTimes(1);
});

test("non-registrants and host preparation failures cannot switch the identity", async () => {
  const opts = {
    account_id,
    project_id,
    agent_id: randomUUID(),
    expected_thread_id: "old",
  };
  get.mockResolvedValue({
    ...opts,
    created_by: randomUUID(),
    thread_id: "old",
  });
  await expect(startFreshConversationLocal(opts)).rejects.toThrow("registrant");
  expect(prepareFresh).not.toHaveBeenCalled();
  get.mockResolvedValue({
    ...opts,
    created_by: account_id,
    thread_id: "old",
    path: request.path,
  });
  prepareFresh.mockRejectedValue(new Error("Finish or cancel"));
  await expect(startFreshConversationLocal(opts)).rejects.toThrow(
    "Finish or cancel",
  );
  expect(transaction).not.toHaveBeenCalled();
});

test("host mention lookup validates source and routes target under the human, not embedded fields", async () => {
  const sourceProject = randomUUID();
  await getMentionIdentity({
    host_id: "source-host",
    account_id,
    project_id: sourceProject,
    target: {
      project_id,
      agent_id: request.thread_id,
      account_id: "spoof",
    } as any,
  });
  expect(localProject).toHaveBeenCalledWith(sourceProject);
  expect(sourceHostAccess).toHaveBeenCalledWith({
    host_id: "source-host",
    account_id,
    project_id: sourceProject,
  });
  expect(remote.get).toHaveBeenCalledWith({
    account_id,
    project_id,
    agent_id: request.thread_id,
    route: { bay_id: "owner", epoch: 3 },
  });
});

test("host mention lookup cannot inspect targets without source-host authorization", async () => {
  sourceHostAccess.mockRejectedValueOnce(new Error("host does not own source"));
  await expect(
    getMentionIdentity({
      host_id: "other-host",
      account_id,
      project_id: randomUUID(),
      target: { project_id, agent_id: request.thread_id },
    }),
  ).rejects.toThrow("host does not own source");
  expect(remote.get).not.toHaveBeenCalled();
});

test.each(inspections)(
  "$method routes the project-qualified ID without forwarding credentials",
  async ({ read, method }) => {
    const opts = { account_id, project_id, agent_id: request.thread_id };
    await read({
      ...opts,
      cookie: "not-forwarded",
      session_hash: "not-forwarded",
    } as any);
    expect(remote[method]).toHaveBeenCalledWith({
      ...opts,
      route: { bay_id: "owner", epoch: 3 },
      ...(method === "get" ? {} : { limit: undefined, cursor: undefined }),
    });
    expect(get).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  },
);

test.each(inspections)(
  "$method retains legacy local reads without broadcasting IDs",
  async ({ read }) => {
    await read({ account_id, agent_id: request.thread_id });
    expect(get).toHaveBeenCalledWith(request.thread_id);
    expect(actor).toHaveBeenCalledWith(account_id, project_id);
    expect(owner).not.toHaveBeenCalled();
    expect(fabric).not.toHaveBeenCalled();
  },
);

test.each(inspections)(
  "$method rejects a mismatched project at the owner",
  async ({ method }) => {
    bay = "owner";
    get.mockResolvedValue({ project_id: randomUUID(), created_by: account_id });
    await expect(
      agentIdentityControl[method]({
        account_id,
        project_id,
        agent_id: request.thread_id,
        route: { bay_id: "owner", epoch: 3 },
      }),
    ).rejects.toThrow("does not belong");
    expect(query).not.toHaveBeenCalled();
    expect(fabric).not.toHaveBeenCalled();
  },
);

test.each(inspections)(
  "$method does not fall back on peer failure",
  async ({ read, method }) => {
    remote[method].mockRejectedValue(new Error("old or unavailable peer"));
    await expect(
      read({ account_id, project_id, agent_id: request.thread_id }),
    ).rejects.toThrow("old or unavailable peer");
    expect(get).not.toHaveBeenCalled();
  },
);

test("malformed pagination or locator fails before fabric lookup", async () => {
  const opts = { account_id, project_id, agent_id: request.thread_id };
  await expect(getIdentity({ ...opts, project_id: "bad" })).rejects.toThrow();
  expect(fabric).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

test("local reads authorize locally without fabric access", async () => {
  owner.mockResolvedValue({ bay_id: "entry", epoch: 3 });
  await listIdentities(request);
  await resolveIdentity(request);
  expect(actor).toHaveBeenCalledWith(account_id, project_id);
  expect(query).toHaveBeenCalledTimes(1);
  expect(find).toHaveBeenCalledWith(
    project_id,
    request.path,
    request.thread_id,
  );
  expect(fabric).not.toHaveBeenCalled();
});

test("remote reads use exact project ownership and whitelist arguments", async () => {
  await listIdentities({ ...request, cookie: "not-forwarded" } as any);
  await resolveIdentity({ ...request, bearer: "not-forwarded" } as any);
  expect(remote.list).toHaveBeenCalledWith({
    account_id,
    project_id,
    route: { bay_id: "owner", epoch: 3 },
  });
  expect(remote.resolve).toHaveBeenCalledWith({
    ...request,
    route: { bay_id: "owner", epoch: 3 },
  });
  expect(remoteClient).toHaveBeenCalledWith(
    expect.objectContaining({ bay_id: "owner" }),
  );
  expect(query).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
});

test("remote registration uses ordinary project authorization", async () => {
  await registerIdentity({
    ...request,
    session_hash: "bound-session",
    fresh_auth_at: 1,
  } as any);
  expect(fresh).not.toHaveBeenCalled();
  expect(remote.register).toHaveBeenCalledWith({
    ...request,
    route: { bay_id: "owner", epoch: 3 },
  });
  expect(query).not.toHaveBeenCalled();
});

test("remote recovery verifies fresh auth and forwards only the identity locator", async () => {
  const before = Date.now();
  await recoverIdentity({
    account_id,
    project_id,
    agent_id: request.thread_id,
    session_hash: "bound-session",
    fresh_auth_at: 1,
  } as any);
  expect(fresh).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id,
      session_hash: "bound-session",
      allow_actor_impersonation: false,
    }),
  );
  const forwarded = remote.recover.mock.calls[0][0];
  expect(forwarded).toEqual({
    account_id,
    project_id,
    agent_id: request.thread_id,
    route: { bay_id: "owner", epoch: 3 },
    fresh_auth_at: expect.any(Number),
  });
  expect(forwarded.fresh_auth_at).toBeGreaterThanOrEqual(before);
});

test("failed project authorization never completes registration", async () => {
  bay = "owner";
  actor.mockRejectedValue(new Error("not a collaborator"));
  await expect(registerIdentity(request)).rejects.toThrow("not a collaborator");
  expect(owner).toHaveBeenCalledWith(project_id);
  expect(query).not.toHaveBeenCalled();
});

test.each([
  "account is disabled",
  "collaborator removed",
  "project owner changed",
])(
  "registration rechecks authority after chat readiness: %s",
  async (reason) => {
    bay = "owner";
    chatReady.mockImplementation(async () => {
      expect(actor).toHaveBeenCalledWith(account_id, project_id);
      actor.mockRejectedValue(new Error(reason));
    });
    await expect(registerIdentity(request)).rejects.toThrow(reason);
    expect(chatReady).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  },
);

test.each([null, "offline"])(
  "unknown or unavailable owner %s has no fallback",
  async (value) => {
    if (value) owner.mockRejectedValue(new Error(value));
    else owner.mockResolvedValue(null);
    await expect(listIdentities(request)).rejects.toThrow();
    expect(fabric).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  },
);

test("remote failure never falls back to local data", async () => {
  remote.list.mockRejectedValue(new Error("peer unavailable"));
  await expect(listIdentities(request)).rejects.toThrow("peer unavailable");
  expect(query).not.toHaveBeenCalled();
});

test("invalid public actor/project fails before routing", async () => {
  await expect(
    listIdentities({ account_id: "invalid", project_id }),
  ).rejects.toThrow();
  await expect(
    listIdentities({ account_id, project_id: "invalid" }),
  ).rejects.toThrow();
  expect(owner).not.toHaveBeenCalled();
});

test("owner rechecks local access before identity reads and registration", async () => {
  bay = "owner";
  const opts = { ...request, route: { bay_id: "owner", epoch: 3 } };
  await agentIdentityControl.list(opts);
  await agentIdentityControl.resolve(opts);
  await agentIdentityControl.register(opts);
  expect(actor).toHaveBeenCalledTimes(4); // registration also checks after chat readiness
  expect(fresh).not.toHaveBeenCalled();
  expect(remoteClient).not.toHaveBeenCalled();
});

test.each([undefined, NaN, 0, Date.now() + 60_000])(
  "invalid fresh attestation %s cannot recover an identity",
  async (fresh_auth_at) => {
    bay = "owner";
    await expect(
      agentIdentityControl.recover({
        account_id,
        project_id,
        agent_id: request.thread_id,
        route: { bay_id: "owner", epoch: 3 },
        fresh_auth_at,
      } as any),
    ).rejects.toThrow("attestation");
    expect(query).not.toHaveBeenCalled();
  },
);

test("recovery rechecks project ownership after chat readiness", async () => {
  bay = "owner";
  get.mockResolvedValue({
    project_id,
    agent_id: request.thread_id,
    path: request.path,
    thread_id: request.thread_id,
    created_by: account_id,
  });
  let ownerChecks = 0;
  query.mockImplementation(async (sql) => {
    if (`${sql}`.includes("jsonb_each")) {
      ownerChecks += 1;
      return {
        rows: ownerChecks === 1 ? [{ account_id }] : [],
      };
    }
    return { rows: [] };
  });
  await expect(
    agentIdentityControl.recover({
      account_id,
      project_id,
      agent_id: request.thread_id,
      route: { bay_id: "owner", epoch: 3 },
      fresh_auth_at: Date.now(),
    }),
  ).rejects.toThrow("only a project owner");
  expect(chatReady).toHaveBeenCalledTimes(1);
  expect(transaction).not.toHaveBeenCalled();
});

test("destination access denial prevents data access", async () => {
  bay = "owner";
  actor.mockRejectedValue(new Error("not a collaborator"));
  await expect(
    agentIdentityControl.resolve({
      ...request,
      route: { bay_id: "owner", epoch: 3 },
    }),
  ).rejects.toThrow("not a collaborator");
  expect(find).not.toHaveBeenCalled();
});

test.each([
  { bay_id: "other", epoch: 3 },
  { bay_id: "owner", epoch: 2 },
  undefined,
])("stale route %j never reads local data or forwards again", async (route) => {
  bay = "owner";
  await expect(
    agentIdentityControl.list({ ...request, route } as any),
  ).rejects.toThrow("stale");
  expect(query).not.toHaveBeenCalled();
  expect(fabric).not.toHaveBeenCalled();
});
