import { randomUUID } from "node:crypto";
// Source-only notification adapter and compiled schema setup must share PGlite.
jest.mock("../pool", () => jest.requireActual("@cocalc/database/pool"));
import "@cocalc/util/db-schema/collaborators-workspace";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";
import {
  entryKey,
  hash,
  syncCollaboratorsSchema,
} from "./collaborators-common";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import { adaptCollaborationAgents } from "./collaborators-agent-identity";
import {
  collaborationAgentPersonalResource,
  reconcileCollaborationAgentPersonalState,
} from "./collaborators-agent-personal";
import {
  applyArtifactCatalogSnapshot,
  registerArtifactCatalogSource,
  readArtifactCatalogEntry,
} from "./artifact-catalog";
import { checkCollaborationRevision } from "./collaborators-changes";
import {
  collaborationArtifactPin,
  clearCollaborationAgentFallback,
} from "./collaborators-personal";
import {
  applyCollaborationAccess,
  claimCollaborationAccess,
  readCollaborationAccess,
} from "./collaborators-access";
import { ensureCollaborationNotificationSchema } from "./collaborators-notifications";
import { collaborationCheckpointPage } from "./collaborators-checkpoint";
import {
  readCollaborationProjectPage,
  overlayCollaborationProjectPage,
} from "./collaborators-project-page";
import {
  collaborationRoomForHost,
  collaborationSourcePage,
  collaborationWriterState,
  compactCollaborationProject,
  ensureCollaborationRoom,
  getOwnedCollaborationResource,
  ingestCollaborationSnapshot,
  readCollaborationProjection,
  registerCollaborationSource,
  reconcileCollaborationAgents,
  relocateCollaborationSource,
  markCollaborationRoomInitialized,
} from "./collaborators-owner";
import {
  applyCollaborationProjection,
  claimCollaborationProjectionJobs,
  failCollaborationProjection,
  seedCollaborationProjectionJobs,
} from "./collaborators-projection";
import {
  getCollaborationPersonalState,
  listCollaborationPeople,
  listCollaborationProjects,
  listCollaborationResources,
  setCollaborationPersonalState,
} from "./collaborators-discovery";

const project_id = "11111111-1111-4111-8111-111111111111";
const host_id = "22222222-2222-4222-8222-222222222222";
const account_id = "33333333-3333-4333-8333-333333333333";
const other_id = "44444444-4444-4444-8444-444444444444";
const authority = { owning_bay_id: "bay-test", host_id };
const previousBay = process.env.COCALC_BAY_ID;
const source = { project_id, chat_path: "/home/user/work.chat" };
let epoch: string;
const resource = (id = "thread"): CollaborationResource => ({
  ...source,
  kind: "conversation",
  resource_id: id,
  thread_id: id,
  title: `Calculus ${id}`,
  participant_ids: [other_id],
  created_by: other_id,
  created_at: 1000,
  updated_at: 2000,
  activity: 3,
});
const snapshot = (
  sequence = 1,
  resources = [resource()],
): CollaborationSourceSnapshot => ({ ...source, epoch, sequence, resources });
test("writer metadata exposes only the enabled current-writer canonical pointer without creating or initializing rooms", async () => {
  expect(
    (await collaborationWriterState(source, authority, true))?.canonical_room,
  ).toBeUndefined();
  expect(
    (await getPool().query("SELECT count(*) AS n FROM collaboration_rooms"))
      .rows[0].n,
  ).toBe("0");
  const room = await ensureCollaborationRoom(
    project_id,
    account_id,
    randomUUID(),
    authority,
  );
  const canonical = { project_id, chat_path: room.chat_path };
  const canonicalEpoch = await registerCollaborationSource(
    canonical,
    authority,
    null,
    randomUUID(),
  );
  expect(
    (await collaborationWriterState(canonical, authority, true))
      ?.canonical_room,
  ).toEqual({ ...room, initialized: false });
  await markCollaborationRoomInitialized(
    { ...room, requesting_account_id: account_id },
    authority,
  );
  expect(
    (await collaborationWriterState(canonical, authority, true))
      ?.canonical_room,
  ).toEqual({ ...room, initialized: true });
  expect(
    (await collaborationWriterState(canonical, authority, false))
      ?.canonical_room,
  ).toBeUndefined();
  expect(
    (await collaborationWriterState(source, authority, true))?.canonical_room,
  ).toBeUndefined();
  const moved = { project_id, chat_path: "/home/user/renamed.chat" };
  await relocateCollaborationSource(
    {
      project_id,
      from_chat_path: canonical.chat_path,
      to_chat_path: moved.chat_path,
      operation_id: randomUUID(),
      expected_epoch: canonicalEpoch,
      expected_destination_epoch: null,
    },
    authority,
  );
  expect(
    (await collaborationWriterState(canonical, authority, true))
      ?.canonical_room,
  ).toBeUndefined();
  expect(
    (await collaborationWriterState(moved, authority, true))?.canonical_room,
  ).toMatchObject({ ...moved, room_id: room.room_id, initialized: true });
  await expect(
    collaborationWriterState(
      moved,
      { ...authority, host_id: randomUUID() },
      true,
    ),
  ).rejects.toThrow();
});
test("host migration withholds the canonical pointer until the assigned host registers against the current epoch", async () => {
  const room = await ensureCollaborationRoom(
    project_id,
    account_id,
    randomUUID(),
    authority,
  );
  const canonical = { project_id, chat_path: room.chat_path };
  const oldEpoch = await registerCollaborationSource(
    canonical,
    authority,
    null,
    randomUUID(),
  );
  await markCollaborationRoomInitialized(
    { ...room, requesting_account_id: account_id },
    authority,
  );
  const assigned = { ...authority, host_id: randomUUID() };
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    project_id,
    assigned.host_id,
  ]);
  await expect(
    collaborationWriterState(canonical, authority, true),
  ).rejects.toThrow("owner/host");
  const before = await collaborationWriterState(canonical, assigned, true);
  expect(before).toMatchObject({
    writer_host_id: host_id,
    registration_id: null,
    source_sequence: 0,
  });
  expect(before?.epoch).not.toBe(oldEpoch);
  expect(before).not.toHaveProperty("canonical_room");
  await expect(
    collaborationWriterState(canonical, assigned, false),
  ).resolves.toEqual(before);
  await expect(
    registerCollaborationSource(canonical, assigned, oldEpoch, randomUUID()),
  ).rejects.toThrow("epoch");
  const registration_id = randomUUID();
  const currentEpoch = await registerCollaborationSource(
    canonical,
    assigned,
    before!.epoch,
    registration_id,
  );
  const current = await collaborationWriterState(canonical, assigned, true);
  expect(current).toEqual({
    epoch: currentEpoch,
    registration_id,
    source_sequence: 0,
    writer_host_id: assigned.host_id,
    canonical_room: { ...room, initialized: true },
  });
  const { canonical_room: _room, ...metadata } = current!;
  await expect(
    collaborationWriterState(canonical, assigned, false),
  ).resolves.toEqual(metadata);
  await expect(
    ingestCollaborationSnapshot(
      { ...canonical, epoch: oldEpoch, sequence: 1, resources: [] },
      assigned,
    ),
  ).rejects.toThrow("writer epoch");
});
async function projectIndex(role = "collaborator") {
  const users = {
    [account_id]: { group: role },
    [other_id]: { group: "owner" },
  };
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [project_id, JSON.stringify(users)],
  );
  await getPool().query(
    `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,title,users_summary,sort_key)
    VALUES($1,$2,'bay-test','Calculus project',$3::jsonb,now()) ON CONFLICT(account_id,project_id) DO UPDATE SET users_summary=excluded.users_summary`,
    [account_id, project_id, JSON.stringify(users)],
  );
}
async function job() {
  await seedCollaborationProjectionJobs("bay-test");
  await getPool().query(
    "UPDATE collaboration_access SET due_at=now() WHERE account_id=$1",
    [account_id],
  );
  const j = (await claimCollaborationProjectionJobs("bay-test"))[0];
  if (!j) throw Error("missing projection job");
  return j;
}
async function deliver() {
  const j = await job();
  const started = Date.now();
  const page = await readCollaborationProjection(j, authority);
  await applyCollaborationProjection(j, page, started);
  return page;
}
beforeAll(async () => {
  process.env.COCALC_BAY_ID = "bay-test";
  await initEphemeralDatabase({});
  await syncCollaboratorsSchema();
  await ensureCollaborationNotificationSchema();
}, 60000);
beforeEach(async () => {
  await getPool().query("TRUNCATE collaboration_memberships");
  await getPool().query("TRUNCATE collaboration_source_requests");
  await getPool().query(
    "TRUNCATE collaboration_notification_events,collaboration_notification_floors,collaboration_notification_cursors",
  );
  await getPool().query(
    "TRUNCATE collaboration_artifact_bindings,collaboration_relocations,artifact_catalog,artifact_catalog_sources,artifact_catalog_project_budget,collaboration_account_state,collaboration_projects,collaboration_sources,collaboration_catalog,collaboration_rooms,collaboration_access,collaboration_index,collaboration_personal,collaboration_maintenance,account_project_index,account_collaborator_index,personal_library_aliases,personal_library_pins,agent_personal_names,projects,accounts CASCADE",
  );
  await getPool().query(
    "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'bay-test'),($2,'bay-test')",
    [account_id, other_id],
  );
  await getPool().query(
    "INSERT INTO projects(project_id,host_id,owning_bay_id,users) VALUES($1,$2,'bay-test','{}')",
    [project_id, host_id],
  );
  await projectIndex();
  epoch = await registerCollaborationSource(
    source,
    authority,
    null,
    randomUUID(),
  );
});

