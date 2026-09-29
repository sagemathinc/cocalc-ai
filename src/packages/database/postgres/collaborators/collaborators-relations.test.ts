/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID, webcrypto } from "node:crypto";
jest.mock("../../pool", () => jest.requireActual("@cocalc/database/pool"));
import "@cocalc/util/db-schema/collaborators-workspace";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";
import type {
  CollaborationRelation,
  CollaborationRelationPage,
} from "@cocalc/util/collaboration-relations";
import { collaborationRelationKey } from "@cocalc/util/collaboration-relations";
import { createCollaborationRelationSet } from "@cocalc/util/collaboration-relations-codec";
import { entryKey, syncCollaboratorsSchema } from "./collaborators-common";
import { ensureCollaborationNotificationSchema } from "./collaborators-notifications";
import {
  registerCollaborationSource,
  ingestCollaborationSnapshot,
  readCollaborationProjection,
  relocateCollaborationSource,
  reconcileCollaborationAgents,
} from "./collaborators-owner";
import {
  relationSetKey,
  stageCollaborationRelationPage,
} from "./collaborators-relations-owner";
import {
  listCollaborationParticipants,
  listCollaborationReferences,
} from "./collaborators-relations-query";
import {
  applyCollaborationProjection,
  claimCollaborationProjectionJobs,
  seedCollaborationProjectionJobs,
} from "./collaborators-projection";
import {
  listCollaborationResources,
  setCollaborationPersonalState,
  getCollaborationPersonalState,
} from "./collaborators-discovery";
import { readCollaborationProjectPage } from "./collaborators-project-page";

const project_id = randomUUID(),
  host_id = randomUUID();
const personPrefix = randomUUID().slice(0, 24);
const person = (n: number) => `${personPrefix}${String(n).padStart(12, "0")}`;
const account_id = person(999),
  source = { project_id, chat_path: "/home/user/relations.chat" };
