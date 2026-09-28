import { collaboratorsTargetPath, parseCollaboratorsRoute } from "./routing";
import { getPageUrlPath, parsePageTarget } from "../page-routing";

test.each(["chats", "people"])(
  "clean %s aliases roundtrip without becoming stable IDs",
  (kind) => {
    const parsed = parsePageTarget(`${kind}/Alice-2`);
    expect(parsed).toEqual({
      page: "agents",
      collaborators: {
        view: kind === "people" ? "people" : "conversations",
        aliasKind: kind,
        alias: "alice-2",
      },
    });
    expect(getPageUrlPath(parsed)).toBe(`/${kind}/alice-2`);
  },
);
test.each([
  "chats/a/b",
  "people/%2f",
  "people/%",
  "chats//alice",
  "people/..",
  "people/a%20b",
])("invalid private URL fails closed: %s", (target) => {
  const parsed = parsePageTarget(target);
  expect(parsed).toMatchObject({
    page: "agents",
    collaborators: { routeError: expect.any(String) },
  });
});

test("project and person scopes roundtrip with a stable resource identity", () => {
  const route = {
    view: "conversations" as const,
    projectId: "project-1",
    projectIds: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
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
