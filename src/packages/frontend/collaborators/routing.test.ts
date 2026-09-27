import { collaboratorsTargetPath, parseCollaboratorsRoute } from "./routing";
import { getPageUrlPath, parsePageTarget } from "../page-routing";

test("project and person scopes roundtrip with a stable resource identity", () => {
  const route = {
    view: "conversations" as const,
    projectId: "project-1",
    personId: "person-1",
    resourceKind: "conversation" as const,
    resourceId: "thread-1",
  };
  const path = collaboratorsTargetPath(route);
  expect(parseCollaboratorsRoute(path.split("/").slice(1))).toEqual(route);
  expect(parsePageTarget(path)).toEqual({
    page: "agents",
    collaborators: route,
  });
  expect(getPageUrlPath({ page: "agents", collaborators: route })).toBe(
    `/${path}`,
  );
});

test.each(["people", "projects", "conversations"])(
  "direct %s view needs no project",
  (view) => {
    expect(parseCollaboratorsRoute([view])).toEqual({ view });
  },
);

test("opaque resource identities roundtrip encoded slashes without changing routing", () => {
  const route = {
    view: "conversations" as const,
    projectId: "project-1",
    resourceKind: "artifact" as const,
    resourceId: 'artifact:["thread","folder/item"]',
  };
  const path = collaboratorsTargetPath(route);
  expect(path).toContain("%2F");
  expect(parsePageTarget(path)).toEqual({
    page: "agents",
    collaborators: route,
  });
});

test("root opens conversations and encoded labels do not become path segments", () => {
  expect(parseCollaboratorsRoute([])).toEqual({ view: "conversations" });
  expect(parseCollaboratorsRoute([""])).toEqual({ view: "conversations" });
  expect(parseCollaboratorsRoute(["people", "person", "a%20b"])).toEqual({
    view: "people",
    personId: "a b",
  });
});

test.each([
  ["unexpected"],
  ["conversations", "resource", "conversation", "thread"],
  ["people", "person", ""],
  ["people", "person", "one", "person", "two"],
  ["people", "person", "%2F"],
  ["people", "person", "%"],
  ["conversations", "project", "one", "resource", "unknown", "thread"],
  ["conversations", "project", "one", "extra"],
])("malformed route stays invalid: %j", (...parts) => {
  const route = parseCollaboratorsRoute(parts);
  expect(route.routeError).toBeTruthy();
  expect(collaboratorsTargetPath(route)).toBe("collaborators/invalid");
});