const authority = { owning_bay_id: "bay-relations", host_id };
const native = {
  kind: "conversation" as const,
  resource_id: "discussion",
  thread_id: "native-discussion",
};
const target = {
  project_id,
  kind: native.kind,
  resource_id: native.resource_id,
};
const priorBay = process.env.COCALC_BAY_ID;
let epoch: string;
function resource(): CollaborationResource {
  return {
    ...source,
    ...native,
    title: "Complete participants",
    participant_ids: Array.from({ length: 64 }, (_, i) => person(i)),
    participant_count: 1000,
    participants_truncated: true,
    created_at: 100,
    updated_at: 200,
    activity: 3,
  };
}
function rows(
  ids = Array.from({ length: 1000 }, (_, i) => person(i)),
): CollaborationRelation[] {
  return [
    ...ids.map((id) => ({
      kind: "participant" as const,
      source: native,
      account_id: id,
    })),
    {
      kind: "reference",
      source: native,
      message_id: "message-1",
      reference: {
        version: 1,
        target: {
          project_id: randomUUID(),
          kind: "artifact",
          resource_id: "original-artifact",
        },
      },
    },
  ];
}
async function prepare(sequence = 1, edges = rows(), resources = [resource()]) {
  edges.sort((a, b) =>
    collaborationRelationKey(a) < collaborationRelationKey(b) ? -1 : 1,
  );
  const pages: CollaborationRelationPage[] = [];
  const relations = await createCollaborationRelationSet(
    { ...source, epoch, sequence },
    edges,
    (p) => {
      pages.push(p);
    },
  );
  const snapshot: CollaborationSourceSnapshot = {
    ...source,
    epoch,
    sequence,
    resources,
    relations,
  };
  return { snapshot, pages };
}
async function publish(prepared: Awaited<ReturnType<typeof prepare>>) {
  for (const page of prepared.pages)
    await stageCollaborationRelationPage(page, authority);
  return ingestCollaborationSnapshot(prepared.snapshot, authority);
}
async function tick() {
  await getPool().query(
    "UPDATE collaboration_access SET due_at=now() WHERE account_id=$1",
    [account_id],
  );
  const job = (
    await claimCollaborationProjectionJobs(authority.owning_bay_id)
  ).find((j) => j.account_id === account_id)!;
  expect(job).toBeDefined();
  const page = await readCollaborationProjection(job, authority);
  expect(await applyCollaborationProjection(job, page, Date.now())).toBe(true);
  return { job, page };
}
async function drain() {
  for (let i = 0; i < 20; i++) {
    const { page } = await tick();
    if (!page.allowed || page.complete) return;
  }
  throw Error("projection did not finish bounded fixture");
}
beforeAll(async () => {
  if (!globalThis.crypto?.subtle)
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
  process.env.COCALC_BAY_ID = authority.owning_bay_id;
  await initEphemeralDatabase({});
  await syncCollaboratorsSchema();
  await ensureCollaborationNotificationSchema();
}, 60000);
beforeEach(async () => {
  for (const table of [
    "collaboration_participant_index",
    "collaboration_participants",
    "collaboration_references",
    "agent_identities",
    "collaboration_relation_pages",
    "collaboration_relation_sets",
    "collaboration_memberships",
    "collaboration_notification_events",
    "collaboration_notification_floors",
    "collaboration_notification_cursors",
    "collaboration_artifact_bindings",
    "collaboration_relocations",
    "collaboration_projects",
    "collaboration_sources",
    "collaboration_catalog",
    "collaboration_rooms",
    "collaboration_access",
    "collaboration_index",
    "collaboration_personal",
    "account_project_index",
    "projects",
  ])
    await getPool().query(`DELETE FROM ${table} WHERE project_id=$1`, [
      project_id,
    ]);
  await getPool().query(
    "DELETE FROM collaboration_account_state WHERE account_id=$1",
    [account_id],
  );
  await getPool().query("DELETE FROM accounts WHERE account_id=$1", [
    account_id,
  ]);
  await getPool().query(
    "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2)",
    [account_id, authority.owning_bay_id],
  );
  const users = JSON.stringify({ [account_id]: { group: "owner" } });
  await getPool().query(
    "INSERT INTO projects(project_id,owning_bay_id,host_id,users,title) VALUES($1,$2,$3,$4::jsonb,'Relations project')",
    [project_id, authority.owning_bay_id, host_id, users],
  );
  await getPool().query(
    "INSERT INTO account_project_index(account_id,project_id,title,users_summary) VALUES($1,$2,'Relations project',$3::jsonb)",
    [account_id, project_id, users],
  );
  epoch = await registerCollaborationSource(
    source,
    authority,
    null,
    randomUUID(),
  );
  await seedCollaborationProjectionJobs(authority.owning_bay_id);
  await getPool().query(
    "INSERT INTO collaboration_access(account_id,project_id,due_at) VALUES($1,$2,now()) ON CONFLICT DO NOTHING",
    [account_id, project_id],
  );
});
afterAll(async () => {
  process.env.COCALC_BAY_ID = priorBay;
  await testCleanup();
});

test("adding another conversation preserves unchanged revision and immutable relations", async () => {
  const edges = rows();
  await publish(await prepare(1, edges));
  const read = async () =>
    (
      await getPool().query(
        "SELECT revision,relation_set,relation_digest FROM collaboration_catalog WHERE entry_key=$1",
        [entryKey(resource())],
      )
    ).rows[0];
  const before = await read();
  expect(before.relation_digest).toMatch(/^[a-f0-9]{64}$/);
  const second = { ...resource(), resource_id: "second", thread_id: "second" };
  await publish(await prepare(2, edges, [resource(), second]));
  expect(await read()).toEqual(before);
  // A missing manifest after a mixed-set update must retain the old thread's
  // complete participants, even though the source now points to a newer set.
  await ingestCollaborationSnapshot(
    {
      ...source,
      epoch,
      sequence: 3,
      resources: [{ ...resource(), title: "Renamed" }, second],
    },
    authority,
  );
  const [retained] = (
    await getPool().query(
      "SELECT relation_count,metadata->>'title' AS title FROM collaboration_catalog WHERE entry_key=$1",
      [entryKey(resource())],
    )
  ).rows;
  expect(Number(retained.relation_count)).toBe(1000);
  expect(retained.title).toBe("Renamed");
  const beforeStaleDigest = await read();
  await getPool().query(
    "UPDATE collaboration_catalog SET relation_digest_set='older-writer' WHERE entry_key=$1",
    [entryKey(resource())],
  );
  await publish(
    await prepare(4, edges, [
      { ...resource(), title: "Renamed" },
      { ...second, title: "Changed second" },
    ]),
  );
  expect((await read()).revision).not.toBe(beforeStaleDigest.revision);
});

