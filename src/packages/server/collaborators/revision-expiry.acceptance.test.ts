import { revisionInterestPruneSql } from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("revision interest expiry query cost", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
    await env.worker("owner").call("installRevisionInterest");
    await env.sql(
      "owner",
      `INSERT INTO collaboration_revision_interests(project_id,home_bay_id,lease_id,expires_at,renew_after)
      SELECT $1,'live-'||n,md5('interest-'||n)::uuid,now()+interval '1 day',now()
      FROM generate_series(1,100000) n`,
      [env.project],
    );
    await env.sql("owner", "ANALYZE collaboration_revision_interests");
  }, 240000);
  afterAll(async () => await env?.close(), 60000);
  async function measure(scenario: string, expected: number) {
    const rows = await env.sql(
      "owner",
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${revisionInterestPruneSql}`,
      [env.project],
    );
    const explain = rows[0]["QUERY PLAN"][0];
    const blocks =
      (explain.Plan["Shared Hit Blocks"] ?? 0) +
      (explain.Plan["Shared Read Blocks"] ?? 0);
    process.stdout.write(
      JSON.stringify({
        scenario,
        blocks,
        milliseconds: explain["Execution Time"],
        explain,
      }) + "\n",
    );
    expect(explain.Plan["Actual Rows"]).toBe(expected);
    expect(blocks).toBeLessThan(2000);
  }
  test("100000 live interests require bounded work when nothing expired", async () => {
    await measure("100000-live-no-expired", 0);
  });
  test("expiry drains bounded batches without traversing live interests", async () => {
    await env.sql(
      "owner",
      `INSERT INTO collaboration_revision_interests(project_id,home_bay_id,lease_id,expires_at,renew_after)
      SELECT $1,'expired-'||n,md5('expired-interest-'||n)::uuid,now()-interval '1 day',now()
      FROM generate_series(1,105) n`,
      [env.project],
    );
    await env.sql("owner", "ANALYZE collaboration_revision_interests");
    await measure("105-expired-first-batch", 100);
    await measure("105-expired-final-batch", 5);
    await measure("expired-backlog-drained", 0);
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_revision_interests WHERE project_id=$1",
        [env.project],
      ),
    ).toEqual([{ n: 100000 }]);
  });
});
