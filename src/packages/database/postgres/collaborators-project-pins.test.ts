import { randomUUID } from "node:crypto";
import "@cocalc/util/db-schema/collaborators-workspace";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { syncCollaboratorsSchema } from "./collaborators-common";
import { listCollaborationProjects } from "./collaborators-discovery";
import { checkCollaborationRevision } from "./collaborators-changes";

const account_id = randomUUID();
const person_id = randomUUID();
const ids = Array.from({ length: 3000 }, () => randomUUID());
const pins = [ids[1], ids[1200], ids[2900]];
beforeAll(async () => {
  await initEphemeralDatabase({});
  await syncCollaboratorsSchema();
  await getPool().query(`INSERT INTO accounts(account_id) VALUES($1)`, [
    account_id,
  ]);
  await getPool().query(
    `INSERT INTO account_project_index(account_id,project_id,title,users_summary,sort_key)
    SELECT $1,id,'Geometry ' || n,$3::jsonb,'2026-01-01'::timestamp + n * interval '1 second'
    FROM unnest($2::uuid[]) WITH ORDINALITY AS p(id,n)`,
    [
      account_id,
      ids,
      JSON.stringify({
        [account_id]: { group: "owner" },
        [person_id]: { group: "collaborator" },
      }),
    ],
  );
  await getPool().query(
    `INSERT INTO collaboration_access(account_id,project_id,generation,lease_until,complete)
    SELECT account_id,project_id,$2,now()+interval '1 hour',true FROM account_project_index WHERE account_id=$1`,
    [account_id, randomUUID()],
  );
}, 60000);
afterAll(async () => {
  await testCleanup();
});
test("sparse pinned filter is applied before bounded keyset pages, preserving recent order", async () => {
  const calls = jest.spyOn(getPool(), "query");
  try {
    const first = await listCollaborationProjects(
      { account_id, view: "pinned", limit: 2 },
      pins,
    );
    expect(first.items.map((item) => [item.project_id, item.pinned])).toEqual([
      [pins[2], true],
      [pins[1], true],
    ]);
    expect(first.next).toBeDefined();
    const second = await listCollaborationProjects(
      { account_id, view: "pinned", limit: 2, after: first.next },
      pins,
    );
    expect(second.items.map((item) => item.project_id)).toEqual([pins[0]]);
    expect(second.next).toBeUndefined();
    const selects = calls.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("AS pinned"),
    );
    expect(selects).toHaveLength(2);
    for (const [sql, values] of selects) {
      expect(sql).toContain("p.project_id=ANY($8::uuid[])");
      expect(sql).toContain("LIMIT $7");
      expect(values?.[6]).toBe(3);
      expect(values?.[8]).toBe(true);
    }
    expect(
      (
        await listCollaborationProjects({ account_id, limit: 2 }, pins)
      ).items.map((item) => item.project_id),
    ).toEqual(ids.slice(-2).reverse());
  } finally {
    calls.mockRestore();
  }
});
test("project cursor binds view, account, filters and favorites but not array ordering", async () => {
  const { next: after } = await listCollaborationProjects(
    { account_id, view: "pinned", limit: 1 },
    pins,
  );
  for (const patch of [
    { view: "recent" },
    { account_id: randomUUID() },
    { search: "Geometry" },
    { person_id },
    { project_id: pins[0] },
    { shared_only: true },
  ])
    await expect(
      listCollaborationProjects(
        { account_id, view: "pinned", after, ...patch } as any,
        pins,
      ),
    ).rejects.toThrow("cursor");
  await expect(
    listCollaborationProjects(
      { account_id, view: "pinned", after },
      pins.slice(1),
    ),
  ).rejects.toThrow("cursor");
  expect(
    (
      await listCollaborationProjects(
        { account_id, view: "pinned", after },
        [...pins].reverse(),
      )
    ).items,
  ).toHaveLength(2);
});

test("project discovery carries the existing appearance theme", async () => {
  const theme = {
    color: "#123456",
    accent_color: "#abcdef",
    icon: "rocket",
    image_blob: "project-image",
  };
  await getPool().query(
    "UPDATE account_project_index SET theme=$2 WHERE project_id=$1",
    [ids[0], JSON.stringify(theme)],
  );
  const result = await listCollaborationProjects({
    account_id,
    project_id: ids[0],
  });
  expect(result.items[0].theme).toEqual(theme);
  expect(result.coverage).toBe("complete");
});
test("shared projects exclude solo and viewer-only projects before pagination; invitation queries retain them", async () => {
  const solo = ids[2999];
  const viewerOnly = ids[2998];
  const sharedUsers = {
    [account_id]: { group: "owner" },
    [person_id]: { group: "collaborator" },
  };
  try {
    for (const [id, users] of [
      [solo, { [account_id]: { group: "owner" } }],
      [
        viewerOnly,
        { [account_id]: { group: "owner" }, [person_id]: { group: "viewer" } },
      ],
    ]) {
      await getPool().query(
        "UPDATE account_project_index SET users_summary=$2 WHERE project_id=$1",
        [id, JSON.stringify(users)],
      );
    }
    expect(
      (await listCollaborationProjects({ account_id, limit: 2 })).items.map(
        (p) => p.project_id,
      ),
    ).toEqual([solo, viewerOnly]);
    const first = await listCollaborationProjects({
      account_id,
      shared_only: true,
      limit: 2,
    });
    expect(first.items.map((p) => p.project_id)).toEqual([
      ids[2997],
      ids[2996],
    ]);
    const second = await listCollaborationProjects({
      account_id,
      shared_only: true,
      limit: 2,
      after: first.next,
    });
    expect(second.items.map((p) => p.project_id)).toEqual([
      ids[2995],
      ids[2994],
    ]);
    await expect(
      listCollaborationProjects({ account_id, shared_only: "true" as any }),
    ).rejects.toThrow("shared_only");
  } finally {
    await getPool().query(
      "UPDATE account_project_index SET users_summary=$2 WHERE project_id=ANY($1::uuid[])",
      [[solo, viewerOnly], JSON.stringify(sharedUsers)],
    );
  }
});

test("pins cannot bypass access, lease, search or person filters", async () => {
  expect(
    (
      await listCollaborationProjects(
        { account_id, view: "pinned", search: "missing" },
        pins,
      )
    ).items,
  ).toEqual([]);
  expect(
    (
      await listCollaborationProjects(
        { account_id, view: "pinned", person_id: randomUUID() },
        pins,
      )
    ).items,
  ).toEqual([]);
  await getPool().query(
    "UPDATE collaboration_access SET lease_until=now()-interval '1 second' WHERE account_id=$1 AND project_id=$2",
    [account_id, pins[2]],
  );
  await getPool().query(
    "UPDATE account_project_index SET users_summary='{}' WHERE account_id=$1 AND project_id=$2",
    [account_id, pins[1]],
  );
  expect(
    (
      await listCollaborationProjects(
        { account_id, view: "pinned", person_id },
        pins,
      )
    ).items.map((item) => item.project_id),
  ).toEqual([pins[0]]);
  expect(
    (await listCollaborationProjects({ account_id, view: "pinned" }, [])).items,
  ).toEqual([]);
});

test("opaque revision tokens detect legacy favorites changes without catalog writes", async () => {
  const { revision } = await checkCollaborationRevision(
    account_id,
    undefined,
    "bookmarks-1",
  );
  expect(
    (await checkCollaborationRevision(account_id, revision, "bookmarks-1"))
      .reset,
  ).toBe(false);
  expect(
    (await checkCollaborationRevision(account_id, revision, "bookmarks-2"))
      .reset,
  ).toBe(true);
});
