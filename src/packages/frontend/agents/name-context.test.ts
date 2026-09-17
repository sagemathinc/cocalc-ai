import { fromJS } from "immutable";
import { cachedAgentNameContext } from "./name-context";

const mockGetStore = jest.fn();
const mockGetActions = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (...args) => mockGetStore(...args),
    getActions: (...args) => mockGetActions(...args),
  },
  redux_name: (project, path) => `${project}:${path}`,
}));

beforeEach(() => jest.resetAllMocks());

test("snapshots project projection and the exact already-open thread metadata", () => {
  const projects = fromJS({ project_map: { p: { title: "Build project" } } });
  mockGetStore.mockReturnValue(projects);
  const metadata = jest.fn(() => ({ name: "Build the PR" }));
  mockGetActions.mockReturnValue({ getThreadMetadata: metadata });
  expect(
    cachedAgentNameContext({
      project_id: "p",
      path: "/a.chat",
      thread_id: "t",
    }),
  ).toEqual({
    project_title: "Build project",
    thread_title: "Build the PR",
  });
  expect(mockGetActions).toHaveBeenCalledWith("p:/a.chat");
  expect(metadata).toHaveBeenCalledWith("t", { threadId: "t" });
});

test("does not open missing chats or invent titles from ids or paths", () => {
  expect(
    cachedAgentNameContext({
      project_id: "p",
      path: "/closed.chat",
      thread_id: "t",
    }),
  ).toEqual({});
  expect(mockGetStore).toHaveBeenCalledWith("projects");
  expect(mockGetActions).toHaveBeenCalledTimes(1);
});

test("an explicit composer title takes precedence without consulting chat state", () => {
  expect(
    cachedAgentNameContext({
      project_id: "p",
      path: "/a.chat",
      thread_id: "t",
      thread_title: "Visible thread",
    }),
  ).toEqual({ thread_title: "Visible thread" });
  expect(mockGetActions).not.toHaveBeenCalled();
});