test("batched leases make 1000 cold projects browsable without catalog pages and remain bounded", async () => {
  const ids = Array.from({ length: 999 }, () => randomUUID());
  const users = JSON.stringify({ [account_id]: { group: "collaborator" } });
  await getPool().query(
    `INSERT INTO projects(project_id,owning_bay_id,users)
    SELECT id,'bay-test',$2::jsonb FROM unnest($1::uuid[]) AS p(id)`,
    [ids, users],
  );
  await getPool().query(
    `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,title,users_summary,sort_key)
    SELECT $1,id,'bay-test','Cold project',$3::jsonb,now() FROM unnest($2::uuid[]) AS p(id)`,
    [account_id, ids, users],
  );
  await seedCollaborationProjectionJobs("bay-test");
  await seedCollaborationProjectionJobs("bay-test");
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const jobs = await claimCollaborationAccess("bay-test");
    expect(jobs).toHaveLength(50);
    const at = Date.now();
    total += await applyCollaborationAccess(
      jobs,
      await readCollaborationAccess(jobs, "bay-test"),
      at,
    );
  }
  expect(total).toBe(1000);
  expect(await claimCollaborationAccess("bay-test")).toEqual([]);
  const page = await listCollaborationProjects({ account_id, limit: 50 });
  expect(page.items).toHaveLength(50);
  expect(page.next).toBeDefined();
  expect(page.coverage).toBe("indexing");
  expect(
    Number(
      (await getPool().query("SELECT count(*) AS n FROM collaboration_index"))
        .rows[0].n,
    ),
  ).toBe(0);
  expect(
    Number(
      (await getPool().query("SELECT count(*) AS n FROM collaboration_sources"))
        .rows[0].n,
    ),
  ).toBe(1);
}, 30000);

test("lease batches fence delayed projection replies and hide old generations before backfill", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  const pending = await job();
  const oldPage = await readCollaborationProjection(pending, authority);
  await getPool().query(
    "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
    [project_id, JSON.stringify({ [randomUUID()]: { group: "viewer" } })],
  );
  await getPool().query("UPDATE collaboration_access SET lease_due_at=now()");
  const jobs = await claimCollaborationAccess("bay-test");
  const at = Date.now();
  await applyCollaborationAccess(
    jobs,
    await readCollaborationAccess(jobs, "bay-test"),
    at,
  );
  expect((await listCollaborationResources({ account_id })).items).toHaveLength(
    0,
  );
  expect(await applyCollaborationProjection(pending, oldPage, at)).toBe(false);
  await getPool().query("UPDATE collaboration_access SET claim_until=NULL");
  await deliver();
  expect((await listCollaborationResources({ account_id })).items).toHaveLength(
    1,
  );
  await getPool().query("UPDATE collaboration_access SET lease_due_at=now()");
  const delayed = await claimCollaborationAccess("bay-test");
  const grants = await readCollaborationAccess(delayed, "bay-test");
  await getPool().query("UPDATE projects SET users='{}' WHERE project_id=$1", [
    project_id,
  ]);
  await getPool().query(
    "UPDATE collaboration_access SET lease_due_at=now(),lease_claim_until=NULL",
  );
  const revoked = await claimCollaborationAccess("bay-test");
  await applyCollaborationAccess(
    revoked,
    await readCollaborationAccess(revoked, "bay-test"),
    Date.now(),
  );
  expect(await applyCollaborationAccess(delayed, grants, Date.now())).toBe(0);
  expect((await listCollaborationResources({ account_id })).items).toHaveLength(
    0,
  );
  expect((await listCollaborationProjects({ account_id })).items).toHaveLength(
    0,
  );
});

test("disabled registration rejects new sources without persistent rollout metadata", async () => {
  await getPool().query(
    "TRUNCATE collaboration_sources,collaboration_projects",
  );
  expect(await collaborationWriterState(source, authority)).toBeNull();
  await collaborationSourcePage(project_id, authority);
  await expect(
    registerCollaborationSource(source, authority, null, randomUUID(), false),
  ).rejects.toThrow("not enabled");
  expect(
    (await getPool().query("SELECT * FROM collaboration_projects")).rows,
  ).toEqual([]);
  expect(
    (await getPool().query("SELECT * FROM collaboration_sources")).rows,
  ).toEqual([]);
});

test("host recovery checkpoints page activity floors and fence changed sources and former hosts", async () => {
  const resources = Array.from({ length: 65 }, (_, i) => ({
    ...resource(`floor-${i}`),
    activity: 100 + i,
  }));
  await ingestCollaborationSnapshot(snapshot(1, resources), authority);
  const first = await collaborationCheckpointPage(source, authority);
  expect(first.epoch).toBe(epoch);
  expect(first.items).toHaveLength(50);
  const second = await collaborationCheckpointPage(
    { ...source, after: first.next },
    authority,
  );
  expect(second.items).toHaveLength(15);
  expect(
    new Set([...first.items, ...second.items].map((r) => r.resource_id)).size,
  ).toBe(65);
  expect(
    Math.max(...[...first.items, ...second.items].map((r) => r.activity)),
  ).toBe(164);
  await ingestCollaborationSnapshot(
    snapshot(
      2,
      resources.map((r) => ({ ...r, activity: r.activity + 1 })),
    ),
    authority,
  );
  await expect(
    collaborationCheckpointPage({ ...source, after: first.next }, authority),
  ).rejects.toThrow("changed");
  const nextHost = { ...authority, host_id: randomUUID() };
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    project_id,
    nextHost.host_id,
  ]);
  await expect(collaborationCheckpointPage(source, authority)).rejects.toThrow(
    "owner/host",
  );
  const recovered = await collaborationCheckpointPage(source, nextHost);
  expect(recovered.epoch).not.toBe(epoch);
  expect(recovered.items).toHaveLength(50);
  expect(recovered.items.every((r) => r.activity >= 101)).toBe(true);
});

test("deleted resource checkpoints retain content-free activity floors across restore", async () => {
  const original = { ...resource("restore-after-loss"), activity: 987 };
  await ingestCollaborationSnapshot(snapshot(1, [original]), authority);
  await ingestCollaborationSnapshot(snapshot(2, []), authority);
  const checkpoint = await collaborationCheckpointPage(source, authority);
  expect(checkpoint.items).toEqual([
    { resource_id: original.resource_id, kind: original.kind, activity: 987 },
  ]);
  const tombstone = (
    await getPool().query(
      "SELECT metadata FROM collaboration_catalog WHERE entry_key=$1",
      [entryKey(original)],
    )
  ).rows[0];
  expect(tombstone.metadata).toBeNull();
  await ingestCollaborationSnapshot(
    snapshot(3, [{ ...original, activity: 1 }]),
    authority,
  );
  expect(
    (await collaborationCheckpointPage(source, authority)).items[0].activity,
  ).toBe(987);
  expect(
    (await getOwnedCollaborationResource(original, account_id, authority))
      ?.activity,
  ).toBe(987);
});