test("small complete relation sets share a page within the 200-participant budget", async () => {
  const resources = Array.from({ length: 3 }, (_, i) => ({
    ...resource(),
    resource_id: `small-${i}`,
    thread_id: `small-${i}`,
  }));
  const edges: CollaborationRelation[] = resources.flatMap((r) =>
    Array.from({ length: 100 }, (_, i) => ({
      kind: "participant" as const,
      source: {
        kind: r.kind,
        resource_id: r.resource_id,
        thread_id: r.thread_id!,
      },
      account_id: person(i),
    })),
  );
  await publish(await prepare(1, edges, resources));
  const first = (await tick()).page;
  if (!first.allowed) throw Error("fixture access denied");
  expect(first.items).toHaveLength(2);
  expect(first.complete).toBe(false);
  expect(first.relation_after).toBeUndefined();
  expect(first.items.map((i) => i.participants?.ids.length)).toEqual([
    100, 100,
  ]);
  expect(first.items.every((i) => i.participants?.complete)).toBe(true);
  const second = (await tick()).page;
  if (!second.allowed) throw Error("fixture access denied");
  expect(second.items).toHaveLength(1);
  expect(second.complete).toBe(true);
  const {
    rows: [row],
  } = await getPool().query(
    "SELECT count(*)::integer AS n FROM collaboration_participant_index WHERE account_id=$1",
    [account_id],
  );
  expect(row.n).toBe(300);
});

test("1000 participants page through owner and home; preview never bounds For You/person membership", async () => {
  const prepared = await prepare();
  await publish(prepared);
  const collected: string[] = [];
  let after: string | undefined;
  do {
    const page = await listCollaborationParticipants(
      { ...target, account_id, after, limit: 50 },
      authority,
    );
    expect(page.coverage).toBe("complete");
    collected.push(...page.items.map((r) => r.account_id));
    after = page.next;
  } while (after);
  expect(collected).toEqual(Array.from({ length: 1000 }, (_, i) => person(i)));
  expect(
    (
      await readCollaborationProjectPage(
        { project_id, account_id, person_id: account_id },
        authority,
      )
    ).items,
  ).toHaveLength(1);
  const first = await tick();
  expect(first.page.allowed && first.page.relation_after).toBeDefined();
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
  expect((await listCollaborationResources({ account_id })).coverage).toBe(
    "indexing",
  );
  await drain();
  const result = await listCollaborationResources({
    account_id,
    scope: "for-you",
  });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    participant_count: 1000,
    participants_truncated: true,
    reason: "participation",
  });
  expect(result.items[0].participant_ids).toHaveLength(64);
  expect(result.items[0].participant_ids).not.toContain(account_id);
  expect(
    (await listCollaborationResources({ account_id, person_id: account_id }))
      .items,
  ).toHaveLength(1);
  expect(
    (
      await listCollaborationResources({
        account_id,
        person_id: account_id,
        scope: "for-you",
        search: "participants",
      })
    ).items,
  ).toHaveLength(1);
  expect(
    (await listCollaborationReferences({ ...target, account_id }, authority))
      .items,
  ).toEqual(
    prepared.pages.flatMap((p) => p.rows).filter((r) => r.kind === "reference"),
  );
});

