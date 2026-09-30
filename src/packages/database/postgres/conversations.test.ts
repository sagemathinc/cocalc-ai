/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  createConversationRecord,
  getConversation,
  getConversationStates,
  listConversationsForProjects,
  markConversationRead,
  removeConversation,
  renameConversation,
  setConversationPinned,
  touchConversation,
} from "./conversations";

const project_id = "11111111-1111-4111-8111-111111111111";
const other_project_id = "22222222-2222-4222-8222-222222222222";
const alice = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const viewer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function setUsers(id: string, users: Record<string, string>) {
  const json = Object.fromEntries(
    Object.entries(users).map(([account_id, group]) => [account_id, { group }]),
  );
  await getPool().query(
    `INSERT INTO projects (project_id, users) VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET users = EXCLUDED.users`,
    [id, JSON.stringify(json)],
  );
}

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE project_conversations, account_conversation_state, projects CASCADE",
  );
  await setUsers(project_id, { [alice]: "owner", [bob]: "collaborator" });
  await setUsers(other_project_id, { [alice]: "owner" });
});

afterAll(async () => {
  await testCleanup();
});

test("adding the same file twice returns one conversation", async () => {
  const a = await createConversationRecord({
    account_id: alice,
    project_id,
    path: "notes/team.chat",
    title: "Team",
  });
  const b = await createConversationRecord({
    account_id: bob,
    project_id,
    path: "/home/user/notes//team.chat",
    title: "Other title",
  });
  expect(b.conversation_id).toBe(a.conversation_id);
  expect(b.title).toBe("Team");
  expect(a.path).toBe("/home/user/notes/team.chat");
});

test("only current owners/collaborators can create, see or touch", async () => {
  await expect(
    createConversationRecord({
      account_id: bob,
      project_id: other_project_id,
      path: "x.chat",
      title: "x",
    }),
  ).rejects.toThrow("collaborator");
  const c = await createConversationRecord({
    account_id: alice,
    project_id,
    path: "x.chat",
    title: "x",
  });
  const both = [project_id, other_project_id];
  expect(
    await listConversationsForProjects({ account_id: bob, project_ids: both }),
  ).toHaveLength(1);
  // removing bob from the project hides the conversation immediately
  await setUsers(project_id, { [alice]: "owner", [viewer]: "viewer" });
  expect(
    await listConversationsForProjects({ account_id: bob, project_ids: both }),
  ).toHaveLength(0);
  expect(
    await touchConversation({ account_id: bob, project_id, path: "x.chat" }),
  ).toBeNull();
  // viewers are not participants
  expect(
    await getConversation({
      account_id: viewer,
      project_id,
      conversation_id: c.conversation_id,
    }),
  ).toBeNull();
});

test("touch records activity and recent senders; other files are a no-op", async () => {
  const c = await createConversationRecord({
    account_id: alice,
    project_id,
    path: "x.chat",
    title: "x",
  });
  expect(
    await touchConversation({
      account_id: bob,
      project_id,
      path: "not-a-conversation.chat",
    }),
  ).toBeNull();
  await touchConversation({ account_id: alice, project_id, path: "x.chat" });
  await touchConversation({ account_id: bob, project_id, path: "x.chat" });
  const t = await touchConversation({
    account_id: alice,
    project_id,
    path: "/home/user/x.chat",
  });
  expect(t?.participant_ids).toEqual([alice, bob]);
  expect(t?.last_sender_id).toBe(alice);
  expect(t!.last_activity).toBeGreaterThanOrEqual(c.last_activity);
});

test("read markers and pins are per account and monotone", async () => {
  const c = await createConversationRecord({
    account_id: alice,
    project_id,
    path: "x.chat",
    title: "x",
  });
  const key = { project_id, conversation_id: c.conversation_id };
  await markConversationRead({ account_id: bob, ...key, read_through: 2000 });
  await markConversationRead({ account_id: bob, ...key, read_through: 1000 });
  await setConversationPinned({ account_id: bob, ...key, pinned: true });
  const bobs = await getConversationStates({
    account_id: bob,
    conversation_ids: [c.conversation_id],
  });
  expect(bobs.get(c.conversation_id)).toEqual({
    pinned: true,
    last_read: 2000,
  });
  const alices = await getConversationStates({
    account_id: alice,
    conversation_ids: [c.conversation_id],
  });
  expect(alices.size).toBe(0);
});

test("rename and remove change only the record", async () => {
  const c = await createConversationRecord({
    account_id: alice,
    project_id,
    path: "x.chat",
    title: "x",
  });
  const key = { project_id, conversation_id: c.conversation_id };
  expect(
    (
      await renameConversation({
        account_id: bob,
        ...key,
        title: " New  name ",
      })
    ).title,
  ).toBe("New name");
  await removeConversation({ account_id: bob, ...key });
  expect(await getConversation({ account_id: alice, ...key })).toBeNull();
});

test("paths must be .chat files", async () => {
  await expect(
    createConversationRecord({
      account_id: alice,
      project_id,
      path: "notes.md",
      title: "x",
    }),
  ).rejects.toThrow(".chat");
});
