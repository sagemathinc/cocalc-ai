/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
A person's or agent's GPU launch, on their home bay (PROJECT_FUNDING.md §5):

1. Unless own_key, the project's owning bay is asked first, as this bay (the
   actor's home, which it verifies): its active funding approval pays, if it
   has one and it allows this actor.
2. Otherwise the caller's own key, exactly as before.
3. A person with no usable key of their own records a request in the
   project instead, and is told how GPU use there gets approved.

An agent whose project's approval doesn't allow agents (or has none) uses
its own path: its human's approval of each launch (step 6b).
*/

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { GpuKeyUse } from "@cocalc/server/gpu/key-use";
import type { GpuAgentPrincipalWire } from "@cocalc/server/gpu/pods";
import type {
  ProjectFundingRequestRequest,
  ProjectLaunchRouteRequest,
  ProjectLaunchRouteResult,
} from "@cocalc/util/gpu/project-funding";
import type { GpuPodSummary } from "@cocalc/util/gpu/types";

export interface ProjectLaunchHomeDeps {
  // for tests: the calls to the project's owning bay
  projectBay?: (project_id: string) => Promise<{
    route(req: ProjectLaunchRouteRequest): Promise<ProjectLaunchRouteResult>;
    request(
      req: ProjectFundingRequestRequest,
    ): Promise<{ request_id?: string }>;
  }>;
  // for tests: the own-key launch
  launchOwnKey?: (opts: any) => Promise<GpuPodSummary>;
}

async function defaultProjectBay(project_id: string) {
  const { resolveProjectBay } =
    await import("@cocalc/server/inter-bay/directory");
  const owner = (await resolveProjectBay(project_id))?.bay_id;
  const bay = `${owner ?? ""}`.trim() || getConfiguredBayId();
  if (bay === getConfiguredBayId()) {
    const routes = await import("@cocalc/server/gpu/project-funding-routes");
    return {
      route: (req: ProjectLaunchRouteRequest) =>
        routes.routeProjectLaunchLocal(req),
      request: async (req: ProjectFundingRequestRequest) => ({
        request_id: await routes.recordProjectFundingRequestLocal(req),
      }),
    };
  }
  const { createInterBayAccountLocalClient } =
    await import("@cocalc/conat/inter-bay/api");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  const client = createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: bay,
    timeout: 60_000,
  });
  return {
    route: (req: ProjectLaunchRouteRequest) =>
      client.gpuProjectLaunchRoute(req),
    request: (req: ProjectFundingRequestRequest) =>
      client.gpuProjectFundingRequest(req),
  };
}

export async function launchOnHome(
  opts: {
    account_id: string;
    project_id: unknown;
    spec: unknown;
    agent?: { principal: GpuAgentPrincipalWire; operation_id: string };
    own_key?: boolean;
    key_use: GpuKeyUse | undefined;
  },
  deps: ProjectLaunchHomeDeps = {},
): Promise<GpuPodSummary> {
  const { isNoOwnKeyError, launchGpuPodLocal } =
    await import("@cocalc/server/gpu/pods");
  const { ProjectApprovalRequired, isProjectFundingRetry } =
    await import("@cocalc/server/gpu/project-funding-routes");
  const project_id = `${opts.project_id ?? ""}`;
  const principal = opts.agent?.principal;
  const bay = async () =>
    await (deps.projectBay ?? defaultProjectBay)(project_id);
  if (opts.own_key !== true) {
    const routed = await (
      await bay()
    ).route({
      source_bay_id: getConfiguredBayId(),
      project_id,
      actor: principal
        ? {
            kind: "agent",
            account_id: opts.account_id,
            project_id: principal.project_id,
            agent_id: principal.agent_id,
            run_id: principal.run_id,
          }
        : { kind: "user", account_id: opts.account_id },
      ...(opts.agent ? { operation_id: opts.agent.operation_id } : {}),
      spec: opts.spec,
    });
    if (routed.status === "launched") return routed.pod;
  }
  try {
    return await (deps.launchOwnKey ?? launchGpuPodLocal)({
      account_id: opts.account_id,
      project_id: opts.project_id,
      spec: opts.spec,
      ...(opts.agent ? { agent: opts.agent } : {}),
      key_use: opts.key_use,
    });
  } catch (err) {
    if (principal || opts.own_key === true || !isNoOwnKeyError(err)) {
      throw err;
    }
    const { request_id } = await (
      await bay()
    )
      .request({
        source_bay_id: getConfiguredBayId(),
        project_id,
        actor: { kind: "user", account_id: opts.account_id },
        spec: opts.spec,
      })
      .catch((e) => {
        // approved meanwhile: the answer is to launch again
        if (isProjectFundingRetry(e)) throw e;
        return { request_id: undefined };
      });
    throw new ProjectApprovalRequired(
      `${(err as Error).message} Or a collaborator with their own RunPod key can approve GPU use in this project, paid by their account: they'll see your request at the top of the project.`,
      request_id,
    );
  }
}

