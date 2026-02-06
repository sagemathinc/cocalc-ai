import { createAgentSdkBridge, createLaunchpadAgentSdkBridge } from "../runtime";
import type { HubApi } from "@cocalc/conat/hub/api";
import type { ProjectApi } from "@cocalc/conat/project/api";

function makeHubClient(): Pick<HubApi, "system" | "projects"> {
  return {
    system: {
      ping: () => ({ now: 123 }),
      getCustomize: async (fields?: string[]) => ({ fields } as any),
    } as any,
    projects: {
      createProject: async () => "project-created",
    } as any,
  };
}

function makeProjectClient(tag: string): Pick<ProjectApi, "system" | "apps"> {
  return {
    system: {
      listing: async ({ path }: { path: string }) =>
        [{ name: `${tag}:${path}` }] as any,
      moveFiles: async () => undefined,
      renameFile: async () => undefined,
      realpath: async (path: string) => `/abs/${path}`,
      canonicalPaths: async (paths: string[]) =>
        paths.map((p) => `/canonical/${p}`),
      writeTextFileToProject: async () => undefined,
      readTextFileFromProject: async ({ path }: { path: string }) =>
        `content:${path}`,
    } as any,
    apps: {
      start: async (name: string) =>
        ({
          state: "running",
          port: 1234,
          url: `https://example/${tag}/${name}`,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }) as any,
      stop: async () => undefined,
      status: async () => ({ state: "stopped" }) as any,
    } as any,
  };
}

describe("agent-sdk runtime bridge", () => {
  test("builds manifest and executes with single project client", async () => {
    const bridge = createAgentSdkBridge({
      hub: makeHubClient(),
      project: makeProjectClient("default"),
      defaults: { projectId: "project-default" },
    });

    expect(bridge.manifest().length).toBe(13);

    const ping = await bridge.execute({
      action: { actionType: "hub.system.ping", args: {} },
    });
    expect(ping.status).toBe("completed");
    expect(ping.result).toEqual({ now: 123 });

    const listing = await bridge.execute({
      action: {
        actionType: "project.system.listing",
        args: { path: "tmp" },
      },
    });
    expect(listing.status).toBe("completed");
    expect(listing.result).toEqual([{ name: "default:tmp" }]);
  });

  test("uses projectResolver for targeted launchpad project", async () => {
    const seen: string[] = [];
    const bridge = createLaunchpadAgentSdkBridge({
      hub: makeHubClient(),
      defaults: { projectId: "fallback-project" },
      projectResolver: async (projectId: string) => {
        seen.push(projectId);
        return makeProjectClient(projectId);
      },
    });

    const result = await bridge.execute({
      action: {
        actionType: "project.system.listing",
        args: { path: "data" },
        target: { project_id: "project-abc" },
      },
    });
    expect(result.status).toBe("completed");
    expect(result.result).toEqual([{ name: "project-abc:data" }]);
    expect(seen).toEqual(["project-abc"]);
  });
});
