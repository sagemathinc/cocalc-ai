import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { personalUrlAliasHomeControl } from "./personal-url-aliases";

const owner = randomUUID();
const project_id = randomUUID();
const conversation_id = randomUUID();
const person = randomUUID();

jest.mock("./bay-config", () => ({ getConfiguredBayId: () => "home" }));
jest.mock("./bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "home" }),
}));

const lookup = (kind, alias, home_bay_id = "home") =>
  personalUrlAliasHomeControl.lookup({
    owner_account_id: owner,
    home_bay_id,
    kind,
    alias,
  });

beforeAll(async () => {
  await initEphemeralDatabase({});
  const db = getPool();
  await db.query(
    "INSERT INTO accounts (account_id, email_address, created) VALUES ($1, $2, NOW())",
    [owner, `${owner}@example.com`],
  );
  await db.query(
    `INSERT INTO account_people_state
       (account_id, kind, target_id, project_id, alias, updated)
     VALUES ($1, 'conversation', $2, $3, 'weekly', NOW()),
            ($1, 'person', $4, NULL, 'ana', NOW())`,
    [owner, conversation_id, project_id, person],
  );
}, 60000);
afterAll(async () => {
  await getPool().end();
});

test("chats and people resolve the owner's private aliases", async () => {
  expect(await lookup("chats", "Weekly")).toEqual({
    kind: "conversation",
    project_id,
    conversation_id,
  });
  expect(await lookup("people", "ANA")).toEqual({
    kind: "person",
    person_id: person,
  });
  expect(await lookup("chats", "ana")).toBeNull();
  expect(await lookup("people", "missing")).toBeNull();
});

test("a stale home route is rejected", async () => {
  await expect(lookup("chats", "weekly", "other")).rejects.toThrow(
    "Stale account-home route",
  );
});
