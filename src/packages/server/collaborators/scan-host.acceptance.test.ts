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
    const before = await control("getCollaborationReconciliationStatus");
    if (before.current_run_id) scan.expected_run_id = before.current_run_id;
    expect(await control("requestCollaborationReconciliation")).toMatchObject({
      admission: "accepted",
      run_id: receipt.job_id,
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
    expect(await control("requestCollaborationReconciliation")).toMatchObject({
      admission: "accepted",
      run_id: receipt.job_id,
      replayed: true,
    });
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 180000);
});
