import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import type { ArtifactCatalogSnapshot } from "@cocalc/util/artifact-catalog";
import {
  ARTIFACT_CATALOG_CHANGE_RETENTION_SEQS,
  appendArtifactCatalogReset,
  artifactCatalogStateBackfillRemaining,
  backfillArtifactCatalogProjectState,
  applyArtifactCatalogSnapshot,
  lockArtifactCatalogProject,
  pruneArtifactCatalogChanges,
  registerArtifactCatalogSource,
  getArtifactCatalogWriterState,
  readProjectArtifactCatalog,
  readArtifactCatalogEntry,
  artifactCatalogSourcePage,
} from "./artifact-catalog";

const project_id = "11111111-1111-4111-8111-111111111111";
const host_id = "22222222-2222-4222-8222-222222222222";
const authority = { owning_bay_id: "bay-test", host_id };
const source = { project_id, chat_path: "/home/user/work.chat" };
let epoch: string;
const snapshot = (sequence = 1): ArtifactCatalogSnapshot => ({
  ...source,
  schema_version: 1,
  epoch,
  sequence,
  items: [
    {
      thread_id: "thread",
      artifact_id: "artifact",
      kind: "file",
      title: "Notes",
      description: "",
      created_at: 1000,
      publication: { operation_id: "publish", message_id: "message" },
      target: { path: "/home/user/notes.md" },
    },
  ],
});

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);
beforeEach(async () => {
  await getPool().query(
    "TRUNCATE artifact_catalog,artifact_catalog_sources,artifact_catalog_project_budget,artifact_catalog_project_state,artifact_catalog_changes,projects CASCADE",
  );
  await getPool().query(
    `INSERT INTO projects(project_id,host_id,owning_bay_id,users)
    VALUES($1,$2,$3,'{}'::jsonb)`,
    [project_id, host_id, authority.owning_bay_id],
  );
  epoch = await registerArtifactCatalogSource(
    source,
    authority,
    null,
    randomUUID(),
  );
});
afterAll(async () => {
  await testCleanup();
});

