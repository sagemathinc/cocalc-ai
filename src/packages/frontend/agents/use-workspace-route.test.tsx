import { renderHook } from "@testing-library/react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useWorkspaceRoute } from "./use-workspace-route";
import { replace_url } from "@cocalc/frontend/history";

const setState = jest.fn();
let personalUrl: string | undefined;
jest.mock("@cocalc/frontend/history", () => ({ replace_url: jest.fn() }));
jest.mock("@cocalc/frontend/personal-url-owner", () => ({
  usePersonalUrlOwner: () => "alice",
}));
jest.mock("@cocalc/frontend/personal-url-navigation", () => ({
  resolvePersonalUrl: jest.fn(),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ setState }),
    getStore: () => ({
      get: (key) => (key === "personal_url" ? personalUrl : "old-name"),
    }),
  },
}));
const agent = {
  name: "renamed",
  endpoint: { agent_id: "id", project_id: "project" },
} as NamedAgent;
beforeEach(() => {
  jest.clearAllMocks();
  personalUrl = undefined;
});

test("inactive directory refresh cannot overwrite a project URL; reactivation syncs the name", () => {
  const view = renderHook(
    ({ active, selected }) =>
      useWorkspaceRoute({ active, selected, activeAgentId: "id" }),
    {
      initialProps: { active: false, selected: agent },
    },
  );
  view.rerender({ active: false, selected: { ...agent, name: "new-name" } });
  expect(replace_url).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
  view.rerender({ active: true, selected: { ...agent, name: "new-name" } });
  expect(replace_url).toHaveBeenCalledWith("/u/alice/agents/new-name");
});

test("a qualified foreign-owner URL cannot be rewritten by a matching viewer agent", () => {
  personalUrl = "u/bob/agents/renamed";
  renderHook(() =>
    useWorkspaceRoute({ active: true, selected: agent, activeAgentId: "id" }),
  );
  expect(replace_url).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
});