test("selected-project fallback keyset pages owner metadata and overlays personal state without account projection", async () => {
  const items = Array.from({ length: 65 }, (_, i) =>
    resource(`entry-${i.toString().padStart(2, "0")}`),
  );
  await ingestCollaborationSnapshot(snapshot(1, items), authority);
  await setCollaborationPersonalState(
    account_id,
    items[0],
    { alias: "unprojected-label", collected: true },
    items[0],
  );
  const first = await readCollaborationProjectPage(
    { account_id, project_id, limit: 50 },
    authority,
  );
  expect(first.items).toHaveLength(50);
  expect(first.next).toBeDefined();
  const second = await readCollaborationProjectPage(
    { account_id, project_id, limit: 50, after: first.next },
    authority,
  );
  expect(second.items).toHaveLength(15);
  expect(
    new Set([...first.items, ...second.items].map((r) => r.resource_id)).size,
  ).toBe(65);
  const overlay = await overlayCollaborationProjectPage(
    account_id,
    first.items.some((r) => r.resource_id === items[0].resource_id)
      ? first
      : second,
  );
  expect(
    overlay.items.find((r) => r.resource_id === items[0].resource_id)?.personal,
  ).toMatchObject({ alias: "unprojected-label", collected: true });
  expect(
    (await getPool().query("SELECT * FROM collaboration_index")).rows,
  ).toEqual([]);
  expect(
    (
      await readCollaborationProjectPage(
        { account_id, project_id, search: "Calculus", person_id: other_id },
        authority,
      )
    ).items,
  ).toHaveLength(50);
  await expect(
    readCollaborationProjectPage(
      { account_id, project_id, search: "changed", after: first.next },
      authority,
    ),
  ).rejects.toThrow("cursor");
  await projectIndex("viewer");
  await expect(
    readCollaborationProjectPage({ account_id, project_id }, authority),
  ).rejects.toThrow("access denied");
});

test("unnamed agent shortcuts survive enrichment without competing with existing endpoint names", async () => {
  const item = {
    ...resource(),
    kind: "agent" as const,
    resource_id: "agent-thread:thread",
  };
  await ingestCollaborationSnapshot(snapshot(1, [item]), authority);
  await deliver();
  await setCollaborationPersonalState(
    account_id,
    item,
    { alias: "private-label", collected: true, following: true },
    item,
  );
  expect(
    (
      await listCollaborationResources({
        account_id,
        scope: "collected",
        search: "private",
      })
    ).items[0]?.personal,
  ).toMatchObject({ alias: "private-label", collected: true });
  const agent_id = randomUUID();
  await getPool().query(
    "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,$3,$4,'Known agent',$5)",
    [agent_id, project_id, source.chat_path, item.thread_id, other_id],
  );
  await ingestCollaborationSnapshot(snapshot(2, [item]), authority);
  await deliver();
  const enriched = { ...item, agent_id };
  expect(
    (await listCollaborationResources({ account_id, scope: "collected" }))
      .items[0]?.personal,
  ).toMatchObject({ alias: "private-label", collected: true });
  await getPool().query(
    "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'existing-agent',$2,$3,'{}')",
    [account_id, project_id, agent_id],
  );
  expect(
    (await listCollaborationResources({ account_id, scope: "collected" }))
      .items[0]?.personal,
  ).toMatchObject({ alias: "existing-agent", collected: true });
  await clearCollaborationAgentFallback(account_id, enriched, {
    alias: true,
    collected: true,
  });
  expect(
    (await listCollaborationResources({ account_id, scope: "collected" }))
      .items,
  ).toHaveLength(0);
  expect(
    (
      await getCollaborationPersonalState(account_id, {
        ...item,
        resource_id: agent_id,
      })
    ).following,
  ).toBe(true);
});

test.each([false, true])(
  "canonical agent identity, legacy refs and personal choices survive successor ingestion (%s)",
  async (reverse) => {
    const old = {
      ...resource("agent-thread:old"),
      kind: "agent" as const,
      thread_id: "old",
    };
    await ingestCollaborationSnapshot(snapshot(1, [old]), authority);
    await deliver();
    await setCollaborationPersonalState(
      account_id,
      old,
      {
        alias: "personal-label",
        collected: true,
        following: true,
        muted: true,
      },
      old,
    );
    const agent_id = randomUUID();
    await getPool().query(
      "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,$3,'old','Registered',$4)",
      [agent_id, project_id, source.chat_path, account_id],
    );
    await ingestCollaborationSnapshot(snapshot(2, [old]), authority);
    await deliver();
    const canonical = {
      project_id,
      kind: "agent" as const,
      resource_id: agent_id,
    };
    expect(
      await getCollaborationPersonalState(account_id, canonical),
    ).toMatchObject({
      alias: "personal-label",
      collected: true,
      following: true,
      muted: true,
    });
    await getPool().query(
      "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'registered-name',$2,$3,'{}')",
      [account_id, project_id, agent_id],
    );
    await getPool().query(
      "UPDATE agent_identities SET thread_id='new',conversation_history=$2::jsonb WHERE agent_id=$1",
      [agent_id, JSON.stringify([{ thread_id: "old" }])],
    );
    // Point lookup follows the authoritative endpoint before maintenance or source publication.
    expect(
      await getOwnedCollaborationResource(old, account_id, authority),
    ).toMatchObject({
      resource_id: old.resource_id,
      agent_id,
      thread_id: "new",
    });
    await reconcileCollaborationAgents(project_id, authority);
    const next = {
      ...old,
      resource_id: "agent-thread:new",
      thread_id: "new",
      title: "Successor",
      activity: 1,
    };
    let sequence = 2;
    const order = reverse
      ? [[next], [{ ...old, archived: true }]]
      : [[{ ...old, archived: true }], [next]];
    for (const resources of [...order, reverse ? [next, old] : [old, next]]) {
      await ingestCollaborationSnapshot(
        snapshot(++sequence, resources),
        authority,
      );
      await deliver();
      const page = await listCollaborationResources({
        account_id,
        kind: "agent",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        resource_id: agent_id,
        thread_id: "new",
        personal: {
          alias: "registered-name",
          collected: true,
          following: true,
          muted: true,
        },
      });
      for (const target of [old, next, canonical])
        expect(
          await getOwnedCollaborationResource(target, account_id, authority),
        ).toMatchObject({
          resource_id: target.resource_id,
          agent_id,
          thread_id: "new",
        });
    }
    expect(
      (
        await getPool().query(
          "SELECT count(*) AS n FROM agent_identities WHERE project_id=$1",
          [project_id],
        )
      ).rows[0].n,
    ).toBe("1");
    const checkpoint = await collaborationCheckpointPage(source, authority);
    expect(checkpoint.items).toContainEqual({
      kind: "agent",
      resource_id: next.resource_id,
      activity: 1,
    });
    expect(checkpoint.items.some((r) => r.resource_id === agent_id)).toBe(
      false,
    );
    await ingestCollaborationSnapshot(
      snapshot(++sequence, [{ ...next, activity: 2 }]),
      authority,
    );
    expect(
      await getOwnedCollaborationResource(canonical, account_id, authority),
    ).toMatchObject({ activity: 5 });
    await getPool().query(
      "UPDATE agent_identities SET disabled_at=now() WHERE agent_id=$1",
      [agent_id],
    );
    expect(
      await getOwnedCollaborationResource(old, account_id, authority),
    ).toBeNull();
    await reconcileCollaborationAgents(project_id, authority);
    await ingestCollaborationSnapshot(
      snapshot(++sequence, [old, next]),
      authority,
    );
    expect(
      await getOwnedCollaborationResource(canonical, account_id, authority),
    ).toBeNull();
  },
);

test("deleted canonical agents retain legacy identity claims after compaction", async () => {
  const agent_id = randomUUID();
  const old = {
    ...resource("agent-thread:old"),
    kind: "agent" as const,
    thread_id: "old",
  };
  await getPool().query(
    "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,$3,'old','Registered',$4)",
    [agent_id, project_id, source.chat_path, account_id],
  );
  await ingestCollaborationSnapshot(snapshot(1, [old]), authority);
  await ingestCollaborationSnapshot(snapshot(2, []), authority);
  await getPool().query(
    "UPDATE collaboration_catalog SET deleted_at=now()-interval '8 days' WHERE project_id=$1",
    [project_id],
  );
  await compactCollaborationProject(project_id, authority);
  await getPool().query(
    "UPDATE agent_identities SET disabled_at=now() WHERE agent_id=$1",
    [agent_id],
  );
  const replacement = randomUUID();
  await getPool().query(
    "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by,conversation_history) VALUES($1,$2,$3,'replacement','Replacement',$4,$5::jsonb)",
    [
      replacement,
      project_id,
      source.chat_path,
      account_id,
      JSON.stringify([{ thread_id: "old" }]),
    ],
  );
  await expect(
    ingestCollaborationSnapshot(
      snapshot(3, [
        {
          ...old,
          resource_id: "agent-thread:replacement",
          thread_id: "replacement",
        },
      ]),
      authority,
    ),
  ).rejects.toThrow("another identity");
  expect(
    await getOwnedCollaborationResource(old, account_id, authority),
  ).toBeNull();
});

