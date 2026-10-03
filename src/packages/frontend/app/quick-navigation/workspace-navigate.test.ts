/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const pageActions = { setState: jest.fn(), set_active_tab: jest.fn() };
const openLibrary = jest.fn();
const openAgentsOverview = jest.fn();
const loadTarget = jest.fn();
const requestNewProject = jest.fn();
const requests = {
  newArtifactRequest: { request: jest.fn() },
  newConversationRequest: { request: jest.fn() },
  toggleSidebarRequest: { request: jest.fn() },
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => pageActions },
}));
jest.mock("@cocalc/frontend/logger", () => ({
  getLogger: () => ({ debug: jest.fn(), warn: jest.fn() }),
}));
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: jest.fn(),
}));
jest.mock("@cocalc/frontend/docs/navigation", () => ({}));
jest.mock("@cocalc/frontend/project/page/file-tab", () => ({}));
jest.mock("@cocalc/frontend/project/page/activate-project-tab", () => ({}));
jest.mock("@cocalc/frontend/agents/library-navigation", () => ({
  closedLibraryState: {},
  openLibrary: (...a) => openLibrary(...a),
  openAgentsOverview: (...a) => openAgentsOverview(...a),
}));
jest.mock("@cocalc/frontend/history", () => ({
  load_target: (...a) => loadTarget(...a),
}));
jest.mock("@cocalc/frontend/projects/new-project-request", () => ({
  requestNewProject: (...a) => requestNewProject(...a),
}));
jest.mock("@cocalc/frontend/app/sidebar-search-requests", () => requests);

import { navigate } from "./navigate";

const go = (destination) => navigate(destination, new AbortController().signal);

beforeEach(() => jest.clearAllMocks());

test("workspace pages", async () => {
  await go({ kind: "app-page", page: "all-agents" });
  expect(openAgentsOverview).toHaveBeenCalled();
  await go({ kind: "app-page", page: "library" });
  expect(openLibrary).toHaveBeenCalledWith();
  await go({ kind: "app-page", page: "people" });
  expect(pageActions.set_active_tab).toHaveBeenCalledWith("people", true);
});

test("artifacts, conversations and people open where they live", async () => {
  await go({ kind: "artifact", projectId: "p", entryId: "e" });
  expect(openLibrary).toHaveBeenCalledWith("p", "e");
  await go({ kind: "conversation", projectId: "p", conversationId: "c" });
  expect(pageActions.setState).toHaveBeenLastCalledWith({
    people_route: "conversations/p/c",
  });
  await go({ kind: "person", accountId: "a" });
  expect(pageActions.setState).toHaveBeenLastCalledWith({
    people_route: "collaborators/a",
  });
  expect(pageActions.set_active_tab).toHaveBeenLastCalledWith("people", true);
});

test("actions", async () => {
  await go({ kind: "action", action: "new-agent" });
  expect(loadTarget).toHaveBeenCalledWith("agents/new");
  await go({ kind: "action", action: "new-project" });
  expect(requestNewProject).toHaveBeenCalled();
  expect(pageActions.set_active_tab).toHaveBeenCalledWith("projects", true);
  await go({ kind: "action", action: "new-artifact" });
  expect(requests.newArtifactRequest.request).toHaveBeenCalled();
  await go({ kind: "action", action: "new-conversation" });
  expect(requests.newConversationRequest.request).toHaveBeenCalled();
  await go({ kind: "action", action: "toggle-sidebar" });
  expect(requests.toggleSidebarRequest.request).toHaveBeenCalled();
});
