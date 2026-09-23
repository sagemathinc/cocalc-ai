import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { libraryConversationHit, openLibrary } from "./library-navigation";
import { sourceArtifactPublication } from "./open-source-artifact";
const setState = jest.fn();
const setActiveTab = jest.fn(async () => undefined);
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ setState, set_active_tab: setActiveTab }) },
}));
jest.mock("@cocalc/chat", () => ({
  validateArtifactPublication: (value) => value,
}));
jest.mock("@cocalc/frontend/chat/open-artifact", () => ({
  openArtifact: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

test("Library navigation activates its tab without selecting an agent", async () => {
  await openLibrary();
  expect(setState).toHaveBeenLastCalledWith({
    library_open: true,
    library_project_id: undefined,
    library_entry_id: undefined,
  });
  expect(setActiveTab).toHaveBeenLastCalledWith("agents");
  expect(setState.mock.invocationCallOrder[0]).toBeLessThan(
    setActiveTab.mock.invocationCallOrder[0],
  );
  await openLibrary("11111111-1111-4111-8111-111111111111", "a".repeat(64));
  expect(setState).toHaveBeenLastCalledWith({
    library_open: true,
    library_project_id: "11111111-1111-4111-8111-111111111111",
    library_entry_id: "a".repeat(64),
  });
  expect(setActiveTab).toHaveBeenCalledTimes(2);
  expect(
    setState.mock.calls.every(([change]) => !("active_agent_id" in change)),
  ).toBe(true);
});

test("Library conversation navigation preserves the producing publication", () => {
  const agent = {
    endpoint: { project_id: "project", agent_id: "agent" },
    path: "/source.chat",
    thread_id: "thread",
  } as NamedAgent;
  const publication = {
    thread_id: "thread",
    artifact_id: "artifact",
    operation_id: "publication",
  };
  const result = libraryConversationHit(agent, {
    projectId: "project",
    path: "/source.chat",
    threadId: "thread",
    artifactId: "artifact",
    publicationId: "publication",
  });
  expect(result.agent).toBe(agent);
  expect(result.historical).toBe(false);
  expect(
    sourceArtifactPublication(
      {
        store: {
          get: (key) => ({ project_id: "project", path: agent.path })[key],
        },
        syncdb: { get: () => [publication] },
      } as any,
      result,
    ),
  ).toBe(publication);
});
