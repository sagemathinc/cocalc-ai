import { renderHook } from "@testing-library/react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useWorkspaceRoute } from "./use-workspace-route";
import { set_url } from "@cocalc/frontend/history";

const setState = jest.fn();
jest.mock("@cocalc/frontend/history", () => ({ set_url: jest.fn() }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ setState }),
    getStore: () => ({ get: () => "old-name" }),
  },
}));
const agent = {
  name: "renamed",
  endpoint: { agent_id: "id", project_id: "project" },
} as NamedAgent;
beforeEach(() => jest.clearAllMocks());

test("inactive directory refresh cannot overwrite a project URL; reactivation syncs the name", () => {
  const view = renderHook(
    ({ active, selected }) =>
      useWorkspaceRoute({ active, selected, activeAgentId: "id" }),
    {
      initialProps: { active: false, selected: agent },
    },
  );
  view.rerender({ active: false, selected: { ...agent, name: "new-name" } });
  expect(set_url).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
  view.rerender({ active: true, selected: { ...agent, name: "new-name" } });
  expect(set_url).toHaveBeenCalledWith(expect.stringContaining("new-name"));
});
