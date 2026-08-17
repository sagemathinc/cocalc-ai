import {
  essentialRouteUrl,
  normalizeProjectPath,
  parseRoute,
  parseEssentialRoute,
  routeHash,
} from "./routes";

const projectId = "af027aca-e308-41c2-b528-a3e73de50996";

test("parses and serializes file routes", () => {
  const route = {
    kind: "file" as const,
    projectId,
    path: "/home/user/a b.ipynb",
  };
  expect(parseRoute(routeHash(route))).toEqual(route);
});

test("parses and serializes Codex routes", () => {
  const route = {
    kind: "chat" as const,
    projectId,
    chatPath: "/home/user/a.chat",
    threadId: "thread-1",
  };
  expect(parseRoute(routeHash(route))).toEqual(route);
});

test.each([
  "agents",
  "apps",
  "cli",
  "notebooks",
  "recent",
  "settings",
  "terminal",
  "vms",
] as const)("parses and serializes the %s project surface", (kind) => {
  const route = { kind, projectId };
  expect(parseRoute(routeHash(route))).toEqual(route);
});

test("parses and serializes account notifications", () => {
  const route = { kind: "notifications" as const };
  expect(parseRoute(routeHash(route))).toEqual(route);
});

test("opens a bare project route at its home directory", () => {
  expect(parseRoute(`#/project/${projectId}`)).toEqual({
    kind: "files",
    projectId,
    path: "/home/user",
  });
});

test("keeps ultralite file paths inside the project home", () => {
  expect(normalizeProjectPath("/home/user/a/../b")).toBe("/home/user/b");
  expect(normalizeProjectPath("/home/user/../../etc/passwd")).toBe(
    "/home/user",
  );
  expect(normalizeProjectPath("/etc/passwd")).toBe("/home/user");
});

test("rejects malformed project hashes", () => {
  expect(parseRoute("#/project/not-a-project/files?path=/home/user")).toEqual({
    kind: "projects",
  });
});

test("uses clean Essential URLs for files and directories", () => {
  expect(
    essentialRouteUrl(
      { kind: "file", projectId, path: "/home/user/a b/main.go" },
      "/cocalc",
    ),
  ).toBe(
    `/cocalc/essential/projects/${projectId}/files/home/user/a%20b/main.go`,
  );
  expect(
    essentialRouteUrl(
      { kind: "files", projectId, path: "/home/user/a b" },
      "/cocalc",
    ),
  ).toBe(`/cocalc/essential/projects/${projectId}/files/home/user/a%20b/`);
});

test("parses clean Essential routes and distinguishes trailing directories", () => {
  expect(
    parseEssentialRoute({
      pathname: `/essential/projects/${projectId}/files/home/user/main.go`,
    }),
  ).toEqual({ kind: "file", projectId, path: "/home/user/main.go" });
  expect(
    parseEssentialRoute({
      pathname: `/cocalc/essential/projects/${projectId}/files/home/user/src/`,
    }),
  ).toEqual({ kind: "files", projectId, path: "/home/user/src" });
});

test.each([
  ["codex", "agents"],
  ["jupyter", "notebooks"],
  ["terminal", "terminal"],
  ["vms", "vms"],
  ["apps", "apps"],
  ["cli", "cli"],
  ["settings", "settings"],
] as const)("parses the clean %s route", (surface, kind) => {
  expect(
    parseEssentialRoute({
      pathname: `/essential/projects/${projectId}/${surface}`,
    }),
  ).toEqual({ kind, projectId });
});

test("parses a clean Codex thread route", () => {
  const search = new URLSearchParams({
    path: "/home/user/a.chat",
    thread: "thread-1",
  }).toString();
  expect(
    parseEssentialRoute({
      pathname: `/essential/projects/${projectId}/codex/chat`,
      search: `?${search}`,
    }),
  ).toEqual({
    kind: "chat",
    projectId,
    chatPath: "/home/user/a.chat",
    threadId: "thread-1",
  });
});
