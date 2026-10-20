import { toolUseTracker } from "../tool-use";

const terminal = (phase: "start" | "data" | "exit", extra = {}) =>
  ({
    type: "event",
    event: { type: "terminal", terminalId: "t1", phase, ...extra },
  }) as any;
const harness = (status: string) =>
  ({
    type: "event",
    event: {
      type: "harness",
      data: { sessionUpdate: "tool_call_update", status },
    },
  }) as any;

function ran(...payloads: any[]): boolean {
  const tracker = toolUseTracker();
  for (const payload of payloads) tracker.observe(payload);
  return tracker.ran;
}

describe("whether a turn ran tools", () => {
  it("a declined command never ran", () => {
    expect(ran(terminal("start"), terminal("exit", { declined: true }))).toBe(
      false,
    );
  });

  it("a command that exits, or prints, ran", () => {
    expect(ran(terminal("start"), terminal("exit"))).toBe(true);
    expect(ran(terminal("data", { chunk: "x" }))).toBe(true);
  });

  it("a command cut off after it was announced may have run", () => {
    expect(ran(terminal("start"))).toBe(true);
  });

  it("a declined command does not hide another that ran", () => {
    expect(
      ran(
        terminal("start"),
        terminal("exit", { declined: true }),
        harness("in_progress"),
      ),
    ).toBe(true);
  });

  it("a permission request alone is not a tool run", () => {
    expect(ran(harness("pending"))).toBe(false);
    expect(ran(harness("failed"))).toBe(true);
    expect(ran({ type: "status", state: "running" } as any)).toBe(false);
  });
});
