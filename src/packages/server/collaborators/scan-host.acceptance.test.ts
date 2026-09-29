import { randomUUID } from "node:crypto";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("explicit Scan through real hosted census and catalog", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance({ explicitCensus: true });
    await env.start();
    await env.worker("owner").call("installScan");
    await env.worker("a").call("installScan");
    // Exercise the supported owner-bay control subject, without a direct-host
    // URL. The host authenticates and subscribes to its own control service.
    await env.sql(
      "owner",
      "INSERT INTO project_hosts(id,bay_id) VALUES($1,$2)",
      [env.host, "acceptance-owner"],
    );
  }, 240000);
  afterAll(async () => env?.close(), 60000);
  test("unmediated source discovery reaches an authorized home without starting compute", async () => {
    const source = await env.worker("host").call("explicitCensusFixture");
    const request = {
      project_id: env.project,
      request_id: randomUUID(),
      mode: "reconcile",
    };
    const receipt = await env
      .worker("b")
      .call("scanPublic", { method: "requestScan", request });
    expect(receipt.admission).toBe("accepted");
    const scan: {
      protocol_version: number;
      project_id: string;
      run_id: string;
      expected_run_id?: string;
    } = {
      protocol_version: 1,
      project_id: env.project,
      run_id: receipt.job_id,
    };
    const control = (method: string) =>
      env.worker("host").call("hostCensusControl", { method, request: scan });
    expect(await env.worker("owner").call("scanDispatch")).toMatchObject({
      attempted: 1,
      pending: 1,
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
    await env.converge(
      async () =>
        (await control("getCollaborationReconciliationStatus")).state ===
        "discovered",
    );
    expect(await control("getCollaborationReconciliationStatus")).toMatchObject(
      { state: "discovered", run_id: receipt.job_id, pending_candidates: 0 },
    );
    // Observe the real dispatch cooldown rather than rewriting durable clocks.
    await new Promise((resolve) => setTimeout(resolve, 5100));
    expect(await env.worker("owner").call("scanDispatch")).toMatchObject({
      attempted: 1,
      discovered: 1,
      unknown: 0,
    });
    expect(
      await env.worker("b").call("scanPublic", {
        method: "getScanStatus",
        request: { project_id: env.project, job_id: receipt.job_id },
      }),
    ).toMatchObject({ allowed: true, value: { state: "discovered" } });
    expect(await env.worker("owner").call("scanDispatch")).toMatchObject({
      attempted: 0,
      unknown: 0,
    });
    expect(await control("requestCollaborationReconciliation")).toMatchObject({
      admission: "accepted",
      run_id: receipt.job_id,
      replayed: true,
    });
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 180000);
});
