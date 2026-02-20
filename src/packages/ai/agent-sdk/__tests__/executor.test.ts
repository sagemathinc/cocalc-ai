import { AgentCapabilityRegistry } from "../capabilities";
import { AgentExecutor } from "../executor";
import { InMemoryIdempotencyStore } from "../memory";

describe("AgentExecutor", () => {
  test("executes read action without confirmation", async () => {
    const registry = new AgentCapabilityRegistry<void>();
    registry.register({
      actionType: "workspace.list",
      summary: "List workspaces",
      riskLevel: "read",
      handler: async () => ["a", "b"],
    });

    const executor = new AgentExecutor({ registry });
    const result = await executor.execute({
      action: { actionType: "workspace.list", args: {} },
      context: undefined,
    });

    expect(result.status).toBe("completed");
    expect(result.result).toEqual(["a", "b"]);
  });

  test("blocks destructive action without confirmation", async () => {
    const registry = new AgentCapabilityRegistry<void>();
    registry.register({
      actionType: "workspace.delete",
      summary: "Delete a workspace",
      riskLevel: "destructive",
      handler: async () => ({ deleted: true }),
    });

    const executor = new AgentExecutor({ registry });
    const blocked = await executor.execute({
      action: { actionType: "workspace.delete", args: { id: "w1" } },
      context: undefined,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.requiresConfirmation).toBe(true);

    const confirmed = await executor.execute({
      action: { actionType: "workspace.delete", args: { id: "w1" } },
      context: undefined,
      confirmationToken: "ok",
    });
    expect(confirmed.status).toBe("completed");
    expect(confirmed.result).toEqual({ deleted: true });
  });

  test("fails on invalid args", async () => {
    const registry = new AgentCapabilityRegistry<void>();
    registry.register({
      actionType: "workspace.rename",
      summary: "Rename a workspace",
      validateArgs: (args: unknown) => {
        if (
          typeof args === "object" &&
          args != null &&
          typeof (args as { name?: unknown }).name === "string"
        ) {
          return args as { name: string };
        }
        throw new Error("name must be a string");
      },
      handler: async (args) => ({ name: args.name }),
    });

    const executor = new AgentExecutor({ registry });
    const result = await executor.execute({
      action: { actionType: "workspace.rename", args: { name: 5 } },
      context: undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid arguments");
  });

  test("returns cached idempotent result", async () => {
    const registry = new AgentCapabilityRegistry<void>();
    let calls = 0;
    registry.register({
      actionType: "workspace.create",
      summary: "Create workspace",
      handler: async () => {
        calls += 1;
        return { call: calls };
      },
    });

    const idempotencyStore = new InMemoryIdempotencyStore();
    const executor = new AgentExecutor({ registry, idempotencyStore });

    const action = {
      actionType: "workspace.create",
      args: { name: "x" },
      idempotencyKey: "same-key",
    };
    const first = await executor.execute({ action, context: undefined });
    const second = await executor.execute({ action, context: undefined });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first.result).toEqual({ call: 1 });
    expect(second.result).toEqual({ call: 1 });
    expect(second.idempotentReplay).toBe(true);
    expect(calls).toBe(1);
  });
});

