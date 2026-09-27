import { randomUUID } from "node:crypto";
import "@cocalc/util/db-schema/collaborators-workspace";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { syncCollaboratorsSchema } from "./collaborators-common";
import { listCollaborationResources } from "./collaborators-discovery";
import {
  bumpCollaborationRevision,
  checkCollaborationRevision,
} from "./collaborators-changes";
import { pruneCollaborationAttentionBaselines } from "./collaborators-personal";

const account = randomUUID();
const generation = randomUUID();
let initialized = false;

async function removeFixture() {
  const pool = getPool();
  // Clean only this run, in bounded transactions, even after an assertion fails.
  for (const [table, key] of [
    ["collaboration_personal", "entry_key"],
    ["collaboration_index", "entry_key"],
    ["collaboration_access", "project_id"],
    ["account_project_index", "project_id"],
  ]) {
    for (;;) {
      const result = await pool.query(
        `WITH batch AS MATERIALIZED (
          SELECT ${key} FROM ${table} WHERE account_id=$1 ORDER BY ${key} LIMIT 1000
        ) DELETE FROM ${table} t USING batch b WHERE t.account_id=$1 AND t.${key}=b.${key}`,
        [account],
      );
      if ((result.rowCount ?? 0) < 1000) break;
    }
    expect(
      (
        await pool.query(`SELECT 1 FROM ${table} WHERE account_id=$1 LIMIT 1`, [
          account,
        ])
      ).rows,
    ).toEqual([]);
  }
  await pool.query("DELETE FROM accounts WHERE account_id=$1", [account]);
  await pool.query(
    "DELETE FROM collaboration_account_state WHERE account_id=$1",
    [account],
  );
}

beforeAll(async () => {
  await initEphemeralDatabase({});
  initialized = true;
  await syncCollaboratorsSchema();
  const pool = getPool();
  await pool.query("INSERT INTO accounts(account_id) VALUES($1)", [account]);
  await pool.query(
    `INSERT INTO account_project_index(account_id,project_id,title,users_summary,sort_key)
     SELECT $1::uuid,md5('collaboration-scale-project-' || n)::uuid,'Project ' || n,
       jsonb_build_object($1::uuid::text,jsonb_build_object('group','collaborator')),now()
     FROM generate_series(1,1000) n`,
    [account],
  );
  await pool.query(
    `INSERT INTO collaboration_access(account_id,project_id,generation,lease_until,complete)
     SELECT account_id,project_id,$2,now()+interval '1 hour',TRUE
     FROM account_project_index WHERE account_id=$1`,
    [account, generation],
  );
  await pool.query(
    `INSERT INTO collaboration_index(account_id,entry_key,project_id,generation,kind,
       activity,metadata,participant_ids,search_text)
     SELECT $1,md5(n::text) || md5(n::text),project_id,$2,'conversation',n,
       jsonb_build_object('project_id',project_id,'kind','conversation',
         'resource_id','thread-' || n,'thread_id','thread-' || n,
         'chat_path','/home/user/room.chat','title',title,'participant_ids','[]'::jsonb,
         'created_at',1,'updated_at',n,'activity',1),ARRAY[]::uuid[],title
     FROM (SELECT n,md5('collaboration-scale-project-' || (1+(n-1)%1000))::uuid AS project_id,
       CASE WHEN n=54321 THEN 'Needle discussion' ELSE 'Discussion ' || n END AS title
       FROM generate_series(1,100000) n) fixture`,
    [account, generation],
  );
  await pool.query("ANALYZE collaboration_index");
  await pool.query("ANALYZE collaboration_access");
  await pool.query("ANALYZE account_project_index");
  // Fixture construction remains bounded independently of production coalescing.
  for (let after = 0; after < 100000; after += 1000)
    await pool.query(
      `INSERT INTO collaboration_personal(account_id,project_id,entry_key,attention_generation,following,collected,last_mention)
      SELECT account_id,project_id,entry_key,generation,activity=54321,activity=54321,
        CASE WHEN activity=54322 THEN 1 ELSE 0 END FROM collaboration_index WHERE account_id=$1 AND activity>$2 AND activity<=$3`,
      [account, after, after + 1000],
    );
  await pool.query(
    "UPDATE collaboration_index SET participant_ids=ARRAY[$1::uuid] WHERE account_id=$1 AND activity=54323",
    [account],
  );
  await pool.query("ANALYZE collaboration_personal");
  await pool.query("ANALYZE collaboration_index");
}, 120_000);

afterAll(async () => {
  try {
    if (initialized) await removeFixture();
  } finally {
    await testCleanup();
  }
}, 120_000);

