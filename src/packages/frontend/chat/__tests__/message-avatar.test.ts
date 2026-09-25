import { showParticipantAvatar } from "../message-avatar";

const base = {
  showAvatar: true,
  senderId: "another-person",
  viewerAccountId: "me",
  isAgent: false,
};

test("only another human gets a message avatar", () => {
  expect(showParticipantAvatar(base)).toBe(true);
  expect(showParticipantAvatar({ ...base, senderId: "me" })).toBe(false);
  expect(showParticipantAvatar({ ...base, isAgent: true })).toBe(false);
  expect(showParticipantAvatar({ ...base, senderId: undefined })).toBe(false);
  expect(showParticipantAvatar({ ...base, showAvatar: false })).toBe(false);
});
