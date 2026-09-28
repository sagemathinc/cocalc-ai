import {
  normalizePersonalUrlOwner,
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
test.each([
  "/artifacts/primes",
  "/u/william/unknown/name",
  "/u/william/agents/a/b",
  "/u/william/artifacts/%2fetc",
  "/u/william/chats/%00",
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
