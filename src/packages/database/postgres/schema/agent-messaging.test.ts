import {
  agentSchemaBackend,
  createAgentSchemaFixture,
} from "./agent-schema-fixture";
import type { AgentSchemaFixture } from "./agent-schema-fixture";
import { SCHEMA } from "@cocalc/util/db-schema";
import { schemaNeedsSync, syncSchema } from "./sync";

let db: AgentSchemaFixture;
jest.mock("@cocalc/database/pool", () => ({
  ...jest.requireActual("@cocalc/database/pool"),
  getClient: () => ({
    connect: async () => {},
    end: async () => {},
    query: (...args) => db.query(...args),
  }),
}));

const tables = ["agent_rpc_admission_state"];
const schema = Object.fromEntries(tables.map((name) => [name, SCHEMA[name]]));

describe("agent runtime and admission schema", () => {
  beforeEach(async () => {
    process.env.COCALC_DB = agentSchemaBackend();
    db = await createAgentSchemaFixture();
  });
  afterEach(async () => db.end());

  test("only identity, route fence, and short-lived admission state remain", async () => {
    expect(await schemaNeedsSync(schema)).toBe(true);
    await syncSchema(schema);
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    for (const name of [
      "agent_rpc_links",
      "agent_message_grants",
      "agent_message_inbox",
    ])
      expect(SCHEMA[name]).toBeUndefined();
  });
});