test("writer recovery lookup is owner/host checked and reports committed sequence", async () => {
  expect(await getArtifactCatalogWriterState(source, authority)).toMatchObject({
    epoch,
    source_sequence: 0,
    writer_host_id: host_id,
  });
  await applyArtifactCatalogSnapshot(snapshot(3), authority);
  expect(await getArtifactCatalogWriterState(source, authority)).toMatchObject({
    epoch,
    source_sequence: 3,
  });
  expect(
    await getArtifactCatalogWriterState(
      { ...source, chat_path: "/missing.chat" },
      authority,
    ),
  ).toBeNull();
  await expect(
    getArtifactCatalogWriterState(source, {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow("owner/host");
  await expect(
    getArtifactCatalogWriterState(source, {
      ...authority,
      owning_bay_id: "wrong",
    }),
  ).rejects.toThrow("owner/host");
});

test("catalog writes are idempotent and retries do not advance revisions", async () => {
  expect(await applyArtifactCatalogSnapshot(snapshot(), authority)).toEqual({
    revision: 1,
    replayed: false,
  });
  expect(await applyArtifactCatalogSnapshot(snapshot(), authority)).toEqual({
    revision: 1,
    replayed: true,
  });
  const rows = (await getPool().query("SELECT * FROM artifact_catalog")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].metadata.title).toBe("Notes");
  expect(Number(rows[0].revision)).toBe(1);
});

test("metadata pages use stable keyset cursors and remove omitted entries", async () => {
  const base = snapshot();
  const items = Array.from({ length: 105 }, (_, i) => ({
    ...base.items[0],
    artifact_id: `artifact-${i}`,
  }));
  await applyArtifactCatalogSnapshot({ ...base, items }, authority);
  const first = await readProjectArtifactCatalog(project_id);
  expect(first.entries).toHaveLength(100);
  expect(first.indexed_sources).toBe(1);
  const second = await readProjectArtifactCatalog(project_id, first.next);
  expect(second.entries).toHaveLength(5);
  await expect(
    readArtifactCatalogEntry(project_id, second.entries[4].entry_id),
  ).resolves.toEqual(second.entries[4]);
  expect(second.next).toBeUndefined();
  expect(
    new Set([...first.entries, ...second.entries].map((e) => e.entry_id)).size,
  ).toBe(105);
  await applyArtifactCatalogSnapshot(
    { ...base, sequence: 2, items: [] },
    authority,
  );
  expect((await readProjectArtifactCatalog(project_id)).entries).toEqual([]);
  expect(
    (await getPool().query("SELECT * FROM artifact_catalog")).rows,
  ).toEqual([]);
  await expect(
    readProjectArtifactCatalog(project_id, "invalid"),
  ).rejects.toThrow("cursor");
});

test("background source discovery includes registered sources without metadata", async () => {
  expect(await artifactCatalogSourcePage(project_id, authority)).toEqual({
    paths: [source.chat_path],
  });
  expect(
    await artifactCatalogSourcePage(project_id, authority, source.chat_path),
  ).toEqual({ paths: [] });
  await expect(
    artifactCatalogSourcePage(project_id, {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow("owner/host");
});

test("point lookup uses existing identity, scopes by project, and excludes removed entries", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  const entry = (await readProjectArtifactCatalog(project_id)).entries[0];
  await expect(
    readArtifactCatalogEntry(project_id, entry.entry_id),
  ).resolves.toEqual(entry);
  await expect(
    readArtifactCatalogEntry(randomUUID(), entry.entry_id),
  ).resolves.toBeNull();
  await expect(
    readArtifactCatalogEntry(project_id, "0".repeat(64)),
  ).resolves.toBeNull();
  await applyArtifactCatalogSnapshot({ ...snapshot(2), items: [] }, authority);
  await expect(
    readArtifactCatalogEntry(project_id, entry.entry_id),
  ).resolves.toBeNull();
  await applyArtifactCatalogSnapshot(snapshot(3), authority);
  await expect(
    readArtifactCatalogEntry(project_id, entry.entry_id),
  ).resolves.toEqual(entry);
  for (const invalid of [undefined, "", "bad", "A".repeat(64), "a".repeat(65)])
    await expect(
      readArtifactCatalogEntry(project_id, invalid!),
    ).rejects.toThrow("entry_id");
});

test("rejects different content at the same sequence and older deliveries", async () => {
  await applyArtifactCatalogSnapshot(snapshot(2), authority);
  const changed = snapshot(2);
  changed.items[0].title = "Changed";
  await expect(
    applyArtifactCatalogSnapshot(changed, authority),
  ).rejects.toThrow("sequence reused");
  await expect(
    applyArtifactCatalogSnapshot(snapshot(1), authority),
  ).rejects.toThrow("stale");
});

test("edits keep creation time but removal and reappearance start a new entry", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  const edited = snapshot(2);
  edited.items[0].created_at = 5000;
  edited.items[0].title = "Edited";
  await applyArtifactCatalogSnapshot(edited, authority);
  expect(
    (
      await getPool().query("SELECT created_at FROM artifact_catalog")
    ).rows[0].created_at.getTime(),
  ).toBe(1000);
  await applyArtifactCatalogSnapshot({ ...snapshot(3), items: [] }, authority);
  expect(
    (await getPool().query("SELECT * FROM artifact_catalog")).rows,
  ).toEqual([]);
  const changed = snapshot(4);
  changed.items[0].created_at = 9999;
  changed.items[0].title = "Renamed";
  await applyArtifactCatalogSnapshot(changed, authority);
  const row = (await getPool().query("SELECT * FROM artifact_catalog")).rows[0];
  expect(row.deleted).toBe(false);
  expect(row.created_at.getTime()).toBe(9999);
  expect(row.metadata.title).toBe("Renamed");
  expect(row.metadata.created_at).toBe(9999);
  expect(Number(row.revision)).toBe(4);
});

test("replacing a full source repeatedly does not retain historical identities", async () => {
  const base = snapshot();
  for (let sequence = 1; sequence <= 3; sequence++) {
    await applyArtifactCatalogSnapshot(
      {
        ...base,
        sequence,
        items: Array.from({ length: 5000 }, (_, index) => ({
          ...base.items[0],
          artifact_id: `${sequence}-${index}`,
        })),
      },
      authority,
    );
    const count = await getPool().query(
      "SELECT count(*) AS n FROM artifact_catalog WHERE project_id=$1",
      [project_id],
    );
    expect(Number(count.rows[0].n)).toBe(5000);
  }
}, 60000);

test("wrong bay, reassigned host and deleted project cannot ingest", async () => {
  await expect(
    applyArtifactCatalogSnapshot(snapshot(), {
      ...authority,
      owning_bay_id: "other-bay",
    }),
  ).rejects.toThrow("owner/host");
  await expect(
    applyArtifactCatalogSnapshot(snapshot(), {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow("owner/host");
  await getPool().query(
    "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
    [project_id],
  );
  await expect(
    applyArtifactCatalogSnapshot(snapshot(), authority),
  ).rejects.toThrow("owner/host");
});

test("epoch registration supports lost-response retry but fences stale registrations and snapshots", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  const registration = randomUUID();
  const nextEpoch = await registerArtifactCatalogSource(
    source,
    authority,
    epoch,
    registration,
  );
  expect(
    await registerArtifactCatalogSource(source, authority, epoch, registration),
  ).toBe(nextEpoch);
  await expect(
    registerArtifactCatalogSource(source, authority, epoch, randomUUID()),
  ).rejects.toThrow("epoch changed");
  await expect(
    applyArtifactCatalogSnapshot(snapshot(2), authority),
  ).rejects.toThrow("writer epoch");
  expect(
    await applyArtifactCatalogSnapshot(
      { ...snapshot(), epoch: nextEpoch },
      authority,
    ),
  ).toEqual({ revision: 1, replayed: true });
});

test("A to B to A host reassignment permits recovery only by the current host", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  const secondHost = { ...authority, host_id: randomUUID() };
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    project_id,
    secondHost.host_id,
  ]);
  await expect(
    getArtifactCatalogWriterState(source, authority),
  ).rejects.toThrow("owner/host");
  await expect(
    registerArtifactCatalogSource(source, authority, epoch, randomUUID()),
  ).rejects.toThrow("owner/host");
  const secondEpoch = await registerArtifactCatalogSource(
    source,
    secondHost,
    epoch,
    randomUUID(),
  );
  await applyArtifactCatalogSnapshot(
    { ...snapshot(), epoch: secondEpoch, items: [] },
    secondHost,
  );
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    project_id,
    host_id,
  ]);
  expect(await getArtifactCatalogWriterState(source, authority)).toMatchObject({
    epoch: secondEpoch,
    writer_host_id: secondHost.host_id,
  });
  await expect(
    applyArtifactCatalogSnapshot(snapshot(2), authority),
  ).rejects.toThrow("stale");
  const recoveredEpoch = await registerArtifactCatalogSource(
    source,
    authority,
    secondEpoch,
    randomUUID(),
  );
  await expect(
    registerArtifactCatalogSource(
      source,
      secondHost,
      recoveredEpoch,
      randomUUID(),
    ),
  ).rejects.toThrow("owner/host");
  await applyArtifactCatalogSnapshot(
    { ...snapshot(), epoch: recoveredEpoch },
    authority,
  );
  expect((await readProjectArtifactCatalog(project_id)).entries).toHaveLength(
    1,
  );
});