test("incomplete uploads never replace active relations; changes outside unchanged preview advance projection", async () => {
  const first = await prepare();
  await publish(first);
  await drain();
  const ids = Array.from({ length: 1000 }, (_, i) =>
    person(i === 999 ? 1000 : i),
  );
  const second = await prepare(2, rows(ids));
  await stageCollaborationRelationPage(second.pages[0], authority);
  await expect(
    ingestCollaborationSnapshot(second.snapshot, authority),
  ).rejects.toThrow("incomplete");
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toHaveLength(1);
  const committed = await publish(second);
  expect(committed.replayed).toBe(false);
  expect(await ingestCollaborationSnapshot(second.snapshot, authority)).toEqual(
    { ...committed, replayed: true },
  );
  await tick();
  // Keep the last complete relation visible while the replacement is hidden.
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toHaveLength(1);
  await drain();
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
  expect(
    (await listCollaborationResources({ account_id, person_id: account_id }))
      .items,
  ).toEqual([]);
  expect(
    (await listCollaborationResources({ account_id, person_id: person(1000) }))
      .items,
  ).toHaveLength(1);
});

test.each([undefined, "partial"] as const)(
  "missing manifest retains same-native relations through owner/home with truthful coverage (%s)",
  async (coverage) => {
    const first = await prepare();
    await publish(first);
    await drain();
    const failure: CollaborationSourceSnapshot = {
      ...first.snapshot,
      sequence: 2,
      relations: undefined,
      coverage,
      coverage_message: "Relation archive extraction deferred",
      resources: [
        {
          ...resource(),
          title: "Metadata updated while relations are unavailable",
          participant_ids: [person(1001)],
          participant_count: 1,
          participants_truncated: false,
        },
      ],
    };
    const accepted = await ingestCollaborationSnapshot(failure, authority);
    expect(await ingestCollaborationSnapshot(failure, authority)).toEqual({
      ...accepted,
      replayed: true,
    });
    const participants = await listCollaborationParticipants(
      { ...target, account_id, limit: 50 },
      authority,
    );
    expect(participants).toMatchObject({
      coverage: "partial",
      coverage_message: failure.coverage_message,
    });
    expect(participants.items).toHaveLength(50);
    expect(participants.next).toBeDefined();
    expect(
      await listCollaborationReferences({ ...target, account_id }, authority),
    ).toMatchObject({
      coverage: "partial",
      items: first.pages
        .flatMap((p) => p.rows)
        .filter((r) => r.kind === "reference"),
    });
    expect(
      (
        await getPool().query(
          "SELECT relation_set FROM collaboration_sources WHERE project_id=$1",
          [project_id],
        )
      ).rows,
    ).toEqual([{ relation_set: relationSetKey(first.pages[0]) }]);
    expect(
      (
        await readCollaborationProjectPage(
          { project_id, account_id, person_id: account_id },
          authority,
        )
      ).items,
    ).toHaveLength(1);
    await drain();
    const forYou = await listCollaborationResources({
      account_id,
      scope: "for-you",
    });
    expect(forYou.coverage).not.toBe("complete");
    expect(forYou.items).toHaveLength(1);
    expect(forYou.items[0]).toMatchObject({
      title: failure.resources[0].title,
      participant_count: 1000,
      participants_truncated: true,
    });
    expect(
      (await listCollaborationResources({ account_id, person_id: account_id }))
        .items,
    ).toHaveLength(1);
    expect(
      (
        await listCollaborationResources({
          account_id,
          person_id: person(1001),
        })
      ).items,
    ).toEqual([]);

    // Only a verified empty set removes the prior complete facts.
    await publish(await prepare(3, []));
    await drain();
    expect(
      await listCollaborationParticipants({ ...target, account_id }, authority),
    ).toMatchObject({ items: [], coverage: "complete" });
    expect(
      await listCollaborationReferences({ ...target, account_id }, authority),
    ).toMatchObject({ items: [], coverage: "complete" });
    expect(
      (await listCollaborationResources({ account_id, scope: "for-you" }))
        .items,
    ).toEqual([]);
  },
);

