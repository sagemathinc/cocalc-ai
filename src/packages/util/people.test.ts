import {
  isConversationStoragePath,
  newConversationPath,
  normalizeConversationPath,
} from "./people";

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

describe("conversation storage", () => {
  it("puts new conversations in the XDG data directory", () => {
    expect(newConversationPath("/home/user", "abc")).toBe(
      "/home/user/.local/share/cocalc/conversations/abc.chat",
    );
  });

  it("recognizes conversation files in the current and the old location", () => {
    expect(
      isConversationStoragePath(
        "/home/user/.local/share/cocalc/conversations/abc.chat",
      ),
    ).toBe(true);
    expect(
      isConversationStoragePath(".local/share/cocalc/conversations/abc.chat"),
    ).toBe(true);
    expect(isConversationStoragePath(".cocalc/conversations/abc.chat")).toBe(
      true,
    );
    expect(isConversationStoragePath("notes/conversations/abc.chat")).toBe(
      false,
    );
    expect(isConversationStoragePath("team.chat")).toBe(false);
  });
});