test("source update failure rolls back metadata and sequence advancement", async () => {
  const pool = getPool();
  await pool.query(
    `ALTER TABLE artifact_catalog_sources ADD CONSTRAINT catalog_test_fail CHECK (source_sequence < 1)`,
  );
  try {
    await expect(
      applyArtifactCatalogSnapshot(snapshot(), authority),
    ).rejects.toThrow();
    expect((await pool.query("SELECT * FROM artifact_catalog")).rows).toEqual(
      [],
    );
    expect(
      Number(
        (
          await pool.query(
            "SELECT source_sequence FROM artifact_catalog_sources",
          )
        ).rows[0].source_sequence,
      ),
    ).toBe(0);
  } finally {
    await pool.query(
      "ALTER TABLE artifact_catalog_sources DROP CONSTRAINT catalog_test_fail",
    );
  }
  expect(await applyArtifactCatalogSnapshot(snapshot(), authority)).toEqual({
    revision: 1,
    replayed: false,
  });
});

test("concurrent duplicate delivery produces only one revision", async () => {
  const results = await Promise.all([
    applyArtifactCatalogSnapshot(snapshot(), authority),
    applyArtifactCatalogSnapshot(snapshot(), authority),
  ]);
  expect(results.filter((x) => !x.replayed)).toHaveLength(1);
  expect(
    (await getPool().query("SELECT * FROM artifact_catalog")).rows,
  ).toHaveLength(1);
});

