import { randomUUID } from "node:crypto";
import { MultibayAcceptance } from "./acceptance/harness";
const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("manual scan batches across real owner/home/host services", () => {
  let env: MultibayAcceptance;
  const second = randomUUID();
  beforeAll(async () => {
    env = new MultibayAcceptance({ explicitCensus: true });
    await env.start();
    for (const role of ["owner", "a", "b"] as const)
      await env.worker(role).call("installManualScan");
    await env.sql(
      "owner",
      "INSERT INTO project_hosts(id,bay_id) VALUES($1,$2)",
      [env.host, "acceptance-owner"],
    );
    // A second owner bay with unavailable storage exercises routed partial results.
    for (const role of ["owner", "b"] as const)
      await env.sql(
        role,
        "INSERT INTO projects(project_id,owning_bay_id,users,title) VALUES($1,$2,$3::jsonb,'Second owner project')",
        [
          second,
          "acceptance-b",
          JSON.stringify({ [env.accounts[0]]: { group: "collaborator" } }),
        ],
      );
    await env.sql(
      "a",
      "INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary,title,sort_key) VALUES($1,$2,$3,$4::jsonb,'Second owner project',now())",
      [
        env.accounts[0],
        second,
        "acceptance-b",
        JSON.stringify({ [env.accounts[0]]: { group: "collaborator" } }),
      ],
    );
  }, 240000);
  afterAll(async () => env?.close(), 60000);
  const scan = (request: object) =>
    env.worker("b").call("scanPublic", { method: "scanProjects", request });
  test("selection, real traversal, progress, authorization and partial results without compute", async () => {
    const source = await env.worker("host").call("explicitCensusFixture");
    const projects = await scan({ action: "projects" });
    expect(projects.projects.map((p: any) => p.project_id).sort()).toEqual(
      [env.project, second].sort(),
    );
    const request = {
      action: "start",
      request_id: randomUUID(),
      project_ids: "all",
    };
    const started = await scan(request);
    expect(started.operation.total).toBe(2);
    const identity = started.operation.op_id;
    const aliases = await Promise.all(
      Array.from({ length: 2 }, () =>
        scan({ ...request, request_id: randomUUID(), project_ids: [second] }),
      ),
    );
    expect(aliases.every((value) => value.operation.op_id === identity)).toBe(
      true,
    );
    // Start the normal maintenance worker; no direct Scan execution ticks thereafter.
    await env.worker("a").call("startScanMaintenance");
    await env.converge(async () => {
      const result = await scan({ action: "status", op_id: identity });
      return result.operation.processed === 2;
    });
    const final = await scan({ action: "status", op_id: identity });
    expect(final.operation.counts).toMatchObject({
      successful: 1,
      unavailable: 1,
    });
    expect(final.operation.status).toBe("failed");
    expect((await scan(request)).operation.op_id).toBe(identity);
    await env.converge(async () => {
      const page = await env.hub("a", "listResources", {
        project_id: env.project,
      });
      return page.items.some(
        (item: any) => item.chat_path === source.chat_path,
      );
    });
    expect(
      (
        await env.hub("b", "scanProjects", {
          action: "status",
          op_id: identity,
        })
      ).operation,
    ).toBeUndefined();
    await expect(
      env
        .worker("b")
        .call("scanPublic", { method: "scanProjects", request, agent: true }),
    ).rejects.toThrow();
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 180000);
  test("another human can cancel queued work without traversal and recover through LRO", async () => {
    const operation = (
      await env.hub("b", "scanProjects", {
        action: "start",
        request_id: randomUUID(),
        project_ids: [env.project],
      })
    ).operation;
    await env.hub("b", "scanProjects", {
      action: "cancel",
      op_id: operation.op_id,
    });
    await env.worker("b").call("scanBatchPass");
    const result = await env.hub("b", "scanProjects", {
      action: "status",
      op_id: operation.op_id,
    });
    expect(result.operation.status).toBe("canceled");
    expect(result.operation.counts.cancelled).toBe(1);
  }, 60000);
});
