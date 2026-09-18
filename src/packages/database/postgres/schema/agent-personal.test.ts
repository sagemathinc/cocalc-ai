import { randomUUID } from "node:crypto";
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

const tables = [
  "agent_personal_controls",
  "agent_personal_names",
  "agent_sessions",
  "agent_session_members",
  "agent_session_mutations",
  "agent_session_activity",
  "agent_session_proposals",
  "agent_session_broadcasts",
];
const schema = Object.fromEntries(tables.map((name) => [name, SCHEMA[name]]));

describe("Agent Session account-home schema", () => {
  beforeEach(async () => {
    process.env.COCALC_DB = agentSchemaBackend();
    db = await createAgentSchemaFixture();
  });
  afterEach(async () => db.end());

  test("sync is idempotent and preserves complete-graph authority rows", async () => {
    expect(await schemaNeedsSync(schema)).toBe(true);
    await syncSchema(schema);
    const account = randomUUID();
    const session = randomUUID();
    const project = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await db.query(
      "INSERT INTO agent_personal_controls(account_id) VALUES($1)",
      [account],
    );
    await db.query(
      `INSERT INTO agent_sessions
       (agent_session_id,account_id,title,delivery_mode,generation,created_by)
       VALUES($1,$2,'Review','queued',$3,$2)`,
      [session, account, randomUUID()],
    );
    for (const agent of [first, second])
      await db.query(
        `INSERT INTO agent_session_members
         (agent_session_id,member_kind,member_id,registered_agent_id,project_id,added_by)
         VALUES($1,'registered',$2,$2,$3,$4)`,
        [session, agent, project, account],
      );
    await syncSchema(schema);
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM agent_session_members",
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  });

  test("directional grant and inbox tables are not declared", () => {
    expect(SCHEMA.agent_rpc_links).toBeUndefined();
    expect(SCHEMA.agent_message_grants).toBeUndefined();
    expect(SCHEMA.agent_message_inbox).toBeUndefined();
    expect(SCHEMA.agent_personal_grants).toBeUndefined();
    expect(SCHEMA.agent_personal_requests).toBeUndefined();
  });
});
