import { normalizeConversationPath } from "./people";

test.each([
  "notes/team.chat",
  "~/notes/team.chat",
  "~//notes//team.chat",
  "/home/user/notes/team.chat",
  "~/notes/../notes/team.chat",
])("canonical conversation path: %s", (path) => {
  expect(normalizeConversationPath(path)).toBe("/home/user/notes/team.chat");
});

test("absolute paths remain absolute", () => {
  expect(normalizeConversationPath("/notes/team.chat")).toBe(
    "/notes/team.chat",
  );
});

test.each(["~", "~/", "~/notes.md", "~/.chat", ""])(
  "rejects non-chat path: %s",
  (path) => expect(() => normalizeConversationPath(path)).toThrow(),
);
