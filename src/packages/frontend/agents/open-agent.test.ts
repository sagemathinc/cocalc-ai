import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { openAgentThread } from "./open-agent";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getProjectActions: jest.fn() },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(),
}));

const target = {
  project_id: "project",
  path: "/home/user/review.chat",
  thread_id: "review-thread",
};

beforeEach(() => jest.resetAllMocks());

test("loads the project runtime before navigating to the exact file and thread", async () => {
  const open_file = jest.fn().mockResolvedValue(undefined);
  jest.mocked(redux.getProjectActions).mockImplementation(() => {
    expect(ensureProjectReduxRuntime).toHaveBeenCalledTimes(1);
    return { open_file } as any;
  });
  await openAgentThread(target);
  expect(redux.getProjectActions).toHaveBeenCalledWith("project");
  expect(open_file).toHaveBeenCalledWith({
    path: target.path,
    foreground: true,
    foreground_project: true,
    fragmentId: { thread: target.thread_id },
  });
});

test("reports navigation failures rather than silently reloading", async () => {
  jest
    .mocked(ensureProjectReduxRuntime)
    .mockRejectedValue(new Error("Offline"));
  await expect(openAgentThread(target)).rejects.toThrow("Offline");
  expect(redux.getProjectActions).not.toHaveBeenCalled();
});
