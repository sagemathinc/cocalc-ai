import { RetainedWorkspaceNavigation } from "./retained-workspace-navigation";

test("reveals the latest exact view without confusing older URLs or runtimes", () => {
  const navigation = new RetainedWorkspaceNavigation();
  const project = {};
  const runtime = () => project;
  navigation.remember("project", "/projects/p/search#query", "alice", project);
  expect(navigation.find("/projects/p/search#query", "alice", runtime)).toBe(
    "project",
  );
  expect(
    navigation.find("/projects/p/search#other", "alice", runtime),
  ).toBeUndefined();
  navigation.remember("project", "/projects/p/settings", "alice", project);
  expect(
    navigation.find("/projects/p/search#query", "alice", runtime),
  ).toBeUndefined();
  expect(
    navigation.find("/projects/p/settings", "alice", () => ({})),
  ).toBeUndefined();
});

test("closed projects and account switches invalidate retained views", () => {
  const navigation = new RetainedWorkspaceNavigation();
  const project = {};
  navigation.remember("p", "/projects/p/files/", "alice", project);
  expect(
    navigation.find("/projects/p/files/", "alice", () => undefined),
  ).toBeUndefined();
  navigation.remember("projects", "/projects", "alice", project);
  expect(navigation.find("/projects", "bob", () => project)).toBeUndefined();
});

test("sidebar resumes the most recently visited project or list", () => {
  const navigation = new RetainedWorkspaceNavigation();
  const runtime = {};
  navigation.remember("p", "/projects/p/files/a", "alice", runtime);
  navigation.remember("projects", "/projects", "alice", runtime);
  expect(navigation.latest("alice", () => runtime)?.tab).toBe("projects");
  navigation.remember("p", "/projects/p/search", "alice", runtime);
  expect(navigation.latest("alice", () => runtime)).toEqual({
    tab: "p",
    url: "/projects/p/search",
  });
  expect(navigation.latest("alice", () => undefined)).toBeUndefined();
});
