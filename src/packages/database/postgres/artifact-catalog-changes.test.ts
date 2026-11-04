import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  validateArtifactCatalogSnapshot,
  type ArtifactCatalogItem,
} from "@cocalc/util/artifact-catalog";
import {
  appendArtifactCatalogReset,
  applyArtifactCatalogSnapshot,
  artifactCatalogChangeRowGauges,
  backfillArtifactCatalogChangeRows,
  lockArtifactCatalogProject,
  pruneArtifactCatalogChanges,
  registerArtifactCatalogSource,
} from "./artifact-catalog";
import {
  ARTIFACT_CATALOG_CHANGES_MAX_BYTES,
  ARTIFACT_CATALOG_CHANGE_RANGE_INVALID,
  artifactCatalogHintRecipients,
  artifactCatalogHintsDue,
  claimArtifactCatalogHint,
  completeArtifactCatalogHint,
  failArtifactCatalogHint,
  readArtifactCatalogChangesForAccount,
  renewArtifactCatalogHint,
  validateArtifactCatalogChangesRequest,
} from "./artifact-catalog-changes";
import { ARTIFACT_CATALOG_NOT_PERMITTED } from "./artifact-catalog-read";
import {
  ARTIFACT_CATALOG_CHANGE_CHECK,
  artifactCatalogChangeCheckValidated,
  ensureArtifactCatalogChangeCheck,
} from "./schema/artifact-catalog-change-check";

const bay = "bay-test";
const host_id = randomUUID();

async function project(users: Record<string, string>): Promise<string> {
  const project_id = randomUUID();
  await getPool().query(
    `INSERT INTO projects(project_id,host_id,owning_bay_id,users)
     VALUES($1,$2,$3,$4::jsonb)`,
    [
      project_id,
      host_id,
      bay,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(users).map(([id, group]) => [id, { group }]),
        ),
      ),
    ],
  );
  return project_id;
}

type Item = Partial<ArtifactCatalogItem> & { artifact_id: string };
const sources = new Map<string, { epoch: string; sequence: number }>();

/** Replaces a chat's whole snapshot with these items. */
async function snapshot(
  project_id: string,
  items: Item[],
  chat_path = "/home/user/work.chat",
) {
  const source = { project_id, chat_path };
  const authority = { owning_bay_id: bay, host_id };
  const key = `${project_id}:${chat_path}`;
  let state = sources.get(key);
  if (!state) {
    state = {
      epoch: await registerArtifactCatalogSource(
        source,
        authority,
        null,
        randomUUID(),
      ),
      sequence: 0,
    };
    sources.set(key, state);
  }
  state.sequence++;
  await applyArtifactCatalogSnapshot(
    {
      ...source,
      schema_version: 1,
      epoch: state.epoch,
      sequence: state.sequence,
      items: items.map((item, i) => ({
        thread_id: "thread",
        kind: "file",
        title: item.artifact_id,
        description: "",
        created_at: 1000 + i,
        publication: { operation_id: "op", message_id: "msg" },
        ...item,
      })),
    },
    authority,
  );
}

const items = (n: number, prefix = "a") =>
  Array.from({ length: n }, (_, i) => ({ artifact_id: `${prefix}${i}` }));

async function state(project_id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM artifact_catalog_project_state WHERE project_id=$1",
    [project_id],
  );
  return rows[0];
}

const changes = (account_id: string, request: object) =>
  readArtifactCatalogChangesForAccount({
    account_id,
    owning_bay_id: bay,
    request,
  });

/** Every page of one pull, as rev3 §A: collect, then apply. */
async function pull(account_id: string, project_id: string, from: any) {
  const upserts: string[] = [];
  const removes: string[] = [];
  let page: any = await changes(account_id, { project_id, from });
  if (page.reset) return page;
  const through = page.through_seq;
  const sizes: number[] = [];
  for (;;) {
    upserts.push(...page.upserts.map((e) => e.entry_id));
    removes.push(...page.removes);
    sizes.push(Buffer.byteLength(JSON.stringify(page.upserts)));
    if (!page.next_entry) break;
    page = await changes(account_id, {
      project_id,
      from,
      through_seq: through,
      after_entry: page.next_entry,
    });
  }
  return { upserts, removes, current: page.current, through, sizes };
}

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);
afterAll(async () => {
  await testCleanup();
});

