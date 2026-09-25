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

it.each([true, false, undefined])(
  "opens Agents regardless of the retired preference (%s)",
  async (value) => {
    mockAccount = mockAccount.set(
      "other_settings",
      Map({ experimental_my_agents_page: value }),
    );
    await signInAction();
    expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
    expect(mockOpenProject).not.toHaveBeenCalled();
    expect(mockStartProject).not.toHaveBeenCalled();
  },
);

it("opens Agents for accounts without saved preferences", async () => {
  await signInAction();
  expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
  expect(mockOpenProject).not.toHaveBeenCalled();
  expect(mockStartProject).not.toHaveBeenCalled();
});

it("does nothing without the post-sign-in query marker", async () => {
  mockGetQuery.mockReturnValue(undefined);
  await signInAction();
  expect(mockRemoveQuery).not.toHaveBeenCalled();
  expect(mockSetActiveTab).not.toHaveBeenCalled();
  expect(mockOpenProject).not.toHaveBeenCalled();
});
