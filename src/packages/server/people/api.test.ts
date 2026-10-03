import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { closePglite } from "@cocalc/database/pglite";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  getConversation,
  resolveAlias,
  setPersonalState,
} from "@cocalc/database/postgres/people";

const mockHome = jest.fn();
const mockOwner = jest.fn();
const mockRemoteRecord = jest.fn();
const mockRemoteState = jest.fn();
const mockRemoteRead = jest.fn();
const mockRemoteClient = jest.fn((_opts: unknown) => ({
  getRecord: mockRemoteRecord,
  setState: mockRemoteState,
  markRead: mockRemoteRead,
}));

jest.mock("@cocalc/conat/inter-bay/people", () => ({
  createInterBayPeopleClient: (opts: unknown) => mockRemoteClient(opts),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: unknown[]) => mockHome(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args: unknown[]) => mockOwner(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: jest.fn(),
}));
jest.mock("@cocalc/server/projects/collaborators", () => ({
  listCollabInvites: jest.fn(),
}));

import { peopleApi, peopleControl } from "./api";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
const account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project_id = "11111111-1111-4111-8111-111111111111";
const oldId = "22222222-2222-4222-8222-222222222222";
const newId = "33333333-3333-4333-8333-333333333333";
const aliasOpts = { account_id, kind: "conversation" as const, alias: "team" };
const stateOpts = {
  account_id,
  kind: "conversation" as const,
  target_id: newId,
  project_id,
  patch: { alias: "team" },
};