test("namespaced copies cannot inherit a registered identity or its personal state", async () => {
  const agent_id = randomUUID();
  const old = {
    ...resource("agent-thread:thread"),
    kind: "agent" as const,
    thread_id: "thread",
  };
  await getPool().query(
    "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,$3,'thread','Registered',$4)",
    [agent_id, project_id, source.chat_path, account_id],
  );
  const copy = { ...old, resource_id: `copy:${randomUUID()}`, agent_id };
  await ingestCollaborationSnapshot(snapshot(1, [old, copy]), authority);
  await deliver();
  const resolved = await getOwnedCollaborationResource(
    copy,
    account_id,
    authority,
  );
  expect(resolved).toMatchObject({
    resource_id: copy.resource_id,
    thread_id: "thread",
  });
  expect(resolved?.agent_id).toBeUndefined();
  await setCollaborationPersonalState(
    account_id,
    copy,
    { alias: "copy-only", collected: true },
    resolved!,
  );
  expect(
    (
      await listCollaborationResources({ account_id, scope: "collected" })
    ).items.map((r) => r.resource_id),
  ).toEqual([copy.resource_id]);
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM agent_personal_names WHERE account_id=$1",
        [account_id],
      )
    ).rows[0].n,
  ).toBe("0");
});

test("owner legacy successor rows migrate past the 50-row maintenance boundary without trusting host assertions", async () => {
  const legacy = Array.from({ length: 51 }, (_, i) => ({
    ...resource(`agent-thread:old-${i}`),
    kind: "agent" as const,
    thread_id: `old-${i}`,
  }));
  await ingestCollaborationSnapshot(snapshot(1, legacy), authority);
  const identities = legacy.map((r, i) => ({
    agent_id: randomUUID(),
    old: r.thread_id,
    current: `new-${i}`,
  }));
  await getPool().query(
    `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by,conversation_history)
    SELECT agent_id,$1,$2,current,'Registered',$3,jsonb_build_array(jsonb_build_object('thread_id',old))
    FROM jsonb_to_recordset($4::jsonb) AS e(agent_id uuid,old text,current text)`,
    [project_id, source.chat_path, account_id, JSON.stringify(identities)],
  );
  const asserted = {
    ...legacy[0],
    thread_id: identities[0].current,
    agent_id: identities[0].agent_id,
  };
  expect(
    await adaptCollaborationAgents(getPool(), source, [asserted]),
  ).toMatchObject({
    bindings: [],
    resources: [
      { resource_id: asserted.resource_id, thread_id: asserted.thread_id },
    ],
  });
  expect(
    (await adaptCollaborationAgents(getPool(), source, [asserted])).resources[0]
      .agent_id,
  ).toBeUndefined();
  // This is the persisted shape produced by the previous owner reconciler.
  await getPool().query(
    `UPDATE collaboration_catalog c SET metadata=c.metadata || jsonb_build_object('agent_id',e.agent_id,'thread_id',e.current)
    FROM jsonb_to_recordset($2::jsonb) AS e(agent_id uuid,old text,current text)
    WHERE c.project_id=$1 AND c.resource_id='agent-thread:' || e.old`,
    [project_id, JSON.stringify(identities)],
  );
  expect(await reconcileCollaborationAgents(project_id, authority)).toBe(50);
  expect(await reconcileCollaborationAgents(project_id, authority)).toBe(1);
  expect(await reconcileCollaborationAgents(project_id, authority)).toBe(0);
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_catalog WHERE project_id=$1 AND deleted_at IS NULL AND resource_id=metadata->>'agent_id'",
        [project_id],
      )
    ).rows[0].n,
  ).toBe("51");
  const owned = await getOwnedCollaborationResource(
    legacy[0],
    account_id,
    authority,
  );
  expect(owned).toMatchObject({
    resource_id: legacy[0].resource_id,
    agent_id: identities[0].agent_id,
    thread_id: identities[0].current,
  });
});

test("point reads retain legacy personal keys until publication and preserve the shortcut before projection catches up", async () => {
  const old = {
    ...resource("agent-thread:old"),
    kind: "agent" as const,
    thread_id: "old",
  };
  await ingestCollaborationSnapshot(snapshot(1, [old]), authority);
  await deliver();
  await setCollaborationPersonalState(
    account_id,
    old,
    { alias: "kept-label", collected: true, following: true },
    old,
  );
  const agent_id = randomUUID();
  await getPool().query(
    "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by,conversation_history) VALUES($1,$2,$3,'new','Registered',$4,'[{\"thread_id\":\"old\"}]')",
    [agent_id, project_id, source.chat_path, account_id],
  );
  await getPool().query(
    "UPDATE collaboration_catalog SET metadata=metadata || jsonb_build_object('agent_id',$2::text,'thread_id','new'),revision=revision+1 WHERE entry_key=$1",
    [entryKey(old), agent_id],
  );
  await getPool().query(
    "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1",
    [project_id],
  );
  const canonical = { ...old, resource_id: agent_id };
  for (const target of [old, canonical]) {
    const owned = (await getOwnedCollaborationResource(
      target,
      account_id,
      authority,
    ))!;
    expect(owned.agent_catalog_resource_id).toBe(old.resource_id);
    await reconcileCollaborationAgentPersonalState(account_id, [owned]);
    expect(
      await getCollaborationPersonalState(
        account_id,
        collaborationAgentPersonalResource(owned),
      ),
    ).toMatchObject({ alias: "kept-label", collected: true, following: true });
  }
  const list = async () =>
    (await listCollaborationResources({ account_id, scope: "collected" }))
      .items;
  expect(await list()).toHaveLength(1);
  const pageBefore = await overlayCollaborationProjectPage(
    account_id,
    await readCollaborationProjectPage({ account_id, project_id }, authority),
  );
  expect(pageBefore.items[0].personal).toMatchObject({
    alias: "kept-label",
    collected: true,
  });
  // A reply fetched before canonical publication must not resurrect the old index row.
  const staleJob = await job();
  const stalePage = await readCollaborationProjection(staleJob, authority);
  expect(stalePage).toMatchObject({
    items: [{ resource: { resource_id: old.resource_id, agent_id } }],
  });
  await reconcileCollaborationAgents(project_id, authority);
  const published = (await getOwnedCollaborationResource(
    old,
    account_id,
    authority,
  ))!;
  expect(published.agent_catalog_resource_id).toBe(agent_id);
  await reconcileCollaborationAgentPersonalState(account_id, [published]);
  expect(await list()).toMatchObject([
    {
      resource_id: agent_id,
      thread_id: "new",
      personal: { alias: "kept-label", collected: true, following: true },
    },
  ]);
  expect(
    await applyCollaborationProjection(staleJob, stalePage, Date.now()),
  ).toBe(false);
  const pageAfter = await overlayCollaborationProjectPage(
    account_id,
    await readCollaborationProjectPage({ account_id, project_id }, authority),
  );
  expect(pageAfter.items[0]).toMatchObject({
    resource_id: agent_id,
    personal: { alias: "kept-label", collected: true },
  });
  await deliver();
  expect(await list()).toMatchObject([
    {
      resource_id: agent_id,
      personal: { alias: "kept-label", collected: true },
    },
  ]);
  await ingestCollaborationSnapshot(
    snapshot(2, [
      {
        ...old,
        resource_id: "agent-thread:new",
        thread_id: "new",
        activity: 1,
        archived: true,
      },
    ]),
    authority,
  );
  await ingestCollaborationSnapshot(snapshot(3, [old]), authority);
  expect(
    await getOwnedCollaborationResource(old, account_id, authority),
  ).toMatchObject({ thread_id: "new", activity: 4, archived: true });
});

