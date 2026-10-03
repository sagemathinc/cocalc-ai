import { randomUUID } from "node:crypto";

const project = randomUUID();
const agent = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const credentialId = randomUUID();
let remote = false;
const remoteSet = jest.fn(async () => ({ recorded: true }));
const assertActor = jest.fn(async () => {});
// Minimal agent_turn_funding stand-in keyed like the real primary key.
const rows = new Map<string, unknown>();
const query = jest.fn(async (sql: string, params: any[]) => {
  if (sql.startsWith("INSERT INTO agent_turn_funding")) {
    rows.set(`${params[0]}/${params[1]}`, JSON.parse(params[3]));
    return { rows: [] };
  }
  if (sql.startsWith("SELECT funding FROM agent_turn_funding")) {
    const funding = rows.get(`${params[0]}/${params[1]}`);
    return { rows: funding === undefined ? [] : [{ funding }] };
  }
  throw new Error(`unexpected query ${sql}`);
});

jest.mock("./store", () => ({
  agentStore: () => ({
    find: async (project_id: string, path: string, thread_id: string) =>
      project_id === project &&
      path === "/home/user/a.chat" &&
      thread_id === "thread"
        ? { agent_id: agent, project_id: project }
        : undefined,
    query,
  }),
}));
jest.mock("./access", () => ({
  assertActor: (...args: unknown[]) => assertActor(...args),
}));
jest.mock("./identity-routing", () => ({
  withAgentIdentityOwner: async ({ local, remote: viaRemote }) =>
    remote
      ? viaRemote({ setNextTurnFunding: remoteSet }, { bay_id: "b", epoch: 1 })
      : local(),
}));

import { getNextTurnFunding, setNextTurnFunding } from "./turn-funding";

const locator = {
  project_id: project,
  path: "/home/user/a.chat",
  thread_id: "thread",
};
const codex = {
  version: 1,
  kind: "codex",
  credential_id: credentialId,
} as const;

beforeEach(() => {
  rows.clear();
  remote = false;
  query.mockClear();
  remoteSet.mockClear();
  assertActor.mockReset().mockResolvedValue(undefined);
});

test("records per account and never mixes collaborators", async () => {
  await expect(
    setNextTurnFunding({ account_id: alice, ...locator, funding: codex }),
  ).resolves.toEqual({ recorded: true });
  expect(assertActor).toHaveBeenCalledWith(alice, project);
  expect(
    await getNextTurnFunding({ agent_id: agent, account_id: alice }),
  ).toEqual(codex);
  expect(
    await getNextTurnFunding({ agent_id: agent, account_id: bob }),
  ).toBeUndefined();
});

test("the latest human send replaces the record", async () => {
  await setNextTurnFunding({ account_id: alice, ...locator, funding: codex });
  await setNextTurnFunding({
    account_id: alice,
    ...locator,
    funding: { version: 1, kind: "codex" },
  });
  expect(
    await getNextTurnFunding({ agent_id: agent, account_id: alice }),
  ).toEqual({
    version: 1,
    kind: "codex",
  });
});

test("an unregistered thread records nothing", async () => {
  await expect(
    setNextTurnFunding({
      account_id: alice,
      ...locator,
      thread_id: "other",
      funding: codex,
    }),
  ).resolves.toEqual({ recorded: false });
  expect(query).not.toHaveBeenCalled();
});

test("non-collaborators and malformed records are refused before writing", async () => {
  assertActor.mockRejectedValueOnce(new Error("not a collaborator"));
  await expect(
    setNextTurnFunding({ account_id: bob, ...locator, funding: codex }),
  ).rejects.toThrow("not a collaborator");
  await expect(
    setNextTurnFunding({
      account_id: alice,
      ...locator,
      funding: { version: 1, kind: "codex", api_key: "sk-secret" } as any,
    }),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

test("an unreadable stored record is treated as absent", async () => {
  rows.set(`${agent}/${alice}`, { version: 99 });
  expect(
    await getNextTurnFunding({ agent_id: agent, account_id: alice }),
  ).toBeUndefined();
});

test("routes to the owning bay with the caller's account", async () => {
  remote = true;
  await setNextTurnFunding({ account_id: alice, ...locator, funding: codex });
  expect(remoteSet).toHaveBeenCalledWith({
    account_id: alice,
    ...locator,
    funding: codex,
    route: { bay_id: "b", epoch: 1 },
  });
  expect(query).not.toHaveBeenCalled();
});
