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
  test("only live demand admits initial discovery; renewals do not duplicate it", async () => {
    const register = () => env.worker("b").call("registerRevisionReceiver");
    await expect(register()).rejects.toThrow("no home demand");
    expect(
      await env.sql("owner", "SELECT job_id FROM collaboration_scan_jobs"),
    ).toEqual([]);
    const source = await env.worker("host").call("explicitCensusFixture");
    await env
      .worker("a")
      .call("demand", {
        operation: "acquire",
        opts: {
          consumer_id: randomUUID(),
          scope: { kind: "projects", project_ids: [env.project] },
        },
      });
    expect(await register()).toMatchObject({ armed: true });
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
    await register();
    expect(
      await env.sql(
        "owner",
        "SELECT count(*)::integer AS n FROM collaboration_scan_receipts",
      ),
    ).toEqual([{ n: 1 }]);
    expect(await env.worker("owner").call("scanDispatch")).toMatchObject({
      attempted: 1,
      unknown: 0,
    });
    await env.converge(async () => {
      const page = await env.hub("a", "listResources", {
        project_id: env.project,
      });
      return page.items.some(
        (item: any) => item.chat_path === source.chat_path,
      );
    });
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
