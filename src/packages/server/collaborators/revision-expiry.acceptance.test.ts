import { revisionInterestPruneSql } from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import { revisionReceiverPruneSql } from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
import {
  projectDemandPruneSql,
  demandPruneSql,
} from "@cocalc/database/postgres/collaborators/collaborators-demand";
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
    await env.worker("owner").call("demand", { operation: "install" });
    await env.sql(
      "owner",
      `INSERT INTO collaboration_revision_interests(project_id,home_bay_id,lease_id,expires_at,renew_after)
      SELECT $1,'live-'||n,md5('interest-'||n)::uuid,now()+interval '1 day',now()
      FROM generate_series(1,100000) n`,
      [env.project],
    );
    await env.sql("owner", "ANALYZE collaboration_revision_interests");
    await env.sql(
      "owner",
      `INSERT INTO collaboration_revision_receivers(project_id,home_bay_id,owner_bay_id,lease_id,expires_at)
      SELECT md5('receiver-'||n)::uuid,'expiry-home','owner',md5('receiver-lease-'||n)::uuid,now()+interval '1 day'
      FROM generate_series(1,100000) n`,
    );
    await env.sql("owner", "ANALYZE collaboration_revision_receivers");
  }, 240000);
  afterAll(async () => await env?.close(), 60000);
  async function measure(
    scenario: string,
    expected: number,
    receiver = false,
    demand = false,
  ) {
    const rows = await env.sql(
      "owner",
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${demand ? projectDemandPruneSql : receiver ? revisionReceiverPruneSql : revisionInterestPruneSql}`,
      demand ? [] : [receiver ? "expiry-home" : env.project],
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
  test("consumer expiry uses bounded batches among 100000 live leases", async () => {
    const insert = async (prefix: string, count: number, expired: boolean) => {
      await env.sql(
        "owner",
        `INSERT INTO collaboration_demand
        (account_id,consumer_id,lease_id,scope,expires_at,renew_after,grace_until)
        SELECT $1,md5($2||n)::uuid,md5($2||n)::uuid,'{"kind":"all"}'::jsonb,
          now(),now(),now()+$4::integer*interval '1 day'
        FROM generate_series(1,$3::integer) n`,
        [env.accounts[0], prefix, count, expired ? -1 : 1],
      );
      await env.sql("owner", "ANALYZE collaboration_demand");
    };
    const check = async (scenario: string, expected: number) => {
      const rows = await env.sql(
        "owner",
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${demandPruneSql}`,
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
        }) + "\n",
      );
      expect(explain.Plan["Actual Rows"]).toBe(expected);
      expect(blocks).toBeLessThan(expected ? 5000 : 100);
    };
    await insert("consumer-live-", 100000, false);
    await check("consumers-live", 0);
    await insert("consumer-expired-", 505, true);
    await check("consumers-first-batch", 500);
    await check("consumers-final-batch", 5);
    await check("consumers-drained", 0);
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_demand",
      ),
    ).toEqual([{ n: 100000 }]);
  });
  test("reverse demand expiry drains without scanning 100000 live rows", async () => {
    await env.sql(
      "owner",
      `INSERT INTO collaboration_project_demand(account_id,project_id,grace_until)
      SELECT $1,md5('demand-live-'||n)::uuid,now()+interval '1 day'
      FROM generate_series(1,100000) n`,
      [env.accounts[0]],
    );
    await env.sql("owner", "ANALYZE collaboration_project_demand");
    await measure("project-demand-live", 0, false, true);
    await env.sql(
      "owner",
      `INSERT INTO collaboration_project_demand(account_id,project_id,grace_until)
      SELECT $1,md5('demand-expired-'||n)::uuid,now()-interval '1 day'
      FROM generate_series(1,105) n`,
      [env.accounts[0]],
    );
    await env.sql("owner", "ANALYZE collaboration_project_demand");
    await measure("project-demand-first-batch", 100, false, true);
    await measure("project-demand-final-batch", 5, false, true);
    await measure("project-demand-drained", 0, false, true);
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_project_demand",
      ),
    ).toEqual([{ n: 100000 }]);
    await env.sql(
      "owner",
      `INSERT INTO collaboration_project_demand(account_id,project_id,grace_until)
      VALUES($1,$2,now()-interval '1 day')`,
      [env.accounts[0], env.project],
    );
    expect(
      await env
        .worker("owner")
        .call("demand", { operation: "pruneProjectDuringRenewal" }),
    ).toEqual({ deleted: 0, afterCommit: 0 });
    expect(
      await env.sql(
        "owner",
        `SELECT grace_until>now() AS live FROM collaboration_project_demand
      WHERE account_id=$1 AND project_id=$2`,
        [env.accounts[0], env.project],
      ),
    ).toEqual([{ live: true }]);
  });
  test("receiver expiry remains bounded among 100000 live receivers", async () => {
    await measure("receivers-100000-live", 0, true);
    await env.sql(
      "owner",
      `INSERT INTO collaboration_revision_receivers(project_id,home_bay_id,owner_bay_id,lease_id,expires_at)
      SELECT md5('expired-receiver-'||n)::uuid,'expiry-home','owner',md5('expired-lease-'||n)::uuid,now()-interval '1 day'
      FROM generate_series(1,105) n`,
    );
    await env.sql("owner", "ANALYZE collaboration_revision_receivers");
    await measure("receivers-first-batch", 100, true);
    await measure("receivers-final-batch", 5, true);
    await measure("receivers-drained", 0, true);
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_revision_receivers",
      ),
    ).toEqual([{ n: 100000 }]);
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
