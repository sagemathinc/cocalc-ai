import { act, renderHook } from "@testing-library/react";
import { useWorkspaceSelectedThread } from "./use-workspace-selected-thread";

test("switching agents in the same workspace immediately selects the new thread", () => {
  const { result, rerender } = renderHook(
    ({ agentId, threadId }) => useWorkspaceSelectedThread(agentId, threadId),
    { initialProps: { agentId: "agent-1", threadId: "thread-1" } },
  );
  act(() => result.current[1]("unregistered-thread"));
  expect(result.current[0]).toBe("unregistered-thread");

  rerender({ agentId: "agent-2", threadId: "thread-2" });
  expect(result.current[0]).toBe("thread-2");

  act(() => result.current[1]("another-thread"));
  expect(result.current[0]).toBe("another-thread");

  rerender({ agentId: "agent-2", threadId: "fresh-thread" });
  expect(result.current[0]).toBe("fresh-thread");

  rerender({ agentId: "agent-1", threadId: "thread-1" });
  expect(result.current[0]).toBe("thread-1");
});
