import { acpTestInternals, setAgentMemoryContextProvider } from "../index";

const { loadAgentMemoryContext } = acpTestInternals;
const PROJECT = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";

afterEach(() => {
  setAgentMemoryContextProvider(undefined);
  jest.useRealTimers();
});

describe("loadAgentMemoryContext", () => {
  it("returns the index and a loaded event when memory is on", async () => {
    setAgentMemoryContextProvider(async () => ({
      notes: 2,
      index: "build-steps: how to build\nprefers-drafts: open PRs as drafts",
    }));
    const memory = await loadAgentMemoryContext(PROJECT, ACCOUNT);
    expect(memory.context).toContain("[Agent memory]");
    expect(memory.context).toContain("project chat memory list");
    expect(memory.context).toContain("prefers-drafts: open PRs as drafts");
    expect(memory.event).toEqual({ type: "memory", state: "loaded", notes: 2 });
  });

  it("is silent when memory is unavailable (no answer)", async () => {
    setAgentMemoryContextProvider(async () => null);
    expect(await loadAgentMemoryContext(PROJECT, ACCOUNT)).toEqual({});
  });

  it("hints that memory exists when it is off, without a Memory line", async () => {
    setAgentMemoryContextProvider(async () => ({
      notes: 0,
      index: "",
      off: true,
    }));
    const memory = await loadAgentMemoryContext(PROJECT, ACCOUNT);
    expect(memory.event).toBeUndefined();
    expect(memory.context).toContain("[Agent memory]");
    expect(memory.context).toContain("Agent memory is off");
    expect(memory.context).toContain("tell them once");
    expect(memory.context).toContain("Settings > AI");
    // No notes and no memory commands: nothing to read or write while off.
    expect(memory.context).not.toContain("project chat memory list");
  });

  it("reports a failed lookup instead of dropping it silently", async () => {
    setAgentMemoryContextProvider(async () => {
      throw new Error("hub unreachable");
    });
    expect(await loadAgentMemoryContext(PROJECT, ACCOUNT)).toEqual({
      event: { type: "memory", state: "unavailable" },
    });
  });

  it("reports a lookup that times out", async () => {
    jest.useFakeTimers();
    setAgentMemoryContextProvider(() => new Promise(() => {}));
    const pending = loadAgentMemoryContext(PROJECT, ACCOUNT);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({
      event: { type: "memory", state: "unavailable" },
    });
  });
});