describe("request validation (P1), before anything project-dependent", () => {
  const ok = {
    project_id: randomUUID(),
    from: { epoch: randomUUID(), seq: 0 },
  };
  test("formats, ranges and cursor coherence", () => {
    expect(validateArtifactCatalogChangesRequest(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, project_id: "x" },
      { ...ok, from: { epoch: "e", seq: 0 } },
      { ...ok, from: { epoch: ok.from.epoch, seq: -1 } },
      { ...ok, from: { epoch: ok.from.epoch, seq: 1.5 } },
      { ...ok, from: { epoch: ok.from.epoch, seq: 2 ** 60 } },
      { ...ok, through_seq: -1 },
      { ...ok, from: { epoch: ok.from.epoch, seq: 5 }, through_seq: 4 },
      { ...ok, after_entry: "a".repeat(64) },
      { ...ok, through_seq: 3, after_entry: "A".repeat(64) },
      { ...ok, through_seq: 3, after_entry: "a".repeat(63) },
    ])
      expect(() => validateArtifactCatalogChangesRequest(bad)).toThrow(
        "invalid catalog change request",
      );
  });
});

describe("listChanges", () => {
  test("authorization comes first: no seq or epoch oracle (B1)", async () => {
    const owner = randomUUID();
    const viewer = randomUUID();
    const p = await project({ [owner]: "owner", [viewer]: "viewer" });
    await snapshot(p, items(2));
    const { epoch } = await state(p);
    const nonexistent = randomUUID();
    for (const account_id of [viewer, randomUUID()])
      for (const project_id of [p, nonexistent])
        for (const from of [
          { epoch: randomUUID(), seq: 0 },
          { epoch, seq: 999 },
          { epoch, seq: 0 },
        ])
          for (const extra of [{}, { through_seq: 999 }])
            await expect(
              changes(account_id, { project_id, from, ...extra }),
            ).rejects.toThrow(ARTIFACT_CATALOG_NOT_PERMITTED);
  });

  test("the current state of every changed entry, compacted", async () => {
    const owner = randomUUID();
    const p = await project({ [owner]: "owner" });
    await snapshot(p, items(3));
    const v1 = await state(p);
    await snapshot(p, [
      { artifact_id: "a0", title: "changed" },
      { artifact_id: "a2" },
    ]);
    await snapshot(p, [
      { artifact_id: "a0", title: "changed again" },
      { artifact_id: "a2" },
      { artifact_id: "new" },
    ]);
    const result = await pull(owner, p, {
      epoch: v1.epoch,
      seq: Number(v1.seq),
    });
    expect(result.upserts).toHaveLength(2);
    expect(result.removes).toHaveLength(1);
    const page: any = await changes(owner, {
      project_id: p,
      from: { epoch: v1.epoch, seq: Number(v1.seq) },
    });
    const a0 = page.upserts.find((e) => e.item.artifact_id === "a0");
    expect(a0.item.title).toBe("changed again");
    expect(page.current.seq).toBe(Number(v1.seq) + 2);
  });

  test("exactly 500 ids: one page; 501: the 501st on page 2 (P9)", async () => {
    const owner = randomUUID();
    for (const n of [500, 501]) {
      const p = await project({ [owner]: "owner" });
      await snapshot(p, []);
      const v = await state(p);
      await snapshot(p, items(n));
      const first: any = await changes(owner, {
        project_id: p,
        from: { epoch: v.epoch, seq: Number(v.seq) },
      });
      expect(first.upserts).toHaveLength(500);
      if (n === 500) expect(first.next_entry).toBeUndefined();
      else {
        expect(first.next_entry).toBe(first.upserts[499].entry_id);
        const result = await pull(owner, p, {
          epoch: v.epoch,
          seq: Number(v.seq),
        });
        expect(new Set(result.upserts).size).toBe(501);
      }
    }
  });

  test("resets: another epoch, below the retention floor, beyond the current seq, a reset record", async () => {
    const owner = randomUUID();
    const p = await project({ [owner]: "owner" });
    await snapshot(p, items(1));
    await snapshot(p, items(2));
    const s = await state(p);
    const seq = Number(s.seq);
    for (const from of [
      { epoch: randomUUID(), seq },
      { epoch: s.epoch, seq: seq + 1 },
    ])
      expect(await changes(owner, { project_id: p, from })).toEqual({
        reset: true,
        current: { epoch: s.epoch, seq },
      });
    await getPool().query(
      "UPDATE artifact_catalog_project_state SET retention_floor_seq=$2 WHERE project_id=$1",
      [p, seq - 1],
    );
    expect(
      (
        (await changes(owner, {
          project_id: p,
          from: { epoch: s.epoch, seq: seq - 2 },
        })) as any
      ).reset,
    ).toBe(true);
    await getPool().query(
      "UPDATE artifact_catalog_project_state SET retention_floor_seq=0 WHERE project_id=$1",
      [p],
    );
    // An authorized caller's out-of-range through_seq is a range error.
    await expect(
      changes(owner, {
        project_id: p,
        from: { epoch: s.epoch, seq: 0 },
        through_seq: seq + 5,
      }),
    ).rejects.toThrow(ARTIFACT_CATALOG_CHANGE_RANGE_INVALID);
    const db = await getPool().connect();
    try {
      await db.query("BEGIN");
      await lockArtifactCatalogProject(db, p, bay);
      await appendArtifactCatalogReset(db, p);
      await db.query("COMMIT");
    } finally {
      db.release();
    }
    expect(
      (
        (await changes(owner, {
          project_id: p,
          from: { epoch: s.epoch, seq },
        })) as any
      ).reset,
    ).toBe(true);
  });

  test("pages stop at 1 MiB, always hold at least one entry, and lose nothing (C1, B2)", async () => {
    const owner = randomUUID();
    const p = await project({ [owner]: "owner" });
    await snapshot(p, []);
    const v = await state(p);
    // Escape-heavy text at every field limit (control characters serialize
    // as six-byte \u escapes).
    const heavy = (n: number) => "\u0001".repeat(n);
    const maxItem = (id: string) => ({
      thread_id: `t${id}`.padEnd(200, "\u0001"),
      artifact_id: `a${id}`.padEnd(200, "\u0001"),
      kind: heavy(64),
      title: heavy(512),
      description: heavy(2048),
      created_at: 1,
      publication: { operation_id: heavy(200), message_id: heavy(200) },
      appearance: {
        color: heavy(256),
        accent_color: heavy(256),
        icon: heavy(256),
        image_blob: heavy(256),
      },
      target: { path: heavy(4096), repository: heavy(256), sha: heavy(256) },
      // Unknown keys and unbounded arrays are dropped by the validator.
      extra: "x".repeat(500_000),
      list: Array(100_000).fill(1),
    });
    const chat = (i: number) =>
      `/home/user/${String(i).padStart(4, "0")}${"d".repeat(4000)}.chat`;
    const validated = validateArtifactCatalogSnapshot({
      schema_version: 1,
      project_id: p,
      chat_path: chat(0),
      epoch: "e",
      sequence: 1,
      items: [maxItem("0") as any],
    });
    expect(validated.items[0]).not.toHaveProperty("extra");
    expect(validated.items[0]).not.toHaveProperty("list");
    const one = JSON.stringify({
      entry_id: "f".repeat(64),
      project_id: p,
      chat_path: chat(0),
      item: validated.items[0],
    });
    expect(Buffer.byteLength(one)).toBeLessThan(96 * 1024);
    // 30 maximum-size entries, 3 per chat (a snapshot is at most 2 MiB).
    for (let c = 0; c < 10; c++)
      await snapshot(
        p,
        [0, 1, 2].map((i) => maxItem(`${c}-${i}`) as any),
        chat(c),
      );
    const result = await pull(owner, p, { epoch: v.epoch, seq: Number(v.seq) });
    expect(new Set(result.upserts).size).toBe(30);
    expect(result.sizes.length).toBeGreaterThan(1);
    for (const size of result.sizes)
      expect(size).toBeLessThanOrEqual(ARTIFACT_CATALOG_CHANGES_MAX_BYTES);
  }, 60_000);
});

