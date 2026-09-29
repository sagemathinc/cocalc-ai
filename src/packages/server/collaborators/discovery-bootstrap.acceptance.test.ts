import { randomUUID } from "node:crypto";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("demand-triggered initial discovery over real fabric", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance({ explicitCensus: true });
    await env.start();
    await env.worker("owner").call("installScan");
    await env.worker("a").call("installScan");
    await env.worker("owner").call("installRevisionInterest");
    await env.worker("a").call("installRevisionReceiver");
    await env.worker("a").call("demand", { operation: "install" });
    await env.worker("a").call("enableDiscoveryBootstrap");
    await env.sql(
      "owner",
      "INSERT INTO project_hosts(id,bay_id) VALUES($1,$2)",
      [env.host, env.bays[0]],
    );
  }, 240000);
  afterAll(async () => env?.close(), 60000);
  test("maintenance bootstraps live demand but not a cold membership population", async () => {
    async function eventually(check: () => Promise<boolean>) {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw Error("timed out waiting for autonomous demand bootstrap");
    }
    const register = () => env.worker("b").call("registerRevisionReceiver");
    await expect(register()).rejects.toThrow("no home demand");
    expect(
      await env.sql("owner", "SELECT job_id FROM collaboration_scan_jobs"),
    ).toEqual([]);
    const source = await env.worker("host").call("explicitCensusFixture");
    await env.sql(
      "a",
      `INSERT INTO accounts(account_id,home_bay_id)
      SELECT md5('bootstrap-cold-' || n)::uuid,$1 FROM generate_series(1,1000) n`,
      [env.bays[1]],
    );
    await env.sql(
      "a",
      `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary)
      SELECT md5('bootstrap-cold-' || n)::uuid,$1,$2,
      jsonb_build_object((md5('bootstrap-cold-' || n)::uuid)::text,jsonb_build_object('group','collaborator'))
      FROM generate_series(1,1000) n`,
      [env.project, env.bays[0]],
    );
    await env.worker("owner").call("startRevisionMaintenance");
    await env.worker("a").call("startRevisionMaintenance");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(
      await env.sql(
        "a",
        "SELECT project_id FROM collaboration_revision_receivers",
      ),
    ).toEqual([]);
    expect(
      await env.sql("owner", "SELECT job_id FROM collaboration_scan_jobs"),
    ).toEqual([]);
    await env.worker("a").call("demand", {
      operation: "acquire",
      opts: {
        consumer_id: randomUUID(),
        scope: { kind: "projects", project_ids: [env.project] },
      },
    });
    await eventually(
      async () =>
        (
          await env.sql(
            "a",
            "SELECT receiver_id FROM collaboration_revision_receivers WHERE project_id=$1 AND bootstrap_admitted",
            [env.project],
          )
        ).length === 1,
    );
    const [receiver] = await env.sql(
      "a",
      "SELECT receiver_id,bootstrap_admitted FROM collaboration_revision_receivers WHERE project_id=$1",
      [env.project],
    );
    expect(receiver.bootstrap_admitted).toBe(true);
    const [row] = await env.sql(
      "owner",
      "SELECT request_id,receipt FROM collaboration_scan_receipts WHERE project_id=$1",
      [env.project],
    );
    expect(row.request_id).toBe(receiver.receiver_id);
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_scan_receipts",
      ),
    ).toEqual([{ n: 1 }]);
    await eventually(async () => {
      // Host extraction is ticked explicitly; home/owner scheduling and Scan
      // dispatch use their production timers, with no due-time rewrites.
      await env.worker("host").call("tick");
      const page = await env.hub("a", "listResources", {
        project_id: env.project,
      });
      return page.items.some(
        (item: any) => item.chat_path === source.chat_path,
      );
    });
    await eventually(
      async () =>
        (
          await env.sql(
            "owner",
            "SELECT result FROM collaboration_scan_receipts WHERE request_id=$1",
            [row.request_id],
          )
        )[0]?.result?.state === "discovered",
    );
    expect(
      await env.sql(
        "a",
        "SELECT DISTINCT account_id FROM collaboration_scan_actor_receipts",
      ),
    ).toEqual([{ account_id: env.accounts[0] }]);
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=clock_timestamp()-interval '1 second'",
    );
    await expect(register()).rejects.toThrow("no home demand");
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_scan_receipts",
      ),
    ).toEqual([{ n: 1 }]);
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 180000);
});
