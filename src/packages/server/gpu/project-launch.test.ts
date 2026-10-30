/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Launches in a project (PROJECT_FUNDING.md §5): the project's bay routes a
// launch to its active approval (or says there is none), records requests,
// and the caller's home bay tries the approval first, then the caller's own
// key, then asks the project. PGlite for the project's bay; the funder's
// home and the own-key launch are injected.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  ProjectApprovalRequired,
  ProjectFundingRetry,
  recordProjectFundingRequestLocal,
  routeProjectLaunchLocal,
  type ProjectLaunchDeps,
} from "./project-funding-routes";
import { launchOnHome } from "./project-launch";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  max_runtime_minutes: 60,
};
const POD = { id: "pod-1" } as any;

interface World {
  project_id: string;
  funder: string;
  student: string;
  outsider: string;
  approval_id: string;
  layer_id: string;
}

async function world(
  over: {
    route?: "active" | "none";
    agents_allowed?: boolean;
    owner?: string;
  } = {},
): Promise<World> {
  const w = {
    project_id: randomUUID(),
    funder: randomUUID(),
    student: randomUUID(),
    outsider: randomUUID(),
    approval_id: randomUUID(),
    layer_id: randomUUID(),
  };
  await getPool().query(
    `INSERT INTO projects (project_id, owning_bay_id, deleted, users) VALUES ($1, $2, false, $3)`,
    [
      w.project_id,
      over.owner ?? getConfiguredBayId(),
      JSON.stringify({
        [w.funder]: { group: "owner" },
        [w.student]: { group: "collaborator" },
      }),
    ],
  );
  if (over.route !== "none") {
    await getPool().query(
      `INSERT INTO project_compute_approvals
         (id, kind, project_id, provider, state, approval_id, funder_account_id,
          funder_bay_id, layer_id, version, display)
       VALUES ($1, 'approval', $2, 'runpod', 'active', $3, $4, 'bay-h', $5, 2, $6)`,
      [
        randomUUID(),
        w.project_id,
        w.approval_id,
        w.funder,
        w.layer_id,
        JSON.stringify({
          authorized_usd: "400",
          ends_at: new Date(Date.now() + 86400_000).toISOString(),
          agents_allowed: over.agents_allowed ?? true,
        }),
      ],
    );
  }
  return w;
}

function deps(): ProjectLaunchDeps & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    accountHomeBay: async () => getConfiguredBayId(),
    fundedLaunch: async (req) => {
      calls.push(req);
      return POD;
    },
  };
}

async function requests(project_id: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM project_compute_approvals WHERE project_id = $1 AND kind = 'request' ORDER BY created`,
    [project_id],
  );
  return rows;
}

describeDb("routing a launch on the project's bay", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS projects (project_id UUID PRIMARY KEY, owning_bay_id TEXT, deleted BOOLEAN, users JSONB)",
    );
    await syncSchema({
      project_compute_approvals: SCHEMA.project_compute_approvals,
      project_rehome_imports: SCHEMA.project_rehome_imports,
    });
  });

  it("sends the project's own launch to its active approval, naming exactly that approval", async () => {
    const w = await world();
    const d = deps();
    const r = await routeProjectLaunchLocal(
      { project_id: w.project_id, actor: { kind: "project" }, spec: SPEC },
      d,
    );
    expect(r).toEqual({ status: "launched", pod: POD });
    expect(d.calls).toEqual([
      {
        source_bay_id: getConfiguredBayId(),
        project_id: w.project_id,
        approval_id: w.approval_id,
        layer_id: w.layer_id,
        funder_account_id: w.funder,
        actor: { kind: "project" },
        spec: SPEC,
      },
    ]);
  });

  it("routes a collaborator and an agent of this project, as themselves", async () => {
    const w = await world();
    const d = deps();
    await routeProjectLaunchLocal(
      {
        project_id: w.project_id,
        actor: { kind: "user", account_id: w.student },
        spec: SPEC,
      },
      d,
    );
    await routeProjectLaunchLocal(
      {
        project_id: w.project_id,
        actor: {
          kind: "agent",
          account_id: w.student,
          project_id: w.project_id,
          agent_id: "agent:a1",
          run_id: "run-1",
        },
        spec: SPEC,
      },
      d,
    );
    expect(d.calls.map((c) => c.actor)).toEqual([
      { kind: "user", account_id: w.student },
      {
        kind: "agent",
        account_id: w.student,
        agent_id: "agent:a1",
        run_id: "run-1",
      },
    ]);
  });

  it("refuses a non-collaborator, an agent of another project, and a call not from the actor's home", async () => {
    const w = await world();
    const d = deps();
    await expect(
      routeProjectLaunchLocal(
        {
          project_id: w.project_id,
          actor: { kind: "user", account_id: w.outsider },
          spec: SPEC,
        },
        d,
      ),
    ).rejects.toThrow(/access denied/);
    await expect(
      routeProjectLaunchLocal(
        {
          project_id: w.project_id,
          actor: {
            kind: "agent",
            account_id: w.student,
            project_id: randomUUID(),
            agent_id: "agent:a1",
          },
          spec: SPEC,
        },
        d,
      ),
    ).rejects.toThrow(/its own project/);
    await expect(
      routeProjectLaunchLocal(
        {
          project_id: w.project_id,
          actor: { kind: "user", account_id: w.student },
          spec: SPEC,
          source_bay_id: "another-bay",
        },
        d,
      ),
    ).rejects.toThrow(/home bay/);
    expect(d.calls).toEqual([]);
  });

  it("says when there's no approval, and when it doesn't allow agents", async () => {
    const none = await world({ route: "none" });
    expect(
      await routeProjectLaunchLocal(
        { project_id: none.project_id, actor: { kind: "project" }, spec: SPEC },
        deps(),
      ),
    ).toEqual({ status: "no_approval" });
    const noAgents = await world({ agents_allowed: false });
    expect(
      await routeProjectLaunchLocal(
        {
          project_id: noAgents.project_id,
          actor: {
            kind: "agent",
            account_id: noAgents.student,
            project_id: noAgents.project_id,
            agent_id: "agent:a1",
          },
          spec: SPEC,
        },
        deps(),
      ),
    ).toEqual({ status: "agents_not_allowed" });
  });

  it("asks to retry when this bay no longer owns the project", async () => {
    const w = await world({ owner: "another-bay" });
    await expect(
      routeProjectLaunchLocal(
        { project_id: w.project_id, actor: { kind: "project" }, spec: SPEC },
        deps(),
      ),
    ).rejects.toThrow(ProjectFundingRetry);
  });

  it("keeps one pending request per project, refreshed by the latest ask; outsiders can't make one", async () => {
    const w = await world({ route: "none" });
    const d = deps();
    const a = await recordProjectFundingRequestLocal(
      { project_id: w.project_id, actor: { kind: "project" }, spec: SPEC },
      d,
    );
    const b = await recordProjectFundingRequestLocal(
      {
        project_id: w.project_id,
        actor: { kind: "user", account_id: w.student },
        spec: { ...SPEC, gpu_count: 2 },
      },
      d,
    );
    expect(b).toBe(a);
    const [r] = await requests(w.project_id);
    expect(r).toMatchObject({
      state: "pending",
      actor_kind: "user",
      actor_account_id: w.student,
      request_summary: {
        gpu_type_id: SPEC.gpu_type_id,
        gpu_count: 2,
        max_runtime_minutes: 60,
      },
    });
    expect(
      await recordProjectFundingRequestLocal(
        {
          project_id: w.project_id,
          actor: { kind: "user", account_id: w.outsider },
          spec: SPEC,
        },
        d,
      ),
    ).toBeUndefined();
    // an expired request is replaced by a new one
    await getPool().query(
      `UPDATE project_compute_approvals SET request_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [a],
    );
    const c = await recordProjectFundingRequestLocal(
      { project_id: w.project_id, actor: { kind: "project" }, spec: SPEC },
      d,
    );
    expect(c).not.toBe(a);
    expect((await requests(w.project_id)).map((r) => r.state)).toEqual([
      "expired",
      "pending",
    ]);
  });
});