test.each(["following", "for-you", "collected"] as const)(
  "sparse %s scope does not scan 100000 resources or baseline personal rows",
  async (scope) => {
    const pool = getPool();
    const calls = jest.spyOn(pool, "query");
    let statement: [string, unknown[] | undefined] | undefined;
    try {
      const page = await listCollaborationResources({
        account_id: account,
        scope,
      });
      expect(page.items.map((item) => item.resource_id)).toEqual(
        scope === "for-you"
          ? ["thread-54323", "thread-54322", "thread-54321"]
          : ["thread-54321"],
      );
      expect(calls.mock.calls.length).toBeLessThanOrEqual(8);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      const call = calls.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("SELECT r.entry_key,r.activity,r.metadata"),
      );
      statement = call && [call[0] as string, call[1] as unknown[] | undefined];
    } finally {
      calls.mockRestore();
    }
    expect(statement).toBeDefined();
    const result = await pool.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement![0]}`,
      statement![1],
    );
    const root = result.rows[0]["QUERY PLAN"][0].Plan;
    const visit = (node: any) => {
      if (
        ["collaboration_index", "collaboration_personal"].includes(
          node["Relation Name"],
        )
      ) {
        const visited =
          ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
          (node["Actual Loops"] ?? 1);
        if (visited >= 5000)
          throw Error(`Unbounded ${scope} plan: ${JSON.stringify(root)}`);
      }
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(root);
  },
);

test("1000-project directory returns a bounded page with constant query count", async () => {
  const pool = getPool();
  const calls = jest.spyOn(pool, "query");
  let pageQuery: [string, unknown[] | undefined] | undefined;
  try {
    const page = await listCollaborationResources({
      account_id: account,
      kind: "conversation",
    });
    expect(page.items).toHaveLength(50);
    expect(page.next).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
    expect(calls.mock.calls.length).toBeLessThanOrEqual(8);
    expect(page.items[0].updated_at).toBe(100000);
    const query = calls.mock.calls.find(
      ([query]) =>
        typeof query === "string" &&
        query.includes("SELECT r.entry_key,r.activity,r.metadata"),
    );
    if (query)
      pageQuery = [query[0] as string, query[1] as unknown[] | undefined];
  } finally {
    calls.mockRestore();
  }
  expect(pageQuery).toBeDefined();
  const result = await pool.query(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${pageQuery![0]}`,
    pageQuery![1],
  );
  const root = result.rows[0]["QUERY PLAN"][0].Plan;
  const visits: number[] = [];
  const visit = (node: any) => {
    if (node["Relation Name"] === "collaboration_index")
      visits.push(
        ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
          (node["Actual Loops"] ?? 1),
      );
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  expect(visits.length).toBeGreaterThan(0);
  for (const visited of visits) {
    if (visited >= 5000)
      throw Error(`Unbounded first-page plan: ${JSON.stringify(root)}`);
    expect(visited).toBeLessThan(5000);
  }
});

test("selective title search uses indexed candidates rather than scanning 100000 rows", async () => {
  const pool = getPool();
  const calls = jest.spyOn(pool, "query");
  let queries: [string, unknown[] | undefined][];
  try {
    const page = await listCollaborationResources({
      account_id: account,
      search: "Needle",
    });
    expect(page.items.map((item) => item.resource_id)).toEqual([
      "thread-54321",
    ]);
    expect(calls.mock.calls.length).toBeLessThanOrEqual(8);
    queries = calls.mock.calls
      .filter(
        ([query]) =>
          typeof query === "string" &&
          query.includes("SELECT r.entry_key,r.activity,r.metadata"),
      )
      .map(([query, params]) => [
        query as string,
        params as unknown[] | undefined,
      ]);
  } finally {
    calls.mockRestore();
  }
  expect(queries!).toHaveLength(1);
  for (const [query, params] of queries!) {
    const result = await pool.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
      params,
    );
    const root = result.rows[0]["QUERY PLAN"][0].Plan;
    const scans: any[] = [];
    const visit = (node: any) => {
      if (node["Relation Name"] === "collaboration_index") scans.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(root);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      const visited =
        ((scan["Actual Rows"] ?? 0) + (scan["Rows Removed by Filter"] ?? 0)) *
        (scan["Actual Loops"] ?? 1);
      if (visited >= 5000)
        throw Error(`Unbounded selective search plan: ${JSON.stringify(root)}`);
      expect(visited).toBeLessThan(5000);
    }
  }
});

test("revoking 50000 attention baselines coalesces revision writes and rolls back atomically", async () => {
  const before = await checkCollaborationRevision(account);
  const revision = JSON.parse(
    Buffer.from(before.revision, "base64url").toString(),
  ).revision;
  const project = randomUUID();
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout='10s'");
    const selected = await db.query(
      `UPDATE collaboration_personal s SET project_id=$2 FROM collaboration_index r
      WHERE s.account_id=$1 AND r.account_id=s.account_id AND r.entry_key=s.entry_key AND r.activity<=50000`,
      [account, project],
    );
    expect(selected.rowCount).toBe(50000);
    await db.query(
      "DELETE FROM collaboration_index WHERE account_id=$1 AND activity<=50000",
      [account],
    );
    await pruneCollaborationAttentionBaselines(db, account, project);
    await bumpCollaborationRevision(db, account);
    expect(
      (
        await db.query(
          "SELECT 1 FROM collaboration_personal WHERE account_id=$1 AND project_id=$2",
          [account, project],
        )
      ).rows,
    ).toEqual([]);
    expect(
      Number(
        (
          await db.query(
            "SELECT revision FROM collaboration_account_state WHERE account_id=$1",
            [account],
          )
        ).rows[0].revision,
      ),
    ).toBe(Number(revision) + 1);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  expect(
    (await checkCollaborationRevision(account, before.revision)).reset,
  ).toBe(false);
}, 30000);