test("missing manifest never transfers predecessor relations to a fresh registered agent thread", async () => {
  const agent_id = randomUUID();
  await getPool().query(
    "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,$3,'old','Registered',$4)",
    [agent_id, project_id, source.chat_path, account_id],
  );
  const old = {
    ...resource(),
    kind: "agent" as const,
    resource_id: "agent-thread:old",
    thread_id: "old",
  };
  const oldRows = rows([account_id]).map((r) => ({
    ...r,
    source: {
      kind: old.kind,
      resource_id: old.resource_id,
      thread_id: old.thread_id,
    },
  }));
  const first = await prepare(1, oldRows, [old]);
  await publish(first);
  await drain();
  const canonical = {
    project_id,
    kind: old.kind,
    resource_id: agent_id,
    account_id,
  };
  await ingestCollaborationSnapshot(
    {
      ...first.snapshot,
      sequence: 2,
      relations: undefined,
      coverage: "partial",
    },
    authority,
  );
  expect(
    await listCollaborationParticipants(canonical, authority),
  ).toMatchObject({ items: [{ account_id }], coverage: "partial" });
  await getPool().query(
    "UPDATE agent_identities SET thread_id='new',conversation_history='[{\"thread_id\":\"old\"}]'::jsonb WHERE agent_id=$1",
    [agent_id],
  );
  await ingestCollaborationSnapshot(
    {
      ...first.snapshot,
      sequence: 3,
      relations: undefined,
      coverage: "partial",
      resources: [
        old,
        { ...old, resource_id: "agent-thread:new", thread_id: "new" },
      ],
    },
    authority,
  );
  expect(
    await listCollaborationParticipants(canonical, authority),
  ).toMatchObject({ items: [], coverage: "indexing" });
  expect(await listCollaborationReferences(canonical, authority)).toMatchObject(
    {
      items: [],
      coverage: "indexing",
    },
  );
  await drain();
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
  expect(
    (await listCollaborationResources({ account_id, person_id: account_id }))
      .items,
  ).toEqual([]);
});

test("agent enrollment retains native relations; fresh successor does not inherit predecessor participants or references", async () => {
  const agent_id = randomUUID();
  const old = {
    ...resource(),
    kind: "agent" as const,
    resource_id: "agent-thread:old",
    thread_id: "old",
  };
  const nativeOld = {
    kind: old.kind,
    resource_id: old.resource_id,
    thread_id: old.thread_id,
  };
  const oldRows = rows([account_id]).map((r) => ({ ...r, source: nativeOld }));
  await publish(await prepare(1, oldRows, [old]));
  await getPool().query(
    "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,$3,'old','Registered',$4)",
    [agent_id, project_id, source.chat_path, account_id],
  );
  await reconcileCollaborationAgents(project_id, authority);
  const canonical = {
    project_id,
    kind: "agent" as const,
    resource_id: agent_id,
    account_id,
  };
  expect(
    (await listCollaborationParticipants(canonical, authority)).items,
  ).toEqual([{ account_id }]);
  expect(
    (await listCollaborationReferences(canonical, authority)).items[0].source,
  ).toEqual(nativeOld);
  await drain();
  expect(
    (
      await listCollaborationResources({ account_id, scope: "for-you" })
    ).items.map((r) => r.resource_id),
  ).toEqual([agent_id]);
  await getPool().query(
    "UPDATE agent_identities SET thread_id='new',conversation_history='[{\"thread_id\":\"old\"}]'::jsonb WHERE agent_id=$1",
    [agent_id],
  );
  await reconcileCollaborationAgents(project_id, authority);
  expect(
    await listCollaborationParticipants(canonical, authority),
  ).toMatchObject({ items: [], coverage: "indexing" });
  await drain();
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
  const fresh = { ...old, resource_id: "agent-thread:new", thread_id: "new" };
  const nativeFresh = {
    kind: fresh.kind,
    resource_id: fresh.resource_id,
    thread_id: fresh.thread_id,
  };
  await publish(
    await prepare(
      2,
      [
        ...oldRows,
        { kind: "participant", source: nativeFresh, account_id: person(1000) },
      ],
      [old, fresh],
    ),
  );
  expect(
    (await listCollaborationParticipants(canonical, authority)).items,
  ).toEqual([{ account_id: person(1000) }]);
  expect(
    (await listCollaborationReferences(canonical, authority)).items,
  ).toEqual([]);
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count(*) AS n FROM collaboration_references WHERE project_id=$1",
          [project_id],
        )
      ).rows[0].n,
    ),
  ).toBe(1);
  await drain();
  expect(
    (await listCollaborationResources({ account_id, person_id: person(1000) }))
      .items,
  ).toHaveLength(1);
});

