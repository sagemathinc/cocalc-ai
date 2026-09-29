import {
  scanDispatchCandidatesSql,
  scanDispatchPageSql,
} from "@cocalc/database/postgres/collaborators/collaborators-scan";
import { MultibayAcceptance } from "./acceptance/harness";
const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("scan blocked backlog query cost", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
    await env.worker("owner").call("installScan");
  }, 240000);
  afterAll(async () => await env?.close(), 60000);
  test("measures 10000 blocked active jobs", async () => {
    await env.sql(
      "owner",
      `INSERT INTO projects(project_id,owning_bay_id,host_id,users)
      SELECT md5('scan-scale-'||n)::uuid,$1,$2,'{}'::jsonb FROM generate_series(1,10000) n`,
      [env.bays[0], env.host],
    );
    await env.sql(
      "owner",
      `INSERT INTO collaboration_scan_budget(project_id,tokens,updated_at)
      SELECT md5('scan-scale-'||n)::uuid,2,now() FROM generate_series(1,10000) n`,
    );
    await env.sql(
      "owner",
      `INSERT INTO collaboration_scan_jobs(project_id,slot,job_id,state,created_at)
      SELECT md5('scan-scale-'||n)::uuid,0,md5('scan-job-'||n)::uuid,'queued',now() FROM generate_series(1,10000) n`,
    );
    for (const table of [
      "projects",
      "collaboration_scan_jobs",
      "collaboration_scan_budget",
      "collaboration_scan_receipts",
    ])
      await env.sql("owner", `ANALYZE ${table}`);
    const page = await env.sql("owner", scanDispatchPageSql, [
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(page).toHaveLength(20);
    const rows = await env.sql(
      "owner",
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${scanDispatchCandidatesSql}`,
      [env.bays[0], page.map((row) => row.job_id)],
    );
    const explain = rows[0]["QUERY PLAN"][0];
    process.stdout.write(
      JSON.stringify({ scenario: "10000-no-live-receipt", explain }) + "\n",
    );
    expect(explain.Plan["Actual Rows"]).toBe(0);
    expect(
      (explain.Plan["Shared Hit Blocks"] ?? 0) +
        (explain.Plan["Shared Read Blocks"] ?? 0),
    ).toBeLessThan(2000);
  }, 120000);
});