test.each(["ready", "unpolled", "historical"])(
  "attention floors distinguish first live threads from initial history (%s)",
  async (mode) => {
    const established = mode !== "historical";
    const room = await ensureCollaborationRoom(
      project_id,
      account_id,
      randomUUID(),
      authority,
    );
    const canonical = { project_id, chat_path: room.chat_path };
    const roomEpoch = await registerCollaborationSource(
      canonical,
      authority,
      null,
      randomUUID(),
    );
    if (mode === "ready") await deliver();
    const resources = Array.from({ length: 61 }, (_, i) => ({
      ...resource(`live-${i}`),
      chat_path: room.chat_path,
      activity: 1,
    }));
    await ingestCollaborationSnapshot(
      {
        ...canonical,
        epoch: roomEpoch,
        sequence: 1,
        resources,
        notification_events: resources.map((r) => ({
          version: 1,
          project_id,
          room_id: room.room_id,
          thread_id: r.thread_id,
          message_id: `first-${r.thread_id}`,
          actor_account_id: other_id,
          activity: 1,
          mode: established ? "live" : "backfill",
          mentioned_account_ids: [account_id],
          mention_all: false,
        })),
      },
      authority,
    );
    await deliver();
    await deliver();
    const attention = (
      await getPool().query(
        "SELECT read_through,notify_after FROM collaboration_personal WHERE account_id=$1",
        [account_id],
      )
    ).rows;
    expect(attention).toHaveLength(61);
    expect(
      attention.every(
        (r) =>
          Number(r.read_through) === (established ? 0 : 1) &&
          Number(r.notify_after) === (established ? 0 : 1),
      ),
    ).toBe(true);
    expect(
      (await listCollaborationResources({ account_id })).items.every(
        (r) => r.activity === 1,
      ),
    ).toBe(true);
  },
);

test("unread survives unrelated membership changes but actual rejoin advances its history floor", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  const attention = async () =>
    (
      await getPool().query(
        "SELECT attention_generation,read_through,notify_after FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
        [account_id, entryKey(resource())],
      )
    ).rows[0];
  const before = await attention();
  await ingestCollaborationSnapshot(
    snapshot(2, [{ ...resource(), activity: 9 }]),
    authority,
  );
  await deliver();
  const third = randomUUID();
  await getPool().query(
    "UPDATE projects SET users=users || jsonb_build_object($2::text,jsonb_build_object('group','collaborator')) WHERE project_id=$1",
    [project_id, third],
  );
  expect(await deliver()).toMatchObject({ reset: true });
  expect(await attention()).toEqual(before);
  expect(
    (await listCollaborationResources({ account_id })).items[0],
  ).toMatchObject({ activity: 9, personal: { read_through: 3 } });
  await getPool().query(
    "UPDATE projects SET users=users-$2::text WHERE project_id=$1",
    [project_id, third],
  );
  expect(await deliver()).toMatchObject({ reset: true });
  expect(await attention()).toEqual(before);
  // Removal and rejoin can both happen between home polls; the owner cutover
  // must still change even when no denied page was observed by this account.
  await projectIndex("viewer");
  await projectIndex();
  await deliver();
  expect((await attention()).attention_generation).not.toBe(
    before.attention_generation,
  );
  expect(Number((await attention()).read_through)).toBe(9);
});

test.each(["resnapshot", "incremental"])(
  "prunes deleted baselines only after a complete %s without losing unread state",
  async (mode) => {
    const resources = Array.from({ length: 61 }, (_, i) =>
      resource(`paged-thread-${i}`),
    ).sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
    const deleted = resources[0];
    const survivor = resources[60];
    const attention = async (item: CollaborationResource) =>
      (
        await getPool().query(
          "SELECT attention_generation,read_through,notify_after FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
          [account_id, entryKey(item)],
        )
      ).rows[0];
    await ingestCollaborationSnapshot(snapshot(1, resources), authority);
    expect(await deliver()).toMatchObject({ complete: false });
    expect(await deliver()).toMatchObject({ complete: true });
    const before = await attention(survivor);
    expect(Number(before.read_through)).toBe(3);
    await ingestCollaborationSnapshot(
      snapshot(
        2,
        resources.slice(1).map((item) => ({ ...item, activity: 9 })),
      ),
      authority,
    );
    if (mode === "resnapshot")
      await getPool().query(
        "UPDATE projects SET users=users || jsonb_build_object($2::text,jsonb_build_object('group','collaborator')) WHERE project_id=$1",
        [project_id, randomUUID()],
      );
    const first = await deliver();
    expect(first).toMatchObject({
      allowed: true,
      reset: mode === "resnapshot",
      complete: false,
      items: expect.arrayContaining([
        { entry_key: entryKey(deleted), resource: null, revision: 2 },
      ]),
    });
    expect(await attention(survivor)).toEqual(before);
    expect(await attention(deleted)).toBeDefined();
    expect(await deliver()).toMatchObject({ reset: false, complete: true });
    expect(await attention(survivor)).toEqual(before);
    expect(
      (
        await getPool().query(
          "SELECT (metadata->>'activity')::integer AS activity FROM collaboration_index WHERE account_id=$1 AND entry_key=$2",
          [account_id, entryKey(survivor)],
        )
      ).rows[0],
    ).toEqual({ activity: 9 });
    expect(await attention(deleted)).toBeUndefined();
  },
);

test("attention baseline rows do not consume explicit personal-choice quota", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  await getPool().query(
    `INSERT INTO collaboration_personal(account_id,project_id,entry_key,attention_generation)
    SELECT $1,$2,md5('baseline-' || n) || md5('baseline-' || n),$3 FROM generate_series(1,10000) n`,
    [account_id, project_id, randomUUID()],
  );
  expect(
    await setCollaborationPersonalState(
      account_id,
      resource(),
      { alias: "kept" },
      resource(),
    ),
  ).toMatchObject({ alias: "kept" });
  await getPool().query(
    "UPDATE collaboration_personal SET collected=TRUE WHERE account_id=$1 AND entry_key<>$2",
    [account_id, entryKey(resource())],
  );
  await expect(
    setCollaborationPersonalState(
      account_id,
      resource("overflow"),
      { alias: "overflow" },
      resource("overflow"),
    ),
  ).rejects.toThrow("limit");
});

test("owner ingestion atomically preserves live event intent including unchanged metadata and replay", async () => {
  const room = await ensureCollaborationRoom(
    project_id,
    account_id,
    randomUUID(),
    authority,
  );
  const canonical = { project_id, chat_path: room.chat_path };
  const roomEpoch = await registerCollaborationSource(
    canonical,
    authority,
    null,
    randomUUID(),
  );
  const base = {
    ...canonical,
    epoch: roomEpoch,
    sequence: 1,
    resources: [{ ...resource(), chat_path: room.chat_path }],
  };
  const event = {
    version: 1 as const,
    project_id,
    room_id: room.room_id,
    thread_id: "thread",
    message_id: "message",
    actor_account_id: account_id,
    activity: 3,
    mode: "live" as const,
    mentioned_account_ids: [other_id],
    mention_all: false,
  };
  await ingestCollaborationSnapshot(base, authority);
  const live = { ...base, sequence: 2, notification_events: [event] };
  await ingestCollaborationSnapshot(live, authority);
  await ingestCollaborationSnapshot(live, authority);
  expect(
    (
      await getPool().query(
        "SELECT event_json FROM collaboration_notification_events",
      )
    ).rows,
  ).toEqual([{ event_json: event }]);
  await expect(
    ingestCollaborationSnapshot(
      {
        ...live,
        notification_events: [{ ...event, message_id: "conflicting" }],
      },
      authority,
    ),
  ).rejects.toThrow("sequence reused");
  await expect(
    ingestCollaborationSnapshot(
      {
        ...live,
        sequence: 3,
        notification_events: [
          { ...event, message_id: "new" },
          { ...event, room_id: randomUUID() },
        ],
      },
      authority,
    ),
  ).rejects.toThrow("canonical");
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count(*) AS n FROM collaboration_notification_events",
        )
      ).rows[0].n,
    ),
  ).toBe(1);
  expect(
    (await collaborationWriterState(canonical, authority))?.source_sequence,
  ).toBe(2);
});

test("legacy attention hints survive the metadata pipeline while explicit personal false remains authoritative", async () => {
  const item = {
    ...resource(),
    notification_followers: [account_id, account_id],
    notification_muted: [account_id],
  };
  await ingestCollaborationSnapshot(snapshot(1, [item]), authority);
  await deliver();
  const row = (
    await getPool().query(
      "SELECT metadata FROM collaboration_index WHERE account_id=$1",
      [account_id],
    )
  ).rows[0];
  expect(row.metadata.notification_followers).toEqual([account_id]);
  expect(row.metadata.notification_muted).toEqual([account_id]);
  await setCollaborationPersonalState(
    account_id,
    item,
    { following: false, muted: false },
    item,
  );
  expect(
    (
      await getPool().query(
        "SELECT following_explicit,muted_explicit,following,muted FROM collaboration_personal WHERE account_id=$1",
        [account_id],
      )
    ).rows[0],
  ).toMatchObject({
    following_explicit: true,
    muted_explicit: true,
    following: false,
    muted: false,
  });
  await expect(
    ingestCollaborationSnapshot(
      snapshot(2, [{ ...item, notification_muted: ["invalid"] }]),
      authority,
    ),
  ).rejects.toThrow("notification_muted");
});
afterAll(async () => {
  await testCleanup();
  if (previousBay === undefined) delete process.env.COCALC_BAY_ID;
  else process.env.COCALC_BAY_ID = previousBay;
});

