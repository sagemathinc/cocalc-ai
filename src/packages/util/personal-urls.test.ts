import {
  normalizePersonalUrlOwner,
  projectLocation,
  parsePersonalUrl,
  personalUrlPath,
} from "./personal-urls";

const uuid = "22222222-2222-4222-8222-222222222222";
test("qualified paths support usernames and stable UUIDs", () => {
  expect(personalUrlPath("William", "agents", "agent-16")).toBe(
    "/u/william/agents/agent-16",
  );
  expect(personalUrlPath(uuid, "artifacts", "primes")).toBe(
    `/u/${uuid}/artifacts/primes`,
  );
  expect(
    parsePersonalUrl(
      "https://example.test/u/William/chats/chat1?anything=1#anchor",
    ),
  ).toEqual({ owner: "william", kind: "chats", alias: "chat1" });
  expect(parsePersonalUrl(`/u/${uuid}/artifacts`)).toEqual({
    owner: uuid,
    kind: "artifacts",
  });
});
test("project links may continue into the project", () => {
  expect(parsePersonalUrl("/u/william/projects/research")).toEqual({
    owner: "william",
    kind: "projects",
    alias: "research",
  });
  expect(
    parsePersonalUrl("/u/william/projects/research/files/a%20b/paper.tex"),
  ).toEqual({
    owner: "william",
    kind: "projects",
    alias: "research",
    rest: "files/a%20b/paper.tex",
  });
  expect(parsePersonalUrl("/u/william/projects/research/files/notes/")).toEqual(
    {
      owner: "william",
      kind: "projects",
      alias: "research",
      rest: "files/notes/",
    },
  );
});
test.each([
  "/artifacts/primes",
  "/u/william/unknown/name",
  "/u/william/agents/a/b",
  "/u/william/artifacts/%2fetc",
  "/u/william/chats/%00",
  "/u/william/projects/research/files/../settings",
  "/u/william/projects/research/files/%00",
  "//other/u/william/chats/chat1",
  "https://user:pass@example.test/u/william/chats/chat1",
  "javascript://example/u/william/chats/chat1",
])("invalid URL %s is rejected", (value) => {
  expect(() => parsePersonalUrl(value)).toThrow();
});
test.each(["../person", "person/slash", "a--b", " admin ", "", "a".repeat(40)])(
  "invalid owner %s is rejected",
  (owner) => {
    expect(() => normalizePersonalUrlOwner(owner)).toThrow();
  },
);

test("project locations decode what a project URL opens", () => {
  expect(projectLocation("files/home/user/a.md")).toEqual({
    kind: "file",
    path: "/home/user/a.md",
  });
  expect(projectLocation("files/home/user/my%20notes/")).toEqual({
    kind: "directory",
    path: "/home/user/my notes",
  });
  expect(projectLocation("files/")).toEqual({ kind: "directory", path: "/" });
  expect(projectLocation("settings")).toEqual({
    kind: "page",
    page: "settings",
  });
  expect(projectLocation(undefined)).toBeUndefined();
});
