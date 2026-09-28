import { randomUUID } from "node:crypto";
import "@cocalc/util/db-schema/collaborators-workspace";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { entryKey, syncCollaboratorsSchema } from "./collaborators-common";
import { listCollaborationResources } from "./collaborators-discovery";

const account_id = randomUUID();
const participants = Array.from({ length: 70 }, () => randomUUID());
const projects = Array.from({ length: 4 }, () => randomUUID());
const generation = randomUUID();
const source = {
  project_id: projects[0],
  kind: "conversation" as const,
  resource_id: "source",
};
beforeAll(async () => {
  await initEphemeralDatabase({});
  await syncCollaboratorsSchema();
  await getPool().query("INSERT INTO accounts(account_id) VALUES($1)", [
    account_id,
  ]);
  for (const [i, project_id] of projects.entries()) {
    const users = Object.fromEntries(
      [account_id, ...participants.slice(0, i === 2 ? 69 : 70)].map((id) => [
        id,
        { group: "collaborator" },
      ]),
    );
    await getPool().query(
      "INSERT INTO account_project_index(account_id,project_id,title,users_summary) VALUES($1,$2,$3,$4)",
      [account_id, project_id, `Project ${i}`, users],
    );
    await getPool().query(
      "INSERT INTO collaboration_access(account_id,project_id,generation,lease_until,complete) VALUES($1,$2,$3,now()+interval '1 hour',true)",
      [account_id, project_id, generation],
    );
    const target = i
      ? { ...source, project_id, resource_id: `target-${i}` }
      : source;
    const metadata = {
      ...target,
      title: `Work ${i}`,
      thread_id: target.resource_id,
      chat_path: "/work.chat",
      participant_ids: participants.slice(0, 1),
      participants_truncated: true,
      participant_count: 70,
      activity: i,
      created_at: 0,
      updated_at: i,
    };
    await getPool().query(
      "INSERT INTO collaboration_index(account_id,entry_key,project_id,generation,kind,activity,metadata,search_text,relation_set,relations_complete) VALUES($1,$2,$3,$4,'conversation',$5,$6,$7,'complete-set',true)",
      [
        account_id,
        entryKey(target),
        project_id,
        generation,
        i,
        metadata,
        metadata.title,
      ],
    );
  }
  await getPool().query(
    "INSERT INTO collaboration_participant_index(account_id,entry_key,project_id,set_key,participant_id) SELECT $1,$2,$3,'complete-set',id FROM unnest($4::uuid[]) id",
    [account_id, entryKey(source), projects[0], participants],
  );
  await getPool().query(
    "UPDATE collaboration_access SET lease_until=now()-interval '1 minute' WHERE project_id=$1",
    [projects[3]],
  );
  await getPool().query(
    "INSERT INTO collaboration_personal(account_id,entry_key,project_id,alias) VALUES($1,$2,$3,'chat1')",
    [account_id, entryKey(source), projects[0]],
  );
}, 60000);
afterAll(async () => {
  await testCleanup();
});

test("shared scope intersects ALL participants before pagination, including beyond the summary", async () => {
  const opts = { account_id, shared_with: source, limit: 1 };
  const first = await listCollaborationResources(opts);
  expect(first.items.map((r) => r.project_id)).toEqual([projects[1]]);
  expect(first.next).toBeDefined();
  const second = await listCollaborationResources({
    ...opts,
    after: first.next,
  });
  expect(second.items.map((r) => r.project_id)).toEqual([projects[0]]);
  expect(second.next).toBeUndefined();
  await expect(
    listCollaborationResources({ account_id, after: first.next }),
  ).rejects.toThrow("cursor");
});

test("private alias prefix search works without depending on indexed title text", async () => {
  expect(
    (
      await listCollaborationResources({ account_id, search: "CHAT" })
    ).items.map((r) => r.resource_id),
  ).toEqual(["source"]);
  expect(
    (await listCollaborationResources({ account_id, search: "%" })).items,
  ).toEqual([]);
});

test.each([
  "incomplete",
  "source access",
  "candidate membership",
  "source archived",
])("does not broaden scope when %s changes", async (mode) => {
  const db = getPool();
  try {
    if (mode === "incomplete")
      await db.query(
        "UPDATE collaboration_index SET relations_complete=false WHERE entry_key=$1",
        [entryKey(source)],
      );
    if (mode === "source access")
      await db.query(
        "UPDATE collaboration_access SET lease_until=now()-interval '1 minute' WHERE project_id=$1",
        [projects[0]],
      );
    if (mode === "candidate membership")
      await db.query(
        "UPDATE account_project_index SET users_summary=users_summary-$1 WHERE project_id=ANY($2::uuid[])",
        [account_id, projects],
      );
    if (mode === "source archived")
      await db.query(
        "UPDATE collaboration_index SET metadata=metadata || '{\"archived\":true}' WHERE entry_key=$1",
        [entryKey(source)],
      );
    expect(
      (await listCollaborationResources({ account_id, shared_with: source }))
        .items,
    ).toEqual([]);
  } finally {
    await db.query(
      "UPDATE collaboration_index SET relations_complete=true,metadata=metadata-'archived' WHERE entry_key=$1",
      [entryKey(source)],
    );
    await db.query(
      "UPDATE collaboration_access SET lease_until=now()+interval '1 hour' WHERE project_id=$1",
      [projects[0]],
    );
    await db.query(
      "UPDATE account_project_index SET users_summary=users_summary || $1::jsonb",
      [JSON.stringify({ [account_id]: { group: "collaborator" } })],
    );
  }
});
