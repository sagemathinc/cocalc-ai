import { openArtifact } from "@cocalc/frontend/chat/open-artifact";
import { openSourceArtifact } from "./open-source-artifact";

jest.mock("@cocalc/chat", () => ({
  validateArtifactPublication: (value) => value,
}));
jest.mock("@cocalc/frontend/chat/open-artifact", () => ({
  openArtifact: jest.fn(),
}));

const publication = {
  thread_id: "thread",
  artifact_id: "artifact",
  operation_id: "operation",
};
const result: any = {
  agent: { endpoint: { project_id: "source" }, path: "/source.chat" },
  threadId: "thread",
  hit: { artifact_id: "artifact", operation_id: "operation" },
};
function actions(
  project_id = "source",
  path = "/source.chat",
  rows = [publication],
): any {
  return {
    store: { get: (key) => ({ project_id, path })[key] },
    syncdb: { get: () => rows },
    frameTreeActions: {},
    frameId: "source-frame",
  };
}
beforeEach(() => jest.clearAllMocks());
test("opens in the source workbench without a foreign-source descriptor", () => {
  const source = actions();
  openSourceArtifact(source, result);
  expect(openArtifact).toHaveBeenCalledWith(source, publication);
});
test.each([
  ["other-project", "/source.chat"],
  ["source", "/other.chat"],
])("rejects unrelated workbench %s %s", (project, path) => {
  expect(() => openSourceArtifact(actions(project, path), result)).toThrow(
    "source conversation",
  );
  expect(openArtifact).not.toHaveBeenCalled();
});
test("does not substitute another publication", () => {
  expect(() =>
    openSourceArtifact(actions("source", "/source.chat", []), result),
  ).toThrow("publication is unavailable");
  expect(openArtifact).not.toHaveBeenCalled();
});