// ---- a project's funded pods, asked from the actor's home (§7) ----

type HomeActorOpts = {
  account_id: string;
  project_id: string;
  agent?: { project_id: string; agent_id: string; run_id?: string };
};

function actorOf(opts: HomeActorOpts) {
  return opts.agent
    ? {
        kind: "agent" as const,
        account_id: opts.account_id,
        project_id: opts.agent.project_id,
        agent_id: opts.agent.agent_id,
        ...(opts.agent.run_id ? { run_id: opts.agent.run_id } : {}),
      }
    : { kind: "user" as const, account_id: opts.account_id };
}

async function projectBayPods(project_id: string) {
  const { resolveProjectBay } =
    await import("@cocalc/server/inter-bay/directory");
  const owner = (await resolveProjectBay(project_id))?.bay_id;
  const bay = `${owner ?? ""}`.trim() || getConfiguredBayId();
  if (bay === getConfiguredBayId()) {
    const r = await import("@cocalc/server/gpu/project-funding-routes");
    return {
      pods: (req: any) => r.listProjectPodsLocal(req),
      terminate: (req: any) => r.terminateProjectPodLocal(req),
    };
  }
  const { createInterBayAccountLocalClient } =
    await import("@cocalc/conat/inter-bay/api");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  const client = createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: bay,
    timeout: 60_000,
  });
  return {
    pods: (req: any) => client.gpuProjectPodsRoute(req),
    terminate: (req: any) => client.gpuProjectTerminateRoute(req),
  };
}

export async function projectPodsOnHome(
  opts: HomeActorOpts & { cursor?: string },
) {
  return await (
    await projectBayPods(opts.project_id)
  ).pods({
    source_bay_id: getConfiguredBayId(),
    project_id: opts.project_id,
    actor: actorOf(opts),
    cursor: opts.cursor,
  });
}

export async function projectTerminateOnHome(
  opts: HomeActorOpts & { pod_id: string },
) {
  return await (
    await projectBayPods(opts.project_id)
  ).terminate({
    source_bay_id: getConfiguredBayId(),
    project_id: opts.project_id,
    actor: actorOf(opts),
    pod_id: opts.pod_id,
  });
}

// The project's funding state, asked from the actor's home (§6).
export async function projectFundingStateOnHome(opts: HomeActorOpts) {
  const { resolveProjectBay } =
    await import("@cocalc/server/inter-bay/directory");
  const owner = (await resolveProjectBay(opts.project_id))?.bay_id;
  const bay = `${owner ?? ""}`.trim() || getConfiguredBayId();
  const req = {
    source_bay_id: getConfiguredBayId(),
    project_id: opts.project_id,
    actor: actorOf(opts),
  };
  if (bay === getConfiguredBayId()) {
    const r = await import("@cocalc/server/gpu/project-funding-routes");
    return await r.projectFundingStateLocal(req);
  }
  const { createInterBayAccountLocalClient } =
    await import("@cocalc/conat/inter-bay/api");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: bay,
    timeout: 30_000,
  }).gpuProjectFundingStateRoute(req);
}
