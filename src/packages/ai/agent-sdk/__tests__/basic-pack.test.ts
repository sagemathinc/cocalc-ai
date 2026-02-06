import { AgentCapabilityRegistry } from "../capabilities";
import { AgentExecutor } from "../executor";
import type { AgentSdkContext } from "../adapters";
import { registerBasicCapabilities } from "../packs";

describe("basic capability pack", () => {
  function createContext(): {
    context: AgentSdkContext;
    calls: {
      createProject: number;
      listing: number;
      writeText: number;
      appStart: number;
      appStop: number;
    };
  } {
    const calls = {
      createProject: 0,
      listing: 0,
      writeText: 0,
      appStart: 0,
      appStop: 0,
    };
    const context: AgentSdkContext = {
      adapters: {
        hub: {
          ping: () => ({ now: 123 }),
          getCustomize: async (_fields?: string[]) => ({} as any),
          createProject: async () => {
            calls.createProject += 1;
            return "project-abc";
          },
        },
        project: {
          listing: async () => {
            calls.listing += 1;
            return [{ name: "a.txt" }] as any;
          },
          writeTextFileToProject: async () => {
            calls.writeText += 1;
          },
          apps: {
            start: async (name: string) => {
              calls.appStart += 1;
              return {
                state: "running",
                port: 1234,
                url: `https://example/${name}`,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
              };
            },
            stop: async () => {
              calls.appStop += 1;
            },
            status: async () => ({ state: "stopped" }),
          },
        },
      },
    };
    return { context, calls };
  }

  test("registers expected action types", () => {
    const registry = new AgentCapabilityRegistry<AgentSdkContext>();
    registerBasicCapabilities(registry);
    const actionTypes = registry.list().map((x) => x.actionType).sort();
    expect(actionTypes).toEqual([
      "hub.projects.create",
      "hub.system.get_customize",
      "hub.system.ping",
      "project.apps.start",
      "project.apps.status",
      "project.apps.stop",
      "project.system.listing",
      "project.system.write_text_file",
    ]);
  });

  test("calls adapter-backed handlers", async () => {
    const { context, calls } = createContext();
    const registry = new AgentCapabilityRegistry<AgentSdkContext>();
    registerBasicCapabilities(registry);
    const executor = new AgentExecutor({ registry });

    const ping = await executor.execute({
      action: { actionType: "hub.system.ping", args: {} },
      context,
    });
    expect(ping.status).toBe("completed");
    expect(ping.result).toEqual({ now: 123 });

    const list = await executor.execute({
      action: {
        actionType: "project.system.listing",
        args: { path: "." },
      },
      context,
    });
    expect(list.status).toBe("completed");
    expect(calls.listing).toBe(1);

    const create = await executor.execute({
      action: {
        actionType: "hub.projects.create",
        args: { title: "My Project" },
      },
      context,
    });
    expect(create.status).toBe("completed");
    expect(create.result).toEqual({ project_id: "project-abc" });
    expect(calls.createProject).toBe(1);

    const start = await executor.execute({
      action: {
        actionType: "project.apps.start",
        args: { name: "jupyterlab" },
      },
      context,
    });
    expect(start.status).toBe("completed");
    expect(calls.appStart).toBe(1);
  });

  test("dry-run avoids side effects", async () => {
    const { context, calls } = createContext();
    const registry = new AgentCapabilityRegistry<AgentSdkContext>();
    registerBasicCapabilities(registry);
    const executor = new AgentExecutor({ registry });

    const write = await executor.execute({
      action: {
        actionType: "project.system.write_text_file",
        args: { path: "x.txt", content: "abc" },
        dryRun: true,
      },
      context,
    });
    expect(write.status).toBe("completed");
    expect(write.result).toEqual({ dryRun: true, path: "x.txt", bytes: 3 });
    expect(calls.writeText).toBe(0);
  });
});
