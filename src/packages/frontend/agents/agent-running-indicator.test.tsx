/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import { AgentRunningIndicator } from "./agent-running-indicator";
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

test("one backend query supplies unopened agents in the same project", async () => {
  jest.mocked(webapp_client.conat_client.controlAcp).mockResolvedValue({
    ok: true,
    active_threads: [
      { path: "agents.chat", thread_id: "one", state: "running" },
    ],
  });
  const agent = (thread_id: string) =>
    ({
      name: thread_id,
      endpoint: { project_id: "project" },
      path: "agents.chat",
      thread_id,
    }) as any;
  const view = render(
    <>
      <AgentRunningIndicator agent={agent("one")}>One</AgentRunningIndicator>
      <AgentRunningIndicator agent={agent("two")}>Two</AgentRunningIndicator>
    </>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "@one is running" }),
    ).toBeVisible(),
  );
  expect(screen.queryByRole("status", { name: "@two is running" })).toBeNull();
  expect(webapp_client.conat_client.controlAcp).toHaveBeenCalledTimes(1);
  expect(webapp_client.conat_client.controlAcp).toHaveBeenCalledWith({
    action: "status",
    project_id: "project",
  });
  view.unmount();
});