test("new immutable revision during home paging restarts hidden staging and rejects tampered progress", async () => {
  await publish(await prepare());
  const { page } = await tick();
  expect(page.allowed && page.relation_after?.count).toBe(200);
  await getPool().query(
    "UPDATE collaboration_access SET due_at=now() WHERE account_id=$1",
    [account_id],
  );
  const job = (
    await claimCollaborationProjectionJobs(authority.owning_bay_id)
  ).find((j) => j.account_id === account_id)!;
  expect(job.relation_after).toBeDefined();
  const next = await readCollaborationProjection(job, authority);
  expect(
    await applyCollaborationProjection(
      { ...job, relation_after: { ...job.relation_after!, count: 0 } },
      next,
      Date.now(),
    ),
  ).toBe(false);
  expect(await applyCollaborationProjection(job, next, Date.now())).toBe(true);
  await publish(await prepare(2, rows([account_id])));
  await drain();
  const indexed = (
    await getPool().query(
      "SELECT relation_budget FROM collaboration_index WHERE account_id=$1",
      [account_id],
    )
  ).rows[0];
  expect(Number(indexed.relation_budget)).toBe(1);
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toHaveLength(1);
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count(*) AS n FROM collaboration_participant_index WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].n,
    ),
  ).toBe(1);
});

