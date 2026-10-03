/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  createConversationRecord,
  getConversation,
  getPersonalStates,
  latestMentions,
  listConversationsForProjects,
  mentionKey,
  listPersonalStates,
  listSharedWork,
  listProjectAgents,
  setAgentAppearance,
  getAgentAccess,
  setAgentAccess,
  markConversationRead,
  refreshConversationActivity,
  removeConversation,
  renameConversation,
  resolveAlias,
  setPersonalState,
  touchConversation,
} from "./people";

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
    "TRUNCATE project_conversations, account_people_state, account_notification_index, artifact_catalog, artifact_catalog_sources, agent_identities, projects CASCADE",
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
  await setPersonalState({
    account_id: bob,
    kind: "conversation",
    target_id: c.conversation_id,
    project_id,
    patch: { pinned: true },
  });
  const bobs = await getPersonalStates({
    account_id: bob,
    kind: "conversation",
    target_ids: [c.conversation_id],
  });
  expect(bobs.get(c.conversation_id)).toMatchObject({
    pinned: true,
    last_read: 2000,
    following: false,
  });
  const alices = await getPersonalStates({
    account_id: alice,
    kind: "conversation",
    target_ids: [c.conversation_id],
  });
  expect(alices.size).toBe(0);
});

test("a patch changes only the fields it names", async () => {
  const target = { account_id: alice, kind: "person" as const, target_id: bob };
  await setPersonalState({
    ...target,
    patch: { following: true, alias: "Bob" },
  });
  const state = await setPersonalState({ ...target, patch: { pinned: true } });
  expect(state).toMatchObject({
    pinned: true,
    following: true,
    alias: "bob",
    muted: false,
  });
  // an empty alias clears it
  expect(
    (await setPersonalState({ ...target, patch: { alias: "" } })).alias,
  ).toBeNull();
});

