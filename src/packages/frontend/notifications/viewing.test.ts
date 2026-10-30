/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  chatViewKey,
  directViewKey,
  isAboutShownConversation,
  resetShownConversationsForTests,
  showingConversation,
} from "./viewing";

let focus: jest.SpyInstance;
beforeEach(() => {
  resetShownConversationsForTests();
  focus = jest.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => focus.mockRestore());

const dm = (conversation_id: string) => ({
  summary: { notice_type: "direct_message", conversation_id },
});

test("a chat's key is the same for a relative and an absolute path", () => {
  expect(chatViewKey("p", "team.chat")).toBe(
    chatViewKey("p", "/home/user/team.chat"),
  );
  expect(chatViewKey("p", "team.chat")).not.toBe(chatViewKey("q", "team.chat"));
});

test("shown while registered, by every view; counted", () => {
  const first = showingConversation(directViewKey("c"));
  const second = showingConversation(directViewKey("c"));
  expect(isAboutShownConversation(dm("c"))).toBe(true);
  first();
  first(); // twice is harmless
  expect(isAboutShownConversation(dm("c"))).toBe(true);
  second();
  expect(isAboutShownConversation(dm("c"))).toBe(false);
});

test("only when the person is looking, and only that conversation", () => {
  const stop = showingConversation(chatViewKey("p", "a.chat"));
  const chat = (path: string, project_id = "p") => ({
    project_id,
    summary: { path },
  });
  expect(isAboutShownConversation(chat("/home/user/a.chat"))).toBe(true);
  expect(isAboutShownConversation(chat("/home/user/b.chat"))).toBe(false);
  expect(isAboutShownConversation(chat("/home/user/a.chat", "q"))).toBe(false);
  expect(isAboutShownConversation(dm("x"))).toBe(false);
  focus.mockReturnValue(false);
  expect(isAboutShownConversation(chat("/home/user/a.chat"))).toBe(false);
  stop();
});