describe("change rows are counted exactly (C2)", () => {
  test("ingest, reset and prune keep the count; NULL is measured by the backfill", async () => {
    const owner = randomUUID();
    const p = await project({ [owner]: "owner" });
    await snapshot(p, items(3));
    await snapshot(p, items(1));
    const count = async () =>
      Number(
        (
          await getPool().query(
            "SELECT count(*) AS n FROM artifact_catalog_changes WHERE project_id=$1",
            [p],
          )
        ).rows[0].n,
      );
    expect(Number((await state(p)).change_rows)).toBe(await count());
    const db = await getPool().connect();
    try {
      await db.query("BEGIN");
      await lockArtifactCatalogProject(db, p, bay);
      await appendArtifactCatalogReset(db, p);
      await db.query("COMMIT");
    } finally {
      db.release();
    }
    expect(Number((await state(p)).change_rows)).toBe(await count());
    await getPool().query(
      `UPDATE artifact_catalog_changes SET created_at=now()-interval '30 days' WHERE project_id=$1`,
      [p],
    );
    await getPool().query(
      `UPDATE artifact_catalog_project_state SET seq=seq+20000 WHERE project_id=$1`,
      [p],
    );
    await pruneArtifactCatalogChanges({ batchRows: 1 });
    expect(await count()).toBe(0);
    expect(Number((await state(p)).change_rows)).toBe(0);
    await getPool().query(
      "UPDATE artifact_catalog_project_state SET change_rows=NULL WHERE project_id=$1",
      [p],
    );
    await snapshot(p, items(2));
    expect((await state(p)).change_rows).toBeNull();
    expect(
      (await artifactCatalogChangeRowGauges()).projects_unmeasured,
    ).toBeGreaterThan(0);
    await backfillArtifactCatalogChangeRows({ maxProjects: 10_000 });
    expect(Number((await state(p)).change_rows)).toBe(await count());
    expect((await artifactCatalogChangeRowGauges()).projects_unmeasured).toBe(
      0,
    );
  });
});

