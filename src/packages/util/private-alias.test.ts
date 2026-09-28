import {
  normalizePrivateAlias,
  personAliases,
  privateAliasPath,
} from "./private-alias";

const person = "11111111-1111-4111-8111-111111111111";
test("private names normalize to a single clean path segment", () => {
  expect(normalizePrivateAlias("  Alice-2 ")).toBe("alice-2");
  expect(privateAliasPath("people", "Alice-2")).toBe("/people/alice-2");
  expect(privateAliasPath("chats", "review")).toBe("/chats/review");
});
test.each([
  "",
  "a/b",
  "..",
  "a%2fb",
  "a b",
  "-alice",
  "a-",
  "é",
  "a".repeat(33),
])("rejects invalid alias %s", (alias) => {
  expect(() => normalizePrivateAlias(alias)).toThrow();
});
test("settings validation rejects malformed identities and ambiguous names", () => {
  expect(personAliases({ [person]: "alice" })).toEqual({ [person]: "alice" });
  expect(() => personAliases({ bad: "alice" })).toThrow();
  expect(() => personAliases({ [person]: "Alice" })).toThrow();
  expect(() =>
    personAliases({
      [person]: "alice",
      "22222222-2222-4222-8222-222222222222": "alice",
    }),
  ).toThrow("Ambiguous");
});
