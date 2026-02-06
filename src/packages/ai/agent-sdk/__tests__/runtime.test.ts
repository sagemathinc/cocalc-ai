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
      writeTextFileToProject: async () => undefined,
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

function makeFsClient(tag: string) {
  return {
    readFile: async (path: string) => `content:${tag}:${path}`,
    writeFile: async () => undefined,
    readdir: async (path: string) => [`entry:${tag}:${path}`],
    rename: async () => undefined,
    move: async () => undefined,
    realpath: async (path: string) => `/abs/${tag}/${path}`,
  };
}

describe("agent-sdk runtime bridge", () => {
  test("builds manifest and executes with single project client", async () => {
    const bridge = createAgentSdkBridge({
      hub: makeHubClient(),
      project: makeProjectClient("default"),
      fs: makeFsClient("default"),
      defaults: { projectId: "project-default" },
    });

    expect(bridge.manifest().length).toBe(14);

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

    const read = await bridge.execute({
      action: {
        actionType: "project.fs.readFile",
        args: { path: "a.txt" },
      },
    });
    expect(read.status).toBe("completed");
    expect(read.result).toEqual({ path: "a.txt", data: "content:default:a.txt" });
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
      fsResolver: async (projectId: string) => makeFsClient(projectId),
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