describe("the reset-sentinel constraint (N-b, C3)", () => {
  test("enforced, added NOT VALID, and validated only without violators", async () => {
    const db = getPool();
    expect(await ensureArtifactCatalogChangeCheck(db)).toBe(true);
    const p = randomUUID();
    for (const [entry_id, op] of [
      ["", "upsert"],
      ["e1", "reset"],
    ])
      await expect(
        db.query(
          "INSERT INTO artifact_catalog_changes(project_id,seq,entry_id,op) VALUES($1,1,$2,$3)",
          [p, entry_id, op],
        ),
      ).rejects.toThrow();
    await db.query(
      `ALTER TABLE artifact_catalog_changes DROP CONSTRAINT ${ARTIFACT_CATALOG_CHANGE_CHECK}`,
    );
    await db.query(
      "INSERT INTO artifact_catalog_changes(project_id,seq,entry_id,op) VALUES($1,1,'','upsert')",
      [p],
    );
    // A violator: the constraint is added, not validated, and nothing throws.
    expect(await ensureArtifactCatalogChangeCheck(db)).toBe(false);
    expect(await artifactCatalogChangeCheckValidated(db)).toBe(false);
    await db.query("DELETE FROM artifact_catalog_changes WHERE project_id=$1", [
      p,
    ]);
    expect(await ensureArtifactCatalogChangeCheck(db)).toBe(true);
    expect(await artifactCatalogChangeCheckValidated(db)).toBe(true);
  });
});