test("aliases are private, case-insensitive and unique per account and kind", async () => {
  await setPersonalState({
    account_id: alice,
    kind: "person",
    target_id: bob,
    patch: { alias: "@Bella" },
  });
  expect(
    await resolveAlias({ account_id: alice, kind: "person", alias: "BELLA" }),
  ).toEqual({ target_id: bob, project_id: null });
  // same alias for another person of the same account is rejected
  await expect(
    setPersonalState({
      account_id: alice,
      kind: "person",
      target_id: viewer,
      patch: { alias: "bella" },
    }),
  ).rejects.toThrow("already use the alias");
  // other kinds and other accounts are independent
  await setPersonalState({
    account_id: alice,
    kind: "conversation",
    target_id: viewer,
    patch: { alias: "bella" },
  });
  await setPersonalState({
    account_id: bob,
    kind: "person",
    target_id: alice,
    patch: { alias: "bella" },
  });
  expect(
    await resolveAlias({ account_id: bob, kind: "person", alias: "bella" }),
  ).toEqual({ target_id: alice, project_id: null });
  await expect(
    setPersonalState({
      account_id: alice,
      kind: "person",
      target_id: bob,
      patch: { alias: "no spaces" },
    }),
  ).rejects.toThrow("alias");
  expect(
    (await listPersonalStates({ account_id: alice, kind: "person" })).map(
      (row) => row.alias,
    ),
  ).toEqual(["bella"]);
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

test("latest explicit mentions per conversation, ignoring thread-follow", async () => {
  const insert = (reason: string | null, path: string, at: string) =>
    getPool().query(
      `INSERT INTO account_notification_index
         (account_id, notification_id, kind, project_id, summary, created_at)
       VALUES ($1, gen_random_uuid(), 'mention', $2, $3, $4)`,
      [
        alice,
        project_id,
        JSON.stringify(
          reason == null ? { path } : { path, notification_reason: reason },
        ),
        at,
      ],
    );
  await insert(null, "/home/user/x.chat", "2026-01-01T00:00:00Z");
  await insert("mention", "/home/user/x.chat", "2026-01-02T00:00:00Z");
  await insert("thread_follow", "/home/user/x.chat", "2026-01-03T00:00:00Z");
  await insert("thread_follow", "/home/user/y.chat", "2026-01-03T00:00:00Z");
  const mentions = await latestMentions({
    account_id: alice,
    project_ids: [project_id],
  });
  expect(mentions.get(mentionKey(project_id, "/home/user/x.chat"))).toBe(
    new Date("2026-01-02T00:00:00Z").valueOf(),
  );
  expect(mentions.has(mentionKey(project_id, "/home/user/y.chat"))).toBe(false);
});

test("a scan raises activity to the file time, never backwards or ahead", async () => {
  const c = await createConversationRecord({
    account_id: alice,
    project_id,
    path: "x.chat",
    title: "x",
  });
  const older = await refreshConversationActivity({
    account_id: bob,
    project_id,
    path: "x.chat",
    activity: c.last_activity - 60_000,
  });
  expect(older!.last_activity).toBe(c.last_activity);
  const future = await refreshConversationActivity({
    account_id: bob,
    project_id,
    path: "x.chat",
    activity: Date.now() + 3_600_000,
  });
  expect(future!.last_activity).toBeLessThanOrEqual(Date.now() + 1000);
  expect(future!.last_activity).toBeGreaterThanOrEqual(c.last_activity);
  expect(future!.last_sender_id ?? null).toBeNull();
  expect(
    await refreshConversationActivity({
      account_id: viewer,
      project_id,
      path: "x.chat",
      activity: Date.now(),
    }),
  ).toBeNull();
});

test("scanned_at is recorded per account and project", async () => {
  const state = await setPersonalState({
    account_id: alice,
    kind: "project",
    target_id: project_id,
    patch: { scanned_at: 5000 },
  });
  expect(state.scanned_at).toBe(5000);
  expect(
    (await listPersonalStates({ account_id: alice, kind: "project" }))[0]
      .scanned_at,
  ).toBe(5000);
});

test("shared work: a person's agents and their artifacts in shared projects only", async () => {
  const agent = "33333333-3333-4333-8333-333333333333";
  const unregistered = "44444444-4444-4444-8444-444444444444";
  await getPool().query(
    `INSERT INTO agent_identities
       (agent_id, project_id, path, thread_id, name, created_by, created_at,
        conversation_history)
     VALUES ($1, $2, '/home/user/a.chat', 'current', 'helper', $3, NOW(),
             '[{"thread_id": "older", "ended_at": "2026-01-01"}]'::jsonb)`,
    [agent, project_id, bob],
  );
  await getPool().query(
    `INSERT INTO artifact_catalog_sources (source_id, project_id, chat_path)
     VALUES ('src', $1, '/home/user/a.chat')`,
    [project_id],
  );
  const artifact = (entry: string, thread: string, title: string) =>
    getPool().query(
      `INSERT INTO artifact_catalog
         (entry_id, source_id, project_id, thread_id, artifact_id, metadata,
          created_at, deleted)
       VALUES ($1, 'src', $2, $3, $1, $4, NOW(), false)`,
      [entry, project_id, thread, JSON.stringify({ title, kind: "file" })],
    );
  await artifact("a".repeat(64), "current", "From current thread");
  await artifact("b".repeat(64), "older", "From earlier thread");
  await artifact("c".repeat(64), unregistered, "Unattributed");
  const work = await listSharedWork({
    viewer_id: alice,
    person_id: bob,
    project_ids: [project_id, other_project_id],
  });
  expect(work.agents.map((a) => a.name)).toEqual(["helper"]);
  expect(work.agents[0].collaborator_access).toBe("message");
  // Only the creator can state "view only"; others can read it.
  await expect(
    setAgentAccess({
      account_id: alice,
      project_id,
      agent_id: agent,
      access: "view",
    }),
  ).rejects.toThrow("creator");
  await setAgentAccess({
    account_id: bob,
    project_id,
    agent_id: agent,
    access: "view",
  });
  expect(
    await getAgentAccess({ account_id: alice, project_id, agent_id: agent }),
  ).toEqual({ access: "view", is_creator: false });
  expect(work.artifacts.map((a) => a.title).sort()).toEqual([
    "From current thread",
    "From earlier thread",
  ]);
  // Removing the viewer from the project hides everything there.
  await setUsers(project_id, { [bob]: "collaborator" });
  expect(
    await listSharedWork({
      viewer_id: alice,
      person_id: bob,
      project_ids: [project_id],
    }),
  ).toEqual({ agents: [], artifacts: [] });
});

test("project agents: other people's registered agents in the viewer's projects", async () => {
  const insert = (agent_id: string, created_by: string, name: string) =>
    getPool().query(
      `INSERT INTO agent_identities
         (agent_id, project_id, path, thread_id, name, created_by, created_at)
       VALUES ($1, $2, $4, 't', $3, $5, NOW())`,
      [agent_id, project_id, name, `/home/user/${name}.chat`, created_by],
    );
  await insert("55555555-5555-4555-8555-555555555555", bob, "bobs");
  await insert("66666666-6666-4666-8666-666666666666", alice, "mine");
  const list = () =>
    listProjectAgents({ viewer_id: alice, project_ids: [project_id] });
  // The viewer's own agents are not "shared with me".
  expect((await list()).map((a) => [a.name, a.created_by])).toEqual([
    ["bobs", bob],
  ]);
  await getPool().query(
    "UPDATE agent_identities SET disabled_at = NOW() WHERE name = 'bobs'",
  );
  expect(await list()).toEqual([]);
  await getPool().query(
    "UPDATE agent_identities SET disabled_at = NULL WHERE name = 'bobs'",
  );
  // Not a collaborator: nothing.
  await setUsers(project_id, { [bob]: "owner" });
  expect(await list()).toEqual([]);
});

test("agent appearance: any collaborator records the thread theme; lists include it", async () => {
  const agent_id = "88888888-8888-4888-8888-888888888888";
  await getPool().query(
    `INSERT INTO agent_identities
       (agent_id, project_id, path, thread_id, name, created_by, created_at)
     VALUES ($1, $2, '/home/user/t.chat', 't', 'themed', $3, NOW())`,
    [agent_id, project_id, bob],
  );
  // alice is a collaborator, not the creator.
  await setAgentAppearance({
    account_id: alice,
    project_id,
    agent_id,
    appearance: { name: " Reviewer ", thread_color: "#123456", extra: "x" },
  });
  const [listed] = await listProjectAgents({
    viewer_id: alice,
    project_ids: [project_id],
  });
  expect(listed.appearance).toEqual({
    name: "Reviewer",
    thread_color: "#123456",
  });
  await setAgentAppearance({
    account_id: alice,
    project_id,
    agent_id,
    appearance: null,
  });
  expect(
    (
      await listProjectAgents({ viewer_id: alice, project_ids: [project_id] })
    )[0].appearance,
  ).toBeNull();
  // Not a collaborator: refused.
  await setUsers(project_id, { [bob]: "owner" });
  await expect(
    setAgentAppearance({
      account_id: alice,
      project_id,
      agent_id,
      appearance: {},
    }),
  ).rejects.toThrow("agent not found");
});
