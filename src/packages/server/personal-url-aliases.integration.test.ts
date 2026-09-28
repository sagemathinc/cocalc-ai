import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { PERSONAL_AGENT_STATE_TABLES } from "./agents/personal-rehome";
import { personalUrlAliasHomeControl } from "./personal-url-aliases";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
const bay = "personal-url-test";
const previousBay = process.env.COCALC_BAY_ID;
jest.mock("./bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "personal-url-test" }),
}));
jest.mock("./inter-bay/fabric", () => ({ getInterBayFabricClient: jest.fn() }));

describeDb("personal URL alias database lookup", () => {
  const owner = randomUUID();
  const other = randomUUID();
  const project = randomUUID();
  const agent = randomUUID();
  const otherAgent = randomUUID();
  const entry = "a".repeat(64);
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = bay;
    await initEphemeralDatabase();
    const tables = [
      "accounts",
      "collaboration_personal",
      "collaboration_index",
      ...PERSONAL_AGENT_STATE_TABLES,
    ];
    await syncSchema(
      Object.fromEntries(tables.map((table) => [table, SCHEMA[table]])),
    );
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$3),($2,$3)",
      [owner, other, bay],
    );
    await getPool().query(
      "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'reviewer',$3,$4,'{}'),($2,'reviewer',$3,$5,'{}')",
      [owner, other, project, agent, otherAgent],
    );
    await getPool().query(
      "INSERT INTO personal_library_aliases(account_id,name,project_id,entry_id) VALUES($1,'primes',$2,$3)",
      [owner, project, entry],
    );
    await getPool().query(
      "INSERT INTO collaboration_index(account_id,entry_key,project_id,kind,metadata) VALUES($1,'chat-key',$2,'conversation',$3::jsonb)",
      [owner, project, JSON.stringify({ resource_id: "thread" })],
    );
    await getPool().query(
      "INSERT INTO collaboration_personal(account_id,entry_key,project_id,alias) VALUES($1,'chat-key',$2,'chat1')",
      [owner, project],
    );
  }, 60000);
  afterAll(async () => {
    await getPool().end();
    if (previousBay == null) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = previousBay;
  });
  const lookup = (
    kind: "agents" | "artifacts" | "chats" | "people",
    alias: string,
    owner_account_id = owner,
  ) =>
    personalUrlAliasHomeControl.lookup({
      owner_account_id,
      home_bay_id: bay,
      kind,
      alias,
    });

  test("same alias in two accounts resolves to distinct stable IDs", async () => {
    expect(await lookup("agents", "reviewer")).toEqual({
      kind: "agent",
      project_id: project,
      agent_id: agent,
    });
    expect(await lookup("agents", "reviewer", other)).toEqual({
      kind: "agent",
      project_id: project,
      agent_id: otherAgent,
    });
  });
  test("artifact and human conversation locators use their existing stores", async () => {
    expect(await lookup("artifacts", "primes")).toEqual({
      kind: "artifact",
      project_id: project,
      entry_id: entry,
    });
    expect(await lookup("chats", "chat1")).toEqual({
      kind: "conversation",
      project_id: project,
      resource_kind: "conversation",
      resource_id: "thread",
    });
    expect(await lookup("chats", "reviewer")).toEqual({
      kind: "conversation",
      project_id: project,
      resource_kind: "agent",
      resource_id: agent,
    });
    expect(await lookup("artifacts", "primes", other)).toBeNull();
  });
  test("retired agent names and banned owners are not live URL bindings", async () => {
    await getPool().query(
      "UPDATE agent_personal_names SET retired_at=now() WHERE account_id=$1",
      [other],
    );
    expect(await lookup("agents", "reviewer", other)).toBeNull();
    await getPool().query(
      "UPDATE accounts SET banned=TRUE WHERE account_id=$1",
      [owner],
    );
    expect(await lookup("artifacts", "primes")).toBeNull();
    await getPool().query(
      "UPDATE accounts SET banned=FALSE WHERE account_id=$1",
      [owner],
    );
  });
  test("an account-home change fences the stale local alias rows", async () => {
    await getPool().query(
      "UPDATE accounts SET home_bay_id='other-bay' WHERE account_id=$1",
      [owner],
    );
    await expect(lookup("artifacts", "primes")).rejects.toThrow(
      "homed on other-bay",
    );
  });
});