test("complete source ingestion is atomic, idempotent, and conflicting/stale retries fail", async () => {
  expect(await ingestCollaborationSnapshot(snapshot(2), authority)).toEqual({
    revision: 1,
    replayed: false,
  });
  expect(await ingestCollaborationSnapshot(snapshot(2), authority)).toEqual({
    revision: 1,
    replayed: true,
  });
  expect(await ingestCollaborationSnapshot(snapshot(3), authority)).toEqual({
    revision: 1,
    replayed: true,
  });
  await expect(
    ingestCollaborationSnapshot(snapshot(2), authority),
  ).rejects.toThrow("stale");
  await expect(
    ingestCollaborationSnapshot(
      snapshot(3, [{ ...resource(), title: "changed" }]),
      authority,
    ),
  ).rejects.toThrow("sequence reused");
  expect(
    (await getPool().query("SELECT * FROM collaboration_catalog")).rows,
  ).toHaveLength(1);
});
test("source and host fences survive lost registration replies and A-B-A assignment", async () => {
  const registration = randomUUID();
  const next = await registerCollaborationSource(
    source,
    authority,
    epoch,
    registration,
  );
  expect(
    await registerCollaborationSource(source, authority, epoch, registration),
  ).toBe(next);
  await expect(
    registerCollaborationSource(source, authority, epoch, randomUUID()),
  ).rejects.toThrow("epoch changed");
  await expect(
    ingestCollaborationSnapshot(snapshot(), authority),
  ).rejects.toThrow("writer epoch");
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    project_id,
    randomUUID(),
  ]);
  await expect(collaborationWriterState(source, authority)).rejects.toThrow(
    "owner/host",
  );
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    project_id,
    host_id,
  ]);
  await expect(
    ingestCollaborationSnapshot({ ...snapshot(), epoch: next }, authority),
  ).rejects.toThrow("writer epoch");
  const recovered = await collaborationWriterState(source, authority);
  expect(recovered?.epoch).not.toBe(next);
  expect(recovered?.registration_id).toBeNull();
});
test("source validation rejects partial shapes, foreign identities, duplicate identities and oversized metadata", async () => {
  await expect(
    ingestCollaborationSnapshot(
      snapshot(1, [resource(), resource()]),
      authority,
    ),
  ).rejects.toThrow("duplicate");
  await expect(
    ingestCollaborationSnapshot(
      snapshot(1, [{ ...resource(), project_id: randomUUID() }]),
      authority,
    ),
  ).rejects.toThrow("source mismatch");
  await expect(
    ingestCollaborationSnapshot(
      { ...snapshot(), chat_path: "/home/user/../work.chat" },
      authority,
    ),
  ).rejects.toThrow("canonical");
  await expect(
    ingestCollaborationSnapshot(
      snapshot(1, [{ ...resource(), title: "x".repeat(513) }]),
      authority,
    ),
  ).rejects.toThrow("title");
  await expect(
    ingestCollaborationSnapshot(
      { ...snapshot(), resources: undefined! },
      authority,
    ),
  ).rejects.toThrow("snapshot");
  expect(
    (await getPool().query("SELECT * FROM collaboration_catalog")).rows,
  ).toHaveLength(0);
});
test("catalog write failure rolls back sequence and metadata", async () => {
  await getPool().query(
    "ALTER TABLE collaboration_sources ADD CONSTRAINT collab_fail CHECK(source_sequence<1)",
  );
  try {
    await expect(
      ingestCollaborationSnapshot(snapshot(), authority),
    ).rejects.toThrow();
    expect(
      (await getPool().query("SELECT * FROM collaboration_catalog")).rows,
    ).toHaveLength(0);
    expect(
      (await collaborationWriterState(source, authority))?.source_sequence,
    ).toBe(0);
  } finally {
    await getPool().query(
      "ALTER TABLE collaboration_sources DROP CONSTRAINT collab_fail",
    );
  }
});
test("room ensure converges, host lookup never creates, and viewers cannot discover rooms", async () => {
  await expect(
    collaborationRoomForHost(project_id, account_id, authority),
  ).rejects.toThrow("not registered");
  const [a, b] = await Promise.all([
    ensureCollaborationRoom(project_id, account_id, randomUUID(), authority),
    ensureCollaborationRoom(project_id, other_id, randomUUID(), authority),
  ]);
  expect(a).toEqual(b);
  expect(
    await collaborationRoomForHost(project_id, account_id, authority),
  ).toEqual(a);
  await expect(
    collaborationRoomForHost(project_id, account_id, {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow("owner/host");
  await projectIndex("viewer");
  await expect(
    ensureCollaborationRoom(project_id, account_id, randomUUID(), authority),
  ).rejects.toThrow("access denied");
  await expect(
    collaborationRoomForHost(project_id, account_id, authority),
  ).rejects.toThrow("access denied");
});
test("background source page discovers registered empty sources and rooms without starting compute", async () => {
  const room = await ensureCollaborationRoom(
    project_id,
    account_id,
    randomUUID(),
    authority,
  );
  expect((await collaborationSourcePage(project_id, authority)).paths).toEqual(
    [room.chat_path, source.chat_path].sort(),
  );
});
test("projection delivery resumes at stable revision/key checkpoints and exposes stopped-project metadata", async () => {
  const resources = Array.from({ length: 105 }, (_, i) =>
    resource(`thread-${i}`),
  );
  await ingestCollaborationSnapshot(snapshot(1, resources), authority);
  expect(await deliver()).toMatchObject({ complete: false });
  expect(await deliver()).toMatchObject({ complete: false });
  expect(await deliver()).toMatchObject({ complete: true });
  const first = await listCollaborationResources({ account_id });
  const second = await listCollaborationResources({
    account_id,
    after: first.next,
  });
  const third = await listCollaborationResources({
    account_id,
    after: second.next,
  });
  expect([first.items.length, second.items.length, third.items.length]).toEqual(
    [50, 50, 5],
  );
  expect(
    new Set(
      [...first.items, ...second.items, ...third.items].map(
        (r) => r.resource_id,
      ),
    ).size,
  ).toBe(105);
  // This legacy fixture contains previews but no complete relation manifest.
  expect(first.coverage).toBe("indexing");
  expect(JSON.stringify(first).length).toBeLessThan(256 * 1024);
  expect((await listCollaborationProjects({ account_id })).items).toHaveLength(
    1,
  );
});

test("latest-message author survives owner/home projection independently of creator and optional legacy omission", async () => {
  const authored = { ...resource(), latest_message_author_id: account_id };
  await ingestCollaborationSnapshot(snapshot(1, [authored]), authority);
  const first = await deliver();
  expect(first.items[0].resource).toMatchObject({
    created_by: other_id,
    latest_message_author_id: account_id,
  });
  expect(
    (await listCollaborationResources({ account_id })).items[0],
  ).toMatchObject({
    created_by: other_id,
    latest_message_author_id: account_id,
  });
  await ingestCollaborationSnapshot(
    snapshot(2, [{ ...authored, title: "Renamed" }]),
    authority,
  );
  await deliver();
  expect(
    (await listCollaborationResources({ account_id })).items[0],
  ).toMatchObject({
    title: "Renamed",
    latest_message_author_id: account_id,
    activity: authored.activity,
  });
  await ingestCollaborationSnapshot(snapshot(3), authority);
  await deliver();
  expect(
    (await listCollaborationResources({ account_id })).items[0],
  ).not.toHaveProperty("latest_message_author_id");
});
test("shared resource discovery excludes solo projects without changing general discovery", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  expect(
    (await listCollaborationResources({ account_id, shared_only: true })).items,
  ).toHaveLength(1);
  await getPool().query(
    "UPDATE account_project_index SET users_summary=$2 WHERE account_id=$1",
    [account_id, JSON.stringify({ [account_id]: { group: "owner" } })],
  );
  expect(
    (await listCollaborationResources({ account_id, shared_only: true })).items,
  ).toEqual([]);
  expect((await listCollaborationResources({ account_id })).items).toHaveLength(
    1,
  );
});

test("title/alias search and cursor filter binding are deterministic and bounded", async () => {
  await ingestCollaborationSnapshot(
    snapshot(1, [resource("one"), resource("two")]),
    authority,
  );
  await deliver();
  const first = await listCollaborationResources({
    account_id,
    limit: 1,
    search: "Calculus",
  });
  expect(first.next).toBeDefined();
  await expect(
    listCollaborationResources({
      account_id,
      after: first.next,
      search: "other",
    }),
  ).rejects.toThrow("cursor");
  await expect(
    listCollaborationResources({ account_id, limit: 51 }),
  ).rejects.toThrow("limit");
  await setCollaborationPersonalState(
    account_id,
    resource("one"),
    { alias: "Laplace" },
    resource("one"),
  );
  expect(
    (
      await listCollaborationResources({ account_id, search: "Laplace" })
    ).items.map((r) => r.resource_id),
  ).toEqual(["one"]);
  expect(
    (await listCollaborationResources({ account_id, search: "apla" })).items,
  ).toEqual([]);
});
test("source deletions propagate as content-free tombstones and stale claimed responses cannot resurrect", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  const stale = await job();
  const oldPage = await readCollaborationProjection(stale, authority);
  await failCollaborationProjection(stale, Error("lost reply"));
  await ingestCollaborationSnapshot(snapshot(2, []), authority);
  await deliver();
  expect(await applyCollaborationProjection(stale, oldPage, Date.now())).toBe(
    false,
  );
  expect((await listCollaborationResources({ account_id })).items).toEqual([]);
  expect(
    (await getPool().query("SELECT metadata FROM collaboration_catalog"))
      .rows[0].metadata,
  ).toBeNull();
});
test("membership revoke excludes metadata and people, rejoin gets a fresh generation", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  const generation = (
    await getPool().query("SELECT generation FROM collaboration_access")
  ).rows[0].generation;
  await getPool().query(
    "INSERT INTO account_collaborator_index(account_id,collaborator_account_id,display_name,common_project_count) VALUES($1,$2,'Ada',1)",
    [account_id, other_id],
  );
  expect((await listCollaborationPeople({ account_id })).items).toHaveLength(1);
  await projectIndex("viewer");
  expect((await listCollaborationResources({ account_id })).items).toEqual([]);
  expect((await listCollaborationPeople({ account_id })).items).toEqual([]);
  expect((await listCollaborationProjects({ account_id })).items).toEqual([]);
  await expect(
    getOwnedCollaborationResource(resource(), account_id, authority),
  ).rejects.toThrow("access denied");
  await projectIndex();
  await deliver();
  expect(
    (await getPool().query("SELECT generation FROM collaboration_access"))
      .rows[0].generation,
  ).not.toBe(generation);
});
test("revocation at the owner survives delayed index removal; leases fail closed on outage", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  await getPool().query("UPDATE projects SET users='{}' WHERE project_id=$1", [
    project_id,
  ]);
  const j = await job();
  const page = await readCollaborationProjection(j, authority);
  expect(page).toEqual({ allowed: false });
  await applyCollaborationProjection(j, page, Date.now());
  expect((await listCollaborationResources({ account_id })).items).toEqual([]);
  await projectIndex();
  await deliver();
  await getPool().query(
    "UPDATE collaboration_access SET lease_until=now()-interval '1 second'",
  );
  expect((await listCollaborationResources({ account_id })).items).toEqual([]);
  expect((await listCollaborationResources({ account_id })).coverage).toBe(
    "indexing",
  );
  await expect(
    applyCollaborationProjection(
      await job(),
      { allowed: false },
      Date.now() - 60001,
    ),
  ).rejects.toThrow("expired");
});
test("personal state is independent and read markers are monotone across devices", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  await setCollaborationPersonalState(
    account_id,
    resource(),
    {
      alias: "my name",
      collected: true,
      following: true,
      muted: true,
      read_through: 3,
    },
    resource(),
  );
  await setCollaborationPersonalState(
    account_id,
    resource(),
    { collected: false, read_through: 1 },
    resource(),
  );
  expect(await getCollaborationPersonalState(account_id, resource())).toEqual({
    alias: "my name",
    collected: false,
    following: true,
    muted: true,
    read_through: 3,
  });
  expect(
    (await listCollaborationResources({ account_id, scope: "following" }))
      .items,
  ).toHaveLength(1);
  expect(
    (await listCollaborationResources({ account_id, scope: "collected" }))
      .items,
  ).toHaveLength(0);
  await expect(
    setCollaborationPersonalState(
      account_id,
      resource(),
      { read_through: 999 },
      resource(),
    ),
  ).rejects.toThrow("exceeds");
  expect(
    await getCollaborationPersonalState(other_id, resource()),
  ).toMatchObject({ following: false, read_through: 0 });
});
test("compaction removes old tombstones only with a generation reset", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  await ingestCollaborationSnapshot(snapshot(2, []), authority);
  await getPool().query(
    "UPDATE collaboration_catalog SET deleted_at=now()-interval '8 days' WHERE entry_key=$1",
    [entryKey(resource())],
  );
  expect(await compactCollaborationProject(project_id, authority)).toBe(1);
  expect(await deliver()).toMatchObject({ reset: true, complete: true });
  expect((await listCollaborationResources({ account_id })).items).toEqual([]);
});