test("immutable upload retries reject conflicting content and stale/mixed writer fences", async () => {
  const first = await prepare(1, [...rows([account_id])]);
  expect(
    await stageCollaborationRelationPage(first.pages[0], authority),
  ).toEqual({ replayed: false });
  expect(
    await stageCollaborationRelationPage(first.pages[0], authority),
  ).toEqual({ replayed: true });
  const conflicting = await prepare(1, rows([person(998)]));
  await expect(
    stageCollaborationRelationPage(conflicting.pages[0], authority),
  ).rejects.toThrow("conflicting");
  await expect(
    stageCollaborationRelationPage(first.pages[0], {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow();
  epoch = await registerCollaborationSource(
    source,
    authority,
    epoch,
    randomUUID(),
  );
  await expect(
    stageCollaborationRelationPage(first.pages[0], authority),
  ).rejects.toThrow("epoch");
});

test("lost upload acknowledgements across writer restarts do not exhaust staging or discard the active set", async () => {
  const active = await prepare(1, rows([account_id]));
  await publish(active);
  const activeKey = relationSetKey(active.snapshot.relations!);
  const abandoned: CollaborationRelationPage[] = [];
  for (let restart = 0; restart < 4; restart++) {
    // The owner committed this page, but its ACK never reached the producer.
    const pending = await prepare(restart === 0 ? 2 : 1);
    await stageCollaborationRelationPage(pending.pages[0], authority);
    abandoned.push(pending.pages[0]);
    epoch = await registerCollaborationSource(
      source,
      authority,
      epoch,
      randomUUID(),
    );
  }
  const current = await prepare(1);
  await stageCollaborationRelationPage(current.pages[0], authority);
  for (const table of [
    "collaboration_relation_sets",
    "collaboration_relation_pages",
    "collaboration_participants",
    "collaboration_references",
  ]) {
    const remaining = (
      await getPool().query(
        `SELECT DISTINCT set_key FROM ${table} WHERE project_id=$1`,
        [project_id],
      )
    ).rows.map((r) => r.set_key);
    expect(remaining).toContain(activeKey);
    for (const page of abandoned)
      expect(remaining).not.toContain(relationSetKey(page));
  }
  expect(
    await listCollaborationParticipants({ ...target, account_id }, authority),
  ).toMatchObject({
    coverage: "complete",
    items: [{ account_id }],
  });
  for (const page of abandoned)
    await expect(
      stageCollaborationRelationPage(page, authority),
    ).rejects.toThrow("epoch");
  expect(
    await stageCollaborationRelationPage(current.pages[0], authority),
  ).toEqual({ replayed: true });
  await publish(current);
  expect(
    (
      await listCollaborationParticipants(
        { ...target, account_id, limit: 50 },
        authority,
      )
    ).items,
  ).toHaveLength(50);
  expect(
    (
      await getPool().query(
        "SELECT set_key FROM collaboration_relation_sets WHERE project_id=$1",
        [project_id],
      )
    ).rows,
  ).toEqual([{ set_key: relationSetKey(current.pages[0]) }]);
});

test("cleanup preserves old current-epoch uploads, their retries, and the pending set quota", async () => {
  const first = await prepare(1);
  const second = await prepare(2, rows([person(998)]));
  await stageCollaborationRelationPage(first.pages[0], authority);
  await getPool().query(
    "UPDATE collaboration_relation_sets SET created_at=now()-interval '2 days' WHERE project_id=$1",
    [project_id],
  );
  await stageCollaborationRelationPage(second.pages[0], authority);
  expect(
    await stageCollaborationRelationPage(first.pages[0], authority),
  ).toEqual({ replayed: true });
  const third = await prepare(3, rows([person(997)]));
  await expect(
    stageCollaborationRelationPage(third.pages[0], authority),
  ).rejects.toThrow("staged set quota");
  await publish(first);
  expect(
    await stageCollaborationRelationPage(second.pages[0], authority),
  ).toEqual({ replayed: true });
  expect(
    (
      await getPool().query(
        "SELECT set_key FROM collaboration_relation_sets WHERE project_id=$1 ORDER BY sequence",
        [project_id],
      )
    ).rows,
  ).toEqual([
    { set_key: relationSetKey(first.pages[0]) },
    { set_key: relationSetKey(second.pages[0]) },
  ]);
});

test("native provenance must belong to the admitted source snapshot", async () => {
  const edges = rows([account_id]);
  edges[0] = {
    ...edges[0],
    source: { ...native, thread_id: "another-native-thread" },
  };
  const bad = await prepare(1, edges);
  for (const page of bad.pages)
    await stageCollaborationRelationPage(page, authority);
  await expect(
    ingestCollaborationSnapshot(bad.snapshot, authority),
  ).rejects.toThrow("source thread");
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_catalog WHERE project_id=$1",
        [project_id],
      )
    ).rows[0].n,
  ).toBe("0");
});

test("references replace with current message metadata and cursor bindings reject stale/filter/account reuse", async () => {
  const edges = rows([account_id]);
  const ref = edges.find((r) => r.kind === "reference")!;
  if (ref.kind !== "reference") throw Error("fixture");
  edges.push({
    ...ref,
    message_id: "message-2",
    reference: {
      version: 1,
      target: { ...ref.reference.target, kind: "agent" },
    },
  });
  const first = await prepare(1, edges);
  await publish(first);
  const page = await listCollaborationReferences(
    { ...target, account_id, limit: 1 },
    authority,
  );
  expect(page.next).toBeDefined();
  await expect(
    listCollaborationReferences(
      { ...target, account_id, after: page.next, message_id: "message-1" },
      authority,
    ),
  ).rejects.toThrow("cursor");
  await expect(
    listCollaborationReferences(
      { ...target, account_id: person(888) },
      authority,
    ),
  ).rejects.toThrow("access");
  await publish(
    await prepare(
      2,
      edges.filter((r) => r.kind === "participant"),
    ),
  );
  expect(
    (await listCollaborationReferences({ ...target, account_id }, authority))
      .items,
  ).toEqual([]);
  await expect(
    listCollaborationReferences(
      { ...target, account_id, after: page.next },
      authority,
    ),
  ).rejects.toThrow("cursor");
});