test("ordinary chat writes do not advance the catalog revision", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  expect(await applyArtifactCatalogSnapshot(snapshot(2), authority)).toEqual({
    revision: 1,
    replayed: true,
  });
  const row = (await getPool().query("SELECT * FROM artifact_catalog_sources"))
    .rows[0];
  expect(Number(row.catalog_revision)).toBe(1);
  expect(Number(row.source_sequence)).toBe(2);
  const changed = snapshot(2);
  changed.items[0].title = "Conflicting retry";
  await expect(
    applyArtifactCatalogSnapshot(changed, authority),
  ).rejects.toThrow("sequence reused");
});

// Change log: one committed seq per visible change, in the ingest transaction.

const changeLog = async () =>
  (
    await getPool().query(
      `SELECT seq,entry_id,op FROM artifact_catalog_changes
       WHERE project_id=$1 ORDER BY seq,op,entry_id`,
      [project_id],
    )
  ).rows.map((row) => ({
    seq: Number(row.seq),
    entry_id: row.entry_id,
    op: row.op,
  }));
const projectState = async () => {
  const row = (
    await getPool().query(
      "SELECT * FROM artifact_catalog_project_state WHERE project_id=$1",
      [project_id],
    )
  ).rows[0];
  return row
    ? {
        epoch: row.epoch as string,
        seq: Number(row.seq),
        floor: Number(row.retention_floor_seq),
        latest: row.latest_created_at?.getTime() as number | undefined,
      }
    : undefined;
};
const items = (ids: string[], title = "Notes") =>
  ids.map((artifact_id) => ({
    ...snapshot().items[0],
    artifact_id,
    title,
  }));

test("change log records inserts, real updates and removals, one seq per snapshot", async () => {
  await applyArtifactCatalogSnapshot(
    { ...snapshot(1), items: items(["a", "b"]) },
    authority,
  );
  const first = await changeLog();
  expect(first.map((c) => [c.seq, c.op])).toEqual([
    [1, "upsert"],
    [1, "upsert"],
  ]);
  const ids = Object.fromEntries(
    (await readProjectArtifactCatalog(project_id)).entries.map((e) => [
      e.item.artifact_id,
      e.entry_id,
    ]),
  );
  const state = await projectState();
  expect(state).toMatchObject({ seq: 1, floor: 0, latest: 1000 });

  // b changes title, a is untouched, c is new.
  await applyArtifactCatalogSnapshot(
    {
      ...snapshot(2),
      items: [...items(["a"]), ...items(["b"], "Renamed"), ...items(["c"])],
    },
    authority,
  );
  const second = (await changeLog()).filter((c) => c.seq === 2);
  expect(second.map((c) => c.op)).toEqual(["upsert", "upsert"]);
  expect(second.map((c) => c.entry_id)).toContain(ids.b);
  expect(second.map((c) => c.entry_id)).not.toContain(ids.a);

  // a is dropped.
  await applyArtifactCatalogSnapshot(
    {
      ...snapshot(3),
      items: [...items(["b"], "Renamed"), ...items(["c"])],
    },
    authority,
  );
  expect((await changeLog()).filter((c) => c.seq === 3)).toEqual([
    { seq: 3, entry_id: ids.a, op: "remove" },
  ]);
  // The epoch is stable while the project stays on this bay.
  expect((await projectState())?.epoch).toBe(state?.epoch);
});

test("a snapshot whose only difference is the retained creation time logs nothing", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  const resent = snapshot(2);
  resent.items[0].created_at = 5000;
  // Different metadata hash, so the full write path runs, but no row changes.
  expect(await applyArtifactCatalogSnapshot(resent, authority)).toEqual({
    revision: 2,
    replayed: false,
  });
  expect((await changeLog()).map((c) => c.seq)).toEqual([1]);
  expect((await projectState())?.seq).toBe(1);
});

test("unchanged snapshots and replays advance no catalog seq", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  await applyArtifactCatalogSnapshot(snapshot(2), authority);
  expect((await projectState())?.seq).toBe(1);
  expect(await changeLog()).toHaveLength(1);
});