test("authoritative agent enrichment ignores forged IDs and follows registered endpoint moves", async () => {
  const agent_id = randomUUID();
  const agent = {
    ...resource("agent-thread:thread"),
    kind: "agent" as const,
    thread_id: "thread",
    agent_id: randomUUID(),
  };
  await ingestCollaborationSnapshot(snapshot(1, [agent]), authority);
  expect(
    (await getOwnedCollaborationResource(agent, account_id, authority))
      .agent_id,
  ).toBeUndefined();
  await getPool().query(
    `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
    VALUES($1,$2,$3,'thread','Known agent',$4)`,
    [agent_id, project_id, source.chat_path, other_id],
  );
  expect(await reconcileCollaborationAgents(project_id, authority)).toBe(1);
  expect(
    await getOwnedCollaborationResource(agent, account_id, authority),
  ).toMatchObject({ agent_id, resource_id: agent.resource_id });
  await getPool().query(
    "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'newton',$2,$3,'{}')",
    [account_id, project_id, agent_id],
  );
  await getPool().query(
    "UPDATE accounts SET other_settings=$2::jsonb WHERE account_id=$1",
    [
      account_id,
      JSON.stringify({
        experimental_my_agents_organization_v1: {
          pinned: JSON.stringify([agent_id]),
        },
      }),
    ],
  );
  await deliver();
  expect(
    (
      await listCollaborationResources({
        account_id,
        search: "newton",
        scope: "collected",
      })
    ).items[0],
  ).toMatchObject({ agent_id, personal: { alias: "newton", collected: true } });
  const moved = "/home/user/moved.chat";
  await getPool().query(
    "UPDATE agent_identities SET path=$2 WHERE agent_id=$1",
    [agent_id, moved],
  );
  expect(await reconcileCollaborationAgents(project_id, authority)).toBe(1);
  await expect(
    ingestCollaborationSnapshot(snapshot(2, [agent]), authority),
  ).rejects.toThrow("moved");
  const movedEpoch = await registerCollaborationSource(
    { project_id, chat_path: moved },
    authority,
    null,
    randomUUID(),
  );
  await ingestCollaborationSnapshot(
    {
      project_id,
      chat_path: moved,
      epoch: movedEpoch,
      sequence: 1,
      resources: [{ ...agent, chat_path: moved }],
    },
    authority,
  );
  await ingestCollaborationSnapshot(snapshot(2, []), authority);
  expect(
    await getOwnedCollaborationResource(agent, account_id, authority),
  ).toMatchObject({ agent_id, chat_path: moved });
});

test("existing artifact aliases and pins are read live, searchable, and never shadowed by generic state", async () => {
  const artifact = {
    ...resource(),
    kind: "artifact" as const,
    artifact_id: "artifact",
    entry_id: "a".repeat(64),
  };
  await ingestCollaborationSnapshot(snapshot(1, [artifact]), authority);
  await deliver();
  await getPool().query(
    "INSERT INTO personal_library_aliases(account_id,name,project_id,entry_id,active) VALUES($1,'leibniz',$2,$3,TRUE)",
    [account_id, project_id, artifact.entry_id],
  );
  await getPool().query(
    "INSERT INTO personal_library_pins(account_id,pin_key,rank) VALUES($1,$2,0)",
    [account_id, collaborationArtifactPin(artifact)],
  );
  expect(
    (
      await listCollaborationResources({
        account_id,
        search: "leibniz",
        scope: "collected",
      })
    ).items[0],
  ).toMatchObject({ personal: { alias: "leibniz", collected: true } });
  await expect(
    setCollaborationPersonalState(
      account_id,
      artifact,
      { alias: "competing" },
      artifact,
    ),
  ).rejects.toThrow("existing");
  await getPool().query(
    "UPDATE personal_library_aliases SET active=FALSE WHERE account_id=$1",
    [account_id],
  );
  expect(
    (await listCollaborationResources({ account_id, search: "leibniz" })).items,
  ).toEqual([]);
});