describe("the hint outbox (rev6)", () => {
  async function dueProject() {
    const p = await project({ [randomUUID()]: "owner" });
    await snapshot(p, items(1));
    return p;
  }
  const seqOf = async (p: string) => Number((await state(p)).seq);
  const writeMore = (p: string, n: number) => snapshot(p, items(n, `w${n}`));

  test("a catalog unchanged since hints began owes nothing; its first change owes one", async () => {
    const p = await dueProject();
    await getPool().query(
      "UPDATE artifact_catalog_project_state SET published_seq=NULL WHERE project_id=$1",
      [p],
    );
    expect(await claimArtifactCatalogHint(p)).toBeNull();
    expect(
      await artifactCatalogHintsDue({ owning_bay_id: bay, limit: 10_000 }),
    ).not.toContain(p);
    const before = await seqOf(p);
    await writeMore(p, 2);
    expect(Number((await state(p)).published_seq)).toBe(before);
    expect((await claimArtifactCatalogHint(p))?.target_seq).toBe(before + 1);
  });

  test("1: a failed target is retained; the retry delivers it; nobody advances in between", async () => {
    const p = await dueProject();
    const target = await seqOf(p);
    const a = (await claimArtifactCatalogHint(p))!;
    expect(a.target_seq).toBe(target);
    expect(await claimArtifactCatalogHint(p)).toBeNull();
    expect(await failArtifactCatalogHint(a, 0)).toBe(true);
    expect(Number((await state(p)).published_seq)).toBeLessThan(target);
    const retry = (await claimArtifactCatalogHint(p))!;
    expect(retry.target_seq).toBe(target);
    expect(retry.attempts).toBe(1);
    expect(await completeArtifactCatalogHint(retry)).toBe(true);
    expect(Number((await state(p)).published_seq)).toBe(target);
  });

  test("2: under continuous writes every retry keeps the target; then a new one opens clean", async () => {
    const p = await dueProject();
    const target = await seqOf(p);
    for (let attempt = 0; attempt < 4; attempt++) {
      const claim = (await claimArtifactCatalogHint(p))!;
      expect(claim.target_seq).toBe(target);
      expect(claim.attempts).toBe(attempt);
      await writeMore(p, attempt + 2);
      expect(await failArtifactCatalogHint(claim, 0)).toBe(true);
    }
    // The 5th failure gives up: advance to the retained target.
    const last = (await claimArtifactCatalogHint(p))!;
    expect(last.attempts).toBe(4);
    expect(await completeArtifactCatalogHint(last)).toBe(true);
    expect(Number((await state(p)).published_seq)).toBe(target);
    const next = (await claimArtifactCatalogHint(p))!;
    expect(next.target_seq).toBe(await seqOf(p));
    expect(next.attempts).toBe(0);
  });

  test("3/4/5: an expired claim taken over counts an attempt; the old token changes nothing", async () => {
    const p = await dueProject();
    const t1 = (await claimArtifactCatalogHint(p))!;
    await getPool().query(
      "UPDATE artifact_catalog_project_state SET claim_expires_at=now()-interval '1 second' WHERE project_id=$1",
      [p],
    );
    const t2 = (await claimArtifactCatalogHint(p))!;
    expect(t2.target_seq).toBe(t1.target_seq);
    expect(t2.attempts).toBe(1);
    expect(await renewArtifactCatalogHint(t1)).toBe(false);
    expect(await failArtifactCatalogHint(t1, 0)).toBe(false);
    expect(await completeArtifactCatalogHint(t1)).toBe(false);
    const s = await state(p);
    expect(s.claim_token).toBe(t2.token);
    expect(Number(s.attempts)).toBe(1);
    expect(await renewArtifactCatalogHint(t2)).toBe(true);
  });

  test("6: of two racing claims exactly one succeeds", async () => {
    const p = await dueProject();
    const results = await Promise.all([
      claimArtifactCatalogHint(p),
      claimArtifactCatalogHint(p),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("7: after success, later writes open a new target with no attempts", async () => {
    const p = await dueProject();
    const claim = (await claimArtifactCatalogHint(p))!;
    await writeMore(p, 3);
    expect(await completeArtifactCatalogHint(claim)).toBe(true);
    const next = (await claimArtifactCatalogHint(p))!;
    expect(next.target_seq).toBe(await seqOf(p));
    expect(next.attempts).toBe(0);
  });

  test("a retry waits for its backoff", async () => {
    const p = await dueProject();
    const claim = (await claimArtifactCatalogHint(p))!;
    await failArtifactCatalogHint(claim, 60_000);
    expect(await claimArtifactCatalogHint(p)).toBeNull();
    expect(
      await artifactCatalogHintsDue({ owning_bay_id: bay, limit: 10_000 }),
    ).not.toContain(p);
  });

  test("recipients: owners and collaborators with a live session, never viewers", async () => {
    const [owner, collaborator, viewer, offline] = [1, 2, 3, 4].map(() =>
      randomUUID(),
    );
    const p = await project({
      [owner]: "owner",
      [collaborator]: "collaborator",
      [viewer]: "viewer",
      [offline]: "collaborator",
    });
    const got = await artifactCatalogHintRecipients({
      project_id: p,
      owning_bay_id: bay,
      candidates: [owner, collaborator, viewer, randomUUID()],
    });
    expect(got.sort()).toEqual([owner, collaborator].sort());
    await getPool().query(
      "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
      [p],
    );
    expect(
      await artifactCatalogHintRecipients({
        project_id: p,
        owning_bay_id: bay,
        candidates: [owner],
      }),
    ).toEqual([]);
  });
});

describe("N-e: catalog writers lock the project row FOR SHARE, not KEY SHARE", () => {
  test("the live-project lock conflicts with soft delete and rehome", async () => {
    // KEY SHARE does not conflict with UPDATEs of non-key columns, but the
    // live-on-bay predicate reads two of them (deleted, owning_bay_id): a
    // soft delete or rehome must wait for an in-flight catalog writer.
    const queries: string[] = [];
    const db = {
      query: async (sql: string, params?: any[]) => {
        queries.push(sql);
        return sql.includes("FROM projects")
          ? { rows: [{ project_id: params?.[0] }] }
          : { rows: [] };
      },
    };
    await lockArtifactCatalogProject(db as any, randomUUID(), bay);
    const projectLock = queries.find((sql) => sql.includes("FROM projects"))!;
    expect(projectLock).toMatch(/FOR SHARE/);
    expect(projectLock).not.toMatch(/KEY SHARE/);
  });
});