test("a failed ingest leaves no change records or version bump", async () => {
  const pool = getPool();
  await pool.query(
    `ALTER TABLE artifact_catalog_sources ADD CONSTRAINT catalog_test_fail2 CHECK (source_sequence < 1)`,
  );
  try {
    await expect(
      applyArtifactCatalogSnapshot(snapshot(), authority),
    ).rejects.toThrow();
  } finally {
    await pool.query(
      "ALTER TABLE artifact_catalog_sources DROP CONSTRAINT catalog_test_fail2",
    );
  }
  expect(await changeLog()).toEqual([]);
  // Only the baseline created at source registration remains.
  expect(await projectState()).toMatchObject({ seq: 0 });
});

test("more than one page of changes in one snapshot share a single seq", async () => {
  await applyArtifactCatalogSnapshot(
    {
      ...snapshot(1),
      items: items(Array.from({ length: 1200 }, (_, i) => `x-${i}`)),
    },
    authority,
  );
  const log = await changeLog();
  expect(log).toHaveLength(1200);
  expect(new Set(log.map((c) => c.seq))).toEqual(new Set([1]));
}, 60000);

test("visibility resets advance the same sequence under the catalog lock", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await lockArtifactCatalogProject(db, project_id, authority.owning_bay_id);
    expect(await appendArtifactCatalogReset(db, project_id)).toBe(2);
    await db.query("COMMIT");
  } finally {
    db.release();
  }
  expect((await changeLog()).at(-1)).toEqual({
    seq: 2,
    entry_id: "",
    op: "reset",
  });
  // A reset on a live project with no catalog rows creates its version.
  const other = randomUUID();
  await getPool().query(
    `INSERT INTO projects(project_id,host_id,owning_bay_id,users)
    VALUES($1,$2,$3,'{}'::jsonb)`,
    [other, host_id, authority.owning_bay_id],
  );
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockArtifactCatalogProject(client, other, authority.owning_bay_id);
    expect(await appendArtifactCatalogReset(client, other)).toBe(1);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

// Lifecycle: no version or change row may outlive (or be created for) a
// project that is deleted, missing or owned by another bay.

const rowsFor = async (id: string) => {
  const counts = {};
  for (const table of [
    "artifact_catalog",
    "artifact_catalog_sources",
    "artifact_catalog_project_state",
    "artifact_catalog_changes",
  ]) {
    counts[table] = Number(
      (
        await getPool().query(
          `SELECT count(*) AS n FROM ${table} WHERE project_id=$1`,
          [id],
        )
      ).rows[0].n,
    );
  }
  return counts;
};
const hardDelete = async (id: string) => {
  // What project hard delete does: lock the project row, delete its rows.
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE",
      [id],
    );
    for (const table of [
      "artifact_catalog",
      "artifact_catalog_changes",
      "artifact_catalog_project_state",
      "artifact_catalog_sources",
    ])
      await db.query(`DELETE FROM ${table} WHERE project_id=$1`, [id]);
    await db.query("DELETE FROM projects WHERE project_id=$1", [id]);
    await db.query("COMMIT");
  } finally {
    db.release();
  }
};
const none = {
  artifact_catalog: 0,
  artifact_catalog_sources: 0,
  artifact_catalog_project_state: 0,
  artifact_catalog_changes: 0,
};

test("a reset for a deleted, hard-deleted or foreign project is refused and writes nothing", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  const tryReset = async (bay = authority.owning_bay_id) => {
    const db = await getPool().connect();
    try {
      await db.query("BEGIN");
      await lockArtifactCatalogProject(db, project_id, bay);
      await appendArtifactCatalogReset(db, project_id);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  };
  await expect(tryReset("other-bay")).rejects.toThrow("not live on this bay");
  await getPool().query(
    "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
    [project_id],
  );
  await expect(tryReset()).rejects.toThrow("not live on this bay");
  expect((await projectState())?.seq).toBe(1);
  await getPool().query(
    "UPDATE projects SET deleted=FALSE WHERE project_id=$1",
    [project_id],
  );
  await hardDelete(project_id);
  await expect(tryReset()).rejects.toThrow("not live on this bay");
  expect(await rowsFor(project_id)).toEqual(none);
});

test("a project hard-deleted after backfill selected it gets no resurrected state", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  await forgetVersions();
  expect(
    await artifactCatalogStateBackfillRemaining(authority.owning_bay_id),
  ).toBe(1);
  const result = await backfillArtifactCatalogProjectState({
    owning_bay_id: authority.owning_bay_id,
    // Runs after the backfill selected the project, before its locks.
    beforeProject: async (id) => await hardDelete(id),
  });
  expect(result).toEqual({ created: 0, remaining: 0 });
  expect(await rowsFor(project_id)).toEqual(none);
});