test("snapshot-before-query revision handoff catches concurrent changes, expiry, and foreign cursors", async () => {
  await ingestCollaborationSnapshot(snapshot(), authority);
  await deliver();
  const before = await checkCollaborationRevision(account_id);
  expect(
    (await checkCollaborationRevision(account_id, before.revision)).reset,
  ).toBe(false);
  await setCollaborationPersonalState(
    account_id,
    resource(),
    { following: true },
    resource(),
  );
  expect(
    (await checkCollaborationRevision(account_id, before.revision)).reset,
  ).toBe(true);
  const now = await checkCollaborationRevision(account_id);
  expect((await checkCollaborationRevision(other_id, now.revision)).reset).toBe(
    true,
  );
  const token = JSON.parse(Buffer.from(now.revision, "base64url").toString());
  token.expires = Date.now() - 1;
  expect(
    (
      await checkCollaborationRevision(
        account_id,
        Buffer.from(JSON.stringify(token)).toString("base64url"),
      )
    ).reset,
  ).toBe(true);
  expect((await checkCollaborationRevision(account_id, "garbage")).reset).toBe(
    true,
  );
});

test("bounded participant previews preserve large-room metadata and explicitly disclose partial person coverage", async () => {
  const participants = Array.from({ length: 64 }, () => randomUUID());
  const large = {
    ...resource(),
    participant_ids: participants,
    participant_count: 1000,
    participants_truncated: true,
  };
  await ingestCollaborationSnapshot(
    {
      ...snapshot(1, [large]),
      coverage: "partial",
      coverage_message: "Participant summary is bounded",
    },
    authority,
  );
  await deliver();
  const result = await listCollaborationResources({ account_id });
  expect(result.items[0]).toMatchObject({
    participant_count: 1000,
    participants_truncated: true,
  });
  expect(result.items[0].participant_ids).toHaveLength(64);
  expect(result.coverage).toBe("indexing");
  expect(result.coverage_message).toContain("participant relations");
  expect(
    (
      await getPool().query(
        "SELECT coverage,coverage_message FROM collaboration_sources WHERE chat_path=$1",
        [source.chat_path],
      )
    ).rows[0],
  ).toEqual({
    coverage: "partial",
    coverage_message: "Participant summary is bounded",
  });
});

test("relocation CAS preserves room/resource identities, fences old writes, and safely replays lost acknowledgments", async () => {
  const room = await ensureCollaborationRoom(
    project_id,
    account_id,
    randomUUID(),
    authority,
  );
  const canonical = { project_id, chat_path: room.chat_path };
  const sourceEpoch = await registerCollaborationSource(
    canonical,
    authority,
    null,
    randomUUID(),
  );
  const item = { ...resource(), chat_path: room.chat_path };
  await ingestCollaborationSnapshot(
    { ...canonical, epoch: sourceEpoch, sequence: 1, resources: [item] },
    authority,
  );
  expect(
    await markCollaborationRoomInitialized(
      { ...room, requesting_account_id: account_id },
      authority,
    ),
  ).toMatchObject({ initialized: true });
  const move = {
    project_id,
    from_chat_path: room.chat_path,
    to_chat_path: "/home/user/moved-room.chat",
    operation_id: randomUUID(),
    expected_epoch: sourceEpoch,
    expected_destination_epoch: null,
  };
  const [a, b] = await Promise.all([
    relocateCollaborationSource(move, authority),
    relocateCollaborationSource(move, authority),
  ]);
  expect(a).toEqual(b);
  expect(
    await getOwnedCollaborationResource(item, account_id, authority),
  ).toMatchObject({
    resource_id: item.resource_id,
    chat_path: move.to_chat_path,
  });
  expect(
    await ensureCollaborationRoom(
      project_id,
      account_id,
      randomUUID(),
      authority,
    ),
  ).toMatchObject({
    room_id: room.room_id,
    chat_path: move.to_chat_path,
    initialized: true,
  });
  await expect(
    ingestCollaborationSnapshot(
      { ...canonical, epoch: sourceEpoch, sequence: 2, resources: [] },
      authority,
    ),
  ).rejects.toThrow("writer epoch");
  await expect(
    registerCollaborationSource(
      canonical,
      authority,
      sourceEpoch,
      randomUUID(),
    ),
  ).rejects.toThrow("relocated");
  await expect(
    relocateCollaborationSource(
      { ...move, to_chat_path: "/home/user/other.chat" },
      authority,
    ),
  ).rejects.toThrow("operation reused");
  expect(
    (await collaborationSourcePage(project_id, authority)).paths,
  ).not.toContain(room.chat_path);
  const newHost = { ...authority, host_id: randomUUID() };
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    project_id,
    newHost.host_id,
  ]);
  expect(
    await collaborationRoomForHost(project_id, account_id, newHost),
  ).toMatchObject({ room_id: room.room_id, initialized: true });
  await expect(
    markCollaborationRoomInitialized(
      { ...room, requesting_account_id: account_id },
      authority,
    ),
  ).rejects.toThrow("owner/host");
});

test.each(["rejoin", "first-projection", "fallback"])(
  "artifact relocation preserves Library aliases/pins during %s",
  async (mode) => {
    const item = {
      ...resource(),
      kind: "artifact" as const,
      artifact_id: "native-artifact",
      entry_id: "",
    };
    item.entry_id = hash(artifactCatalogKey(source, item));
    const artifactEpoch = await registerArtifactCatalogSource(
      source,
      authority,
      null,
      randomUUID(),
    );
    await applyArtifactCatalogSnapshot(
      {
        ...source,
        schema_version: 1,
        epoch: artifactEpoch,
        sequence: 1,
        items: [
          {
            thread_id: item.thread_id,
            artifact_id: item.artifact_id,
            kind: "file",
            title: item.title,
            description: "",
            created_at: 1000,
            publication: { operation_id: "published", message_id: "message" },
            target: { path: "/home/user/notes.md" },
          },
        ],
      },
      authority,
    );
    await ingestCollaborationSnapshot(snapshot(1, [item]), authority);
    if (mode === "rejoin") await deliver();
    await getPool().query(
      "INSERT INTO personal_library_aliases(account_id,name,project_id,entry_id,active) VALUES($1,'notes',$2,$3,TRUE)",
      [account_id, project_id, item.entry_id],
    );
    await getPool().query(
      "INSERT INTO personal_library_pins(account_id,pin_key,rank) VALUES($1,$2,0)",
      [account_id, collaborationArtifactPin(item)],
    );
    if (mode === "rejoin") {
      await projectIndex("viewer");
      await deliver();
    } else {
      expect(
        (
          await getPool().query(
            "SELECT 1 FROM collaboration_index WHERE account_id=$1",
            [account_id],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await getPool().query(
            "SELECT 1 FROM collaboration_artifact_bindings WHERE account_id=$1",
            [account_id],
          )
        ).rows,
      ).toEqual([]);
    }
    const to_chat_path = "/home/user/moved.chat";
    await relocateCollaborationSource(
      {
        project_id,
        from_chat_path: source.chat_path,
        to_chat_path,
        operation_id: randomUUID(),
        expected_epoch: epoch,
        expected_destination_epoch: null,
      },
      authority,
    );
    await projectIndex();
    if (mode !== "fallback") await deliver();
    const renamed = {
      ...item,
      chat_path: to_chat_path,
      entry_id: hash(
        artifactCatalogKey({ project_id, chat_path: to_chat_path }, item),
      ),
    };
    expect(
      await getOwnedCollaborationResource(item, account_id, authority),
    ).toMatchObject(renamed);
    expect(
      await readArtifactCatalogEntry(project_id, renamed.entry_id),
    ).not.toBeNull();
    const page =
      mode === "fallback"
        ? await overlayCollaborationProjectPage(
            account_id,
            await readCollaborationProjectPage(
              { project_id, account_id },
              authority,
            ),
          )
        : await listCollaborationResources({
            account_id,
            search: "notes",
            scope: "collected",
          });
    expect(page.items[0]).toMatchObject({
      entry_id: renamed.entry_id,
      personal: { alias: "notes", collected: true },
    });
    expect(page.items[0]).not.toHaveProperty("artifact_entry_ids");
    expect(
      (
        await getPool().query(
          "SELECT pin_key FROM personal_library_pins WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].pin_key,
    ).toBe(collaborationArtifactPin(renamed));
  },
);
