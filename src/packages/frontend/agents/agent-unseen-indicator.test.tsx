import { act, render, screen } from "@testing-library/react";
import { AgentRunningIndicator } from "./agent-running-indicator";
import { resultKey, setUnseenResult } from "./unseen-result";

let state = "complete";
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account",
  useEditorRedux: () => () => ({ get: () => state }),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }) => children,
}));

test("unseen completion remains accessible after running ends and disappears on acknowledgement", () => {
  const agent = {
    name: "reviewer",
    endpoint: { project_id: "p" },
    path: "a.chat",
    thread_id: "t",
  } as any;
  const key = resultKey("account", "p", "a.chat", "t");
  state = "running";
  const { rerender } = render(
    <AgentRunningIndicator agent={agent}>Avatar</AgentRunningIndicator>,
  );
  expect(
    screen.getByRole("status", { name: "@reviewer is running" }),
  ).toBeTruthy();
  act(() => setUnseenResult(key, true));
  state = "complete";
  rerender(<AgentRunningIndicator agent={agent}>Avatar</AgentRunningIndicator>);
  expect(
    screen.getByRole("status", { name: "@reviewer has an unseen result" }),
  ).toBeTruthy();
  act(() => setUnseenResult(key, false));
  expect(screen.queryByRole("status")).toBeNull();
});