describe("a launch on the caller's home bay", () => {
  const account_id = "00000000-1000-4000-8000-000000000001";
  const project_id = "00000000-1000-4000-8000-000000000002";
  const NO_KEY =
    "No RunPod API key is connected. Connect one in Settings → Connectors.";

  function home(
    route: "launched" | "no_approval" | "agents_not_allowed",
    ownKey: "ok" | "no_key",
  ) {
    const log: string[] = [];
    return {
      log,
      deps: {
        projectBay: async () => ({
          route: async (req: any) => {
            log.push(`route:${req.actor.kind}:${req.source_bay_id}`);
            return route === "launched"
              ? { status: "launched" as const, pod: { id: "funded" } as any }
              : { status: route };
          },
          request: async () => {
            log.push("request");
            return { request_id: "req-1" };
          },
        }),
        launchOwnKey: async () => {
          log.push("own");
          if (ownKey === "no_key") throw Error(NO_KEY);
          return { id: "own" } as any;
        },
      },
    };
  }

  it("uses the project's approval first", async () => {
    const h = home("launched", "ok");
    expect(
      await launchOnHome(
        { account_id, project_id, spec: SPEC, key_use: undefined },
        h.deps,
      ),
    ).toEqual({ id: "funded" });
    expect(h.log).toEqual([`route:user:${getConfiguredBayId()}`]);
  });

  it("skips the approval with own_key", async () => {
    const h = home("launched", "ok");
    expect(
      await launchOnHome(
        {
          account_id,
          project_id,
          spec: SPEC,
          own_key: true,
          key_use: undefined,
        },
        h.deps,
      ),
    ).toEqual({ id: "own" });
    expect(h.log).toEqual(["own"]);
  });

  it("falls back to the caller's own key without an approval", async () => {
    const h = home("no_approval", "ok");
    expect(
      await launchOnHome(
        { account_id, project_id, spec: SPEC, key_use: undefined },
        h.deps,
      ),
    ).toEqual({ id: "own" });
  });

  it("asks the project for approval when the caller has no key of their own", async () => {
    const h = home("no_approval", "no_key");
    const err = await launchOnHome(
      { account_id, project_id, spec: SPEC, key_use: undefined },
      h.deps,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProjectApprovalRequired);
    expect(err).toMatchObject({
      code: "gpu_project_approval_required",
      request_id: "req-1",
    });
    expect(h.log).toEqual([
      `route:user:${getConfiguredBayId()}`,
      "own",
      "request",
    ]);
  });

  it("sends an agent its own way (6b) when the approval doesn't allow agents; never a request", async () => {
    const h = home("agents_not_allowed", "no_key");
    const agent = {
      principal: {
        account_id,
        project_id,
        agent_id: "agent:a1",
        run_id: "run-1",
        expires_at: new Date().toISOString(),
      },
      operation_id: "op-1",
    };
    await expect(
      launchOnHome(
        { account_id, project_id, spec: SPEC, agent, key_use: undefined },
        h.deps,
      ),
    ).rejects.toThrow(NO_KEY);
    expect(h.log).toEqual([`route:agent:${getConfiguredBayId()}`, "own"]);
  });
});
