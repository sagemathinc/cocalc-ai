import { Map } from "immutable";

const mockGetQuery = jest.fn();
const mockRemoveQuery = jest.fn();
const mockSetActiveTab = jest.fn();
const mockOpenProject = jest.fn();
const mockStartProject = jest.fn(async () => {});
let mockAccount: Map<string, any>;
let mockProjects: Map<string, any>;

jest.mock("awaiting", () => ({ delay: async () => {} }));
jest.mock("@cocalc/frontend/misc/query-params", () => ({
  QueryParams: { get: mockGetQuery, remove: mockRemoveQuery },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) =>
      name === "account" ? mockAccount : mockProjects,
    getActions: (name: string) =>
      name === "page"
        ? { set_active_tab: mockSetActiveTab }
        : { open_project: mockOpenProject, start_project: mockStartProject },
  },
}));

import signInAction from "./sign-in-action";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetQuery.mockReturnValue("1");
  mockAccount = Map({
    account_id: "account",
    created: new Date(),
    other_settings: Map(),
  });
  mockProjects = Map({
    project_map: Map({
      project: Map({
        project_id: "project",
        last_edited: new Date(),
        users: Map({ account: Map() }),
      }),
    }),
  });
});

it("opens My Agents after sign-in when the account opted in", async () => {
  mockAccount = mockAccount.set(
    "other_settings",
    Map({ experimental_my_agents_page: true }),
  );
  await signInAction();
  expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
  expect(mockOpenProject).not.toHaveBeenCalled();
  expect(mockStartProject).not.toHaveBeenCalled();
});

it("preserves the existing recent-project landing when not opted in", async () => {
  await signInAction();
  expect(mockOpenProject).toHaveBeenCalledWith({
    project_id: "project",
    switch_to: true,
    target: "new",
  });
  expect(mockStartProject).toHaveBeenCalledWith("project", {
    autostart: true,
  });
});

it("does nothing without the post-sign-in query marker", async () => {
  mockGetQuery.mockReturnValue(undefined);
  await signInAction();
  expect(mockRemoveQuery).not.toHaveBeenCalled();
  expect(mockSetActiveTab).not.toHaveBeenCalled();
  expect(mockOpenProject).not.toHaveBeenCalled();
});
