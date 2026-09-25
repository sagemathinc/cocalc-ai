import { act, render, screen, waitFor } from "@testing-library/react";
import { AgentRunningIndicator } from "./agent-running-indicator";
import { resultKey, setUnseenResult } from "./unseen-result";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account",
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: { controlAcp: jest.fn() } },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }) => children,
}));

test("unseen completion remains accessible after running ends and disappears on acknowledgement", async () => {
  const agent = {
    name: "reviewer",
    endpoint: { project_id: "p" },
    path: "a.chat",
    thread_id: "t",
  } as any;
  const key = resultKey("account", "p", "a.chat", "t");
  jest.mocked(webapp_client.conat_client.controlAcp).mockResolvedValue({
    ok: true,
    active_threads: [{ path: "a.chat", thread_id: "t", state: "running" }],
  });
  const { rerender } = render(
    <AgentRunningIndicator agent={agent}>Avatar</AgentRunningIndicator>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "@reviewer is running" }),
    ).toBeTruthy(),
  );
  act(() => setUnseenResult(key, true));
  jest.mocked(webapp_client.conat_client.controlAcp).mockResolvedValue({
    ok: true,
    active_threads: [],
  });
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() =>
    expect(
      screen.queryByRole("status", { name: "@reviewer is running" }),
    ).toBeNull(),
  );
  rerender(<AgentRunningIndicator agent={agent}>Avatar</AgentRunningIndicator>);
  expect(
    screen.getByRole("status", { name: "@reviewer has an unseen result" }),
  ).toBeTruthy();
  act(() => setUnseenResult(key, false));
  expect(screen.queryByRole("status")).toBeNull();
});