test("metadata repair and notification-only reuse preserve read/follow/mute and activity", async () => {
  const first = await prepare();
  const result = await publish(first);
  await drain();
  await setCollaborationPersonalState(
    account_id,
    target,
    { following: true, muted: true, read_through: 3 },
    resource(),
  );
  const reused = { ...first.snapshot, sequence: 2 };
  expect(await ingestCollaborationSnapshot(reused, authority)).toEqual({
    ...result,
    replayed: true,
  });
  const repaired = await prepare(3, rows(), [
    { ...resource(), title: "Metadata repair" },
  ]);
  await publish(repaired);
  await drain();
  expect(await getCollaborationPersonalState(account_id, target)).toMatchObject(
    { following: true, muted: true, read_through: 3 },
  );
  expect(
    (await listCollaborationResources({ account_id })).items[0].activity,
  ).toBe(3);
});

test("revocation while a relation page is pending clears staging and rejects late claims", async () => {
  await publish(await prepare());
  const first = await tick();
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_participant_index WHERE project_id=$1",
        [project_id],
      )
    ).rows[0].n,
  ).toBe("200");
  await getPool().query("UPDATE projects SET users='{}' WHERE project_id=$1", [
    project_id,
  ]);
  const next = await tick();
  expect(next.page).toEqual({ allowed: false });
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_participant_index WHERE project_id=$1",
        [project_id],
      )
    ).rows[0].n,
  ).toBe("0");
  expect(
    await applyCollaborationProjection(first.job, first.page, Date.now()),
  ).toBe(false);
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
});

test("same-project relocation preserves complete relations and fences old upload writers", async () => {
  const first = await prepare();
  await publish(first);
  await relocateCollaborationSource(
    {
      project_id,
      from_chat_path: source.chat_path,
      to_chat_path: "/home/user/moved.chat",
      operation_id: randomUUID(),
      expected_epoch: epoch,
      expected_destination_epoch: null,
    },
    authority,
  );
  expect(
    (
      await listCollaborationParticipants(
        { ...target, account_id, limit: 50 },
        authority,
      )
    ).items,
  ).toHaveLength(50);
  expect(
    (await listCollaborationReferences({ ...target, account_id }, authority))
      .items,
  ).toHaveLength(1);
  await expect(
    stageCollaborationRelationPage(first.pages[0], authority),
  ).rejects.toThrow("epoch");
});

test("legacy missing relation manifests disclose indexing instead of treating 64 IDs as a complete relation", async () => {
  await ingestCollaborationSnapshot(
    { ...source, epoch, sequence: 1, resources: [resource()] },
    authority,
  );
  await drain();
  expect(
    (await listCollaborationParticipants({ ...target, account_id }, authority))
      .coverage,
  ).toBe("indexing");
  expect((await listCollaborationResources({ account_id })).coverage).toBe(
    "indexing",
  );
  expect(
    (await listCollaborationResources({ account_id, person_id: person(1) }))
      .items,
  ).toEqual([]);
});

test("empty complete sets remove membership; resource deletion removes its home relation rows", async () => {
  await publish(await prepare());
  await drain();
  await publish(await prepare(2, []));
  await drain();
  expect(
    (await listCollaborationResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
  await publish(await prepare(3, [], []));
  await drain();
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_participant_index WHERE account_id=$1 AND entry_key=$2",
        [account_id, entryKey(target)],
      )
    ).rows[0].n,
  ).toBe("0");
});