test("backfill and its remaining count ignore projects owned by other bays", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  await forgetVersions();
  // The project moved away; its stale source rows here are not authoritative.
  await getPool().query(
    "UPDATE projects SET owning_bay_id='other-bay' WHERE project_id=$1",
    [project_id],
  );
  expect(
    await artifactCatalogStateBackfillRemaining(authority.owning_bay_id),
  ).toBe(0);
  expect(
    await backfillArtifactCatalogProjectState({
      owning_bay_id: authority.owning_bay_id,
    }),
  ).toEqual({ created: 0, remaining: 0 });
  expect(await projectState()).toBeUndefined();
});

test("a project with no owning bay is live here for the lock, backfill and count alike", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  await forgetVersions();
  await getPool().query(
    "UPDATE projects SET owning_bay_id=NULL WHERE project_id=$1",
    [project_id],
  );
  const bay = authority.owning_bay_id;
  expect(await artifactCatalogStateBackfillRemaining(bay)).toBe(1);
  expect(
    await backfillArtifactCatalogProjectState({ owning_bay_id: bay }),
  ).toEqual({ created: 1, remaining: 0 });
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await lockArtifactCatalogProject(db, project_id, bay);
    expect(await appendArtifactCatalogReset(db, project_id)).toBe(1);
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
});

test("registering a source creates the baseline before any ingest", async () => {
  // beforeEach registered a source: the project is versioned already.
  expect(await projectState()).toMatchObject({ seq: 0, floor: 0 });
  expect(await changeLog()).toEqual([]);
  expect(
    await artifactCatalogStateBackfillRemaining(authority.owning_bay_id),
  ).toBe(0);
});

test("latest_created_at follows removals", async () => {
  const both = [...items(["old"]), { ...items(["new"])[0], created_at: 9000 }];
  await applyArtifactCatalogSnapshot(
    { ...snapshot(1), items: both },
    authority,
  );
  expect((await projectState())?.latest).toBe(9000);
  await applyArtifactCatalogSnapshot(
    { ...snapshot(2), items: items(["old"]) },
    authority,
  );
  expect((await projectState())?.latest).toBe(1000);
});

test("pruning moves the retention floor before deleting, in bounded batches", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  const pool = getPool();
  const keep = ARTIFACT_CATALOG_CHANGE_RETENTION_SEQS;
  // Pretend this project has a long history: seq advanced far beyond the log.
  await pool.query(
    "UPDATE artifact_catalog_project_state SET seq=$2 WHERE project_id=$1",
    [project_id, keep + 50],
  );
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  // 40 old seqs eligible for pruning (seq <= seq - keep), each with 3 rows.
  for (let seq = 2; seq <= 41; seq++)
    for (const entry of ["e1", "e2", "e3"])
      await pool.query(
        `INSERT INTO artifact_catalog_changes(project_id,seq,entry_id,op,created_at)
         VALUES($1,$2,$3,'upsert',$4)`,
        [project_id, seq, entry, old],
      );
  // A recent change that is old by seq but not by age is kept.
  await pool.query(
    `INSERT INTO artifact_catalog_changes(project_id,seq,entry_id,op,created_at)
     VALUES($1,45,'recent','upsert',now())`,
    [project_id],
  );
  const result = await pruneArtifactCatalogChanges({
    batchRows: 7,
    maxRowsPerProject: 1000,
  });
  expect(result.projects).toBe(1);
  // The floor is the newest seq that is old by both age and seq (41); every
  // row at or below it goes, including seq 1 from the real ingest.
  expect(result.deleted).toBe(121);
  expect((await projectState())?.floor).toBe(41);
  expect((await changeLog()).map((c) => c.seq)).toEqual([45]);
  // Nothing left to prune.
  expect(await pruneArtifactCatalogChanges()).toEqual({
    projects: 0,
    deleted: 0,
  });
});

// Upgrade: catalogs written before versions existed have sources, rows and a
// metadata hash, but no state row.