describeDb("People home/owner routing and alias retirement", () => {
  const originalBay = process.env.COCALC_BAY_ID;
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "bay-0";
    const tables = [
      "accounts",
      "projects",
      "project_conversations",
      "account_people_state",
    ];
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
    await getPool().query(`CREATE TABLE account_rehome_operations (
      op_id uuid, account_id uuid, source_bay_id text, dest_bay_id text,
      status text, stage text, created_at timestamp DEFAULT NOW()
    )`);
  }, 30000);
  afterAll(async () => {
    if (originalBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = originalBay;
    await closePglite();
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockHome.mockResolvedValue({ home_bay_id: "bay-0" });
    mockOwner.mockResolvedValue({ bay_id: "bay-0" });
    mockRemoteRecord.mockReset().mockResolvedValue(null);
    await getPool().query(
      "TRUNCATE accounts, projects, project_conversations, account_people_state, account_rehome_operations CASCADE",
    );
    await getPool().query(
      "INSERT INTO accounts(account_id, home_bay_id) VALUES ($1, 'bay-0')",
      [account_id],
    );
    await getPool().query(
      "INSERT INTO projects(project_id, users) VALUES ($1, $2)",
      [project_id, JSON.stringify({ [account_id]: { group: "owner" } })],
    );
  });

  test("remove, re-register the file, and reclaim its old alias", async () => {
    const opts = { account_id, project_id, path: "~/team.chat", title: "Team" };
    const old = await peopleApi.addConversation(opts);
    await peopleApi.setState({ ...stateOpts, target_id: old.conversation_id });
    await peopleApi.removeConversation({
      account_id,
      project_id,
      conversation_id: old.conversation_id,
    });
    const replacement = await peopleApi.addConversation(opts);
    expect(replacement.conversation_id).not.toBe(old.conversation_id);
    await peopleApi.setState({
      ...stateOpts,
      target_id: replacement.conversation_id,
    });
    expect(await resolveAlias(aliasOpts)).toEqual({
      target_id: replacement.conversation_id,
      project_id,
    });
    expect(
      await getConversation({
        account_id,
        project_id,
        conversation_id: replacement.conversation_id,
      }),
    ).toMatchObject({ path: "/home/user/team.chat", title: "Team" });
  });

  test("a live local conversation keeps its alias", async () => {
    const old = await peopleApi.addConversation({
      account_id,
      project_id,
      path: "team.chat",
      title: "Team",
    });
    await peopleApi.setState({ ...stateOpts, target_id: old.conversation_id });
    await expect(peopleApi.setState(stateOpts)).rejects.toThrow(
      "already use the alias",
    );
    expect(await resolveAlias(aliasOpts)).toMatchObject({
      target_id: old.conversation_id,
    });
  });

  test.each(["missing", "live", "unavailable"])(
    "remote owner reports %s",
    async (state) => {
      await setPersonalState({ ...stateOpts, target_id: oldId });
      mockOwner.mockResolvedValue({ bay_id: "bay-project" });
      if (state === "live")
        mockRemoteRecord.mockResolvedValue({ conversation_id: oldId });
      if (state === "unavailable")
        mockRemoteRecord.mockRejectedValue(Error("owner unavailable"));
      if (state === "missing") {
        await peopleApi.setState(stateOpts);
        expect(await resolveAlias(aliasOpts)).toMatchObject({
          target_id: newId,
        });
      } else {
        await expect(peopleApi.setState(stateOpts)).rejects.toThrow(
          state === "live" ? "already use the alias" : "owner unavailable",
        );
        expect(await resolveAlias(aliasOpts)).toMatchObject({
          target_id: oldId,
        });
      }
      expect(mockOwner).toHaveBeenCalledWith(project_id);
      expect(mockRemoteClient).toHaveBeenCalledWith(
        expect.objectContaining({ bay_id: "bay-project" }),
      );
      expect(mockRemoteRecord).toHaveBeenCalledWith({
        account_id,
        project_id,
        conversation_id: oldId,
      });
    },
  );

  test("a concurrent rebinding is not cleared by a stale owner result", async () => {
    await setPersonalState({ ...stateOpts, target_id: oldId });
    mockOwner.mockResolvedValue({ bay_id: "bay-project" });
    mockRemoteRecord.mockImplementationOnce(async () => {
      await setPersonalState({
        ...stateOpts,
        target_id: oldId,
        patch: { alias: null },
      });
      await setPersonalState({ ...stateOpts, target_id: project_id });
      return null;
    });
    await expect(peopleApi.setState(stateOpts)).rejects.toThrow(
      "already use the alias",
    );
    expect(await resolveAlias(aliasOpts)).toMatchObject({
      target_id: project_id,
    });
  });

  test("rehome fences both API writes and alias reclamation", async () => {
    await setPersonalState({ ...stateOpts, target_id: oldId });
    await getPool().query(
      `INSERT INTO account_rehome_operations
      (op_id, account_id, source_bay_id, dest_bay_id, status, stage)
      VALUES (gen_random_uuid(), $1, 'bay-0', 'bay-2', 'running', 'requested')`,
      [account_id],
    );
    await expect(peopleApi.setState(stateOpts)).rejects.toThrow(
      "account rehome",
    );
    await expect(
      peopleApi.markRead({
        account_id,
        project_id,
        conversation_id: newId,
        read_through: 1234,
      }),
    ).rejects.toThrow("account rehome");
    expect(await resolveAlias(aliasOpts)).toMatchObject({ target_id: oldId });
  });

  test("personal mutations route to account home, not the project owner", async () => {
    mockHome.mockResolvedValue({ home_bay_id: "bay-home" });
    await peopleApi.setState(stateOpts);
    const read = {
      account_id,
      project_id,
      conversation_id: newId,
      read_through: 1234,
    };
    await peopleApi.markRead(read);
    expect(mockRemoteState).toHaveBeenCalledWith(stateOpts);
    expect(mockRemoteRead).toHaveBeenCalledWith(read);
    expect(mockRemoteClient).toHaveBeenCalledWith(
      expect.objectContaining({ bay_id: "bay-home" }),
    );
    expect(mockOwner).not.toHaveBeenCalled();
    await expect(peopleControl.setState(stateOpts)).rejects.toThrow(
      "stale account-home route",
    );
    await expect(peopleControl.markRead(read)).rejects.toThrow(
      "stale account-home route",
    );
  });
});