const forgetVersions = async () => {
  await getPool().query("DELETE FROM artifact_catalog_project_state");
  await getPool().query("DELETE FROM artifact_catalog_changes");
};
const catalogRows = async () =>
  (
    await getPool().query(
      "SELECT entry_id,metadata,created_at FROM artifact_catalog ORDER BY entry_id",
    )
  ).rows;

test("an unchanged delivery to a pre-version catalog creates a seq-0 baseline and nothing else", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  await forgetVersions();
  const before = await catalogRows();
  // Same metadata: the unchanged-metadata fast path.
  expect(await applyArtifactCatalogSnapshot(snapshot(2), authority)).toEqual({
    revision: 1,
    replayed: true,
  });
  expect(await projectState()).toMatchObject({
    seq: 0,
    floor: 0,
    latest: 1000,
  });
  expect(await changeLog()).toEqual([]);
  expect(await catalogRows()).toEqual(before);
  // An exact replay also lands on the baseline.
  await forgetVersions();
  await applyArtifactCatalogSnapshot(snapshot(2), authority);
  expect((await projectState())?.seq).toBe(0);
  expect(await changeLog()).toEqual([]);
});

test("re-registration then an identical snapshot also gets the baseline", async () => {
  await applyArtifactCatalogSnapshot(snapshot(1), authority);
  await forgetVersions();
  const before = await catalogRows();
  const next = await registerArtifactCatalogSource(
    source,
    authority,
    epoch,
    randomUUID(),
  );
  await applyArtifactCatalogSnapshot(
    { ...snapshot(1), epoch: next },
    authority,
  );
  expect(await projectState()).toMatchObject({ seq: 0, latest: 1000 });
  expect(await changeLog()).toEqual([]);
  expect(await catalogRows()).toEqual(before);
  // A later real change starts the history at seq 1 in the same epoch.
  const baseline = (await projectState())?.epoch;
  await applyArtifactCatalogSnapshot(
    { ...snapshot(2), epoch: next, items: items(["artifact", "more"]) },
    authority,
  );
  expect(await projectState()).toMatchObject({ seq: 1, epoch: baseline });
  expect((await changeLog()).map((c) => [c.seq, c.op])).toEqual([
    [1, "upsert"],
  ]);
});

test("dormant pre-version catalogs are backfilled in bounded, idempotent batches", async () => {
  await applyArtifactCatalogSnapshot(
    { ...snapshot(1), items: [{ ...items(["a"])[0], created_at: 7000 }] },
    authority,
  );
  // A second dormant project that only ever registered a source.
  const other = randomUUID();
  await getPool().query(
    `INSERT INTO projects(project_id,host_id,owning_bay_id,users)
    VALUES($1,$2,$3,'{}'::jsonb)`,
    [other, host_id, authority.owning_bay_id],
  );
  await registerArtifactCatalogSource(
    { project_id: other, chat_path: "/home/user/other.chat" },
    authority,
    null,
    randomUUID(),
  );
  await forgetVersions();
  const before = await catalogRows();
  expect(
    await artifactCatalogStateBackfillRemaining(authority.owning_bay_id),
  ).toBe(2);
  expect(
    await backfillArtifactCatalogProjectState({
      owning_bay_id: authority.owning_bay_id,
      maxProjects: 1,
    }),
  ).toEqual({
    created: 1,
    remaining: 1,
  });
  expect(
    await backfillArtifactCatalogProjectState({
      owning_bay_id: authority.owning_bay_id,
      maxProjects: 1,
    }),
  ).toEqual({
    created: 1,
    remaining: 0,
  });
  const state = await projectState();
  expect(state).toMatchObject({ seq: 0, floor: 0, latest: 7000 });
  const otherState = (
    await getPool().query(
      "SELECT seq,latest_created_at FROM artifact_catalog_project_state WHERE project_id=$1",
      [other],
    )
  ).rows[0];
  expect(Number(otherState.seq)).toBe(0);
  expect(otherState.latest_created_at).toBeNull();
  // Rerunning changes nothing: same epoch, no history, same catalog.
  expect(
    await backfillArtifactCatalogProjectState({
      owning_bay_id: authority.owning_bay_id,
    }),
  ).toEqual({
    created: 0,
    remaining: 0,
  });
  expect((await projectState())?.epoch).toBe(state?.epoch);
  expect(await changeLog()).toEqual([]);
  expect(await catalogRows()).toEqual(before);
});
