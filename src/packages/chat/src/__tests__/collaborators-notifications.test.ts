import {
  collaborationMessageMentions,
  extractCollaborationMetadata,
} from "../collaborators";
import { COLLABORATION_ROOM_PATH } from "@cocalc/util/collaborators";

const project_id = "11111111-1111-4111-8111-111111111111";
const room_id = "22222222-2222-4222-8222-222222222222";
const person = "33333333-3333-4333-8333-333333333333";
const atom = `<span class="user-mention" account-id="${person}">Someone</span>`;
const all =
  '<span class="user-mention" account-id="__cocalc_all_project_collaborators__">Everyone</span>';
const source = { project_id, chat_path: COLLABORATION_ROOM_PATH };
const marker = {
  event: "collaborators-room",
  project_id,
  room_id,
  mode: "human",
};
const config = {
  event: "chat-thread-config",
  thread_id: "human",
  agent_kind: "none",
};
const message = {
  event: "chat",
  thread_id: "human",
  message_id: "message",
  sender_id: person,
  date: "2026-01-01",
  history: [{ content: atom }],
};

test("explicit person atoms and mention-all are facts, never expanded recipients", () => {
  for (const text of [atom, atom.replace(/"/g, "'"), atom.replace(/"/g, "")])
    expect(collaborationMessageMentions(text + all)).toEqual({
      mentioned_account_ids: [person],
      mention_all: true,
    });
});
test("plain names, references, code, quoted text and links cannot generate attention", () => {
  for (const text of [
    "@all @Someone",
    `\`${atom}\``,
    `\`\`\`html\n${atom}\n\`\`\``,
    `> ${atom}`,
    `[${atom}](https://example.test)`,
    `<a href="https://example.test">${atom}</a>`,
    atom.replace("user-mention", "agent-mention"),
    atom.replace("user-mention", "collaboration-reference"),
  ])
    expect(collaborationMessageMentions(text)).toEqual({
      mentioned_account_ids: [],
      mention_all: false,
    });
});
test("attribute-looking text inside other attributes and duplicate bindings are not person atoms", () => {
  for (const text of [
    `<span class="user-mention account-id=${person}">Someone</span>`,
    `<span class="user-mention" title=' account-id="${person}"'>Someone</span>`,
    atom.replace("account-id=", `account-id="${person}" account-id=`),
  ])
    expect(collaborationMessageMentions(text).mentioned_account_ids).toEqual(
      [],
    );
});
test("only canonical marked human rooms emit original immutable message facts", () => {
  const edited = {
    ...message,
    history: [{ content: all }, ...message.history],
  };
  const rows = [marker, config, edited];
  const result = extractCollaborationMetadata(rows, source);
  expect(result.notification_messages).toEqual([
    {
      version: 1,
      project_id,
      room_id,
      thread_id: "human",
      message_id: "message",
      actor_account_id: person,
      mentioned_account_ids: [person],
      mention_all: false,
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("Someone");
  expect(
    extractCollaborationMetadata(rows, {
      ...source,
      chat_path: "/home/user/copy.chat",
    }).notification_messages,
  ).toBeUndefined();
  const moved = { ...source, chat_path: "/home/user/renamed-room.chat" };
  expect(
    extractCollaborationMetadata(rows, moved, {
      humanRoomPath: moved.chat_path,
    }).notification_messages,
  ).toEqual(result.notification_messages);
  expect(
    extractCollaborationMetadata([config, edited], source)
      .notification_messages,
  ).toBeUndefined();
  expect(
    extractCollaborationMetadata(
      [marker, { ...config, agent_kind: "acp" }, edited],
      source,
    ).notification_messages,
  ).toEqual([]);
  expect(
    extractCollaborationMetadata(
      [marker, config, { ...edited, generating: true }],
      source,
    ).notification_messages,
  ).toEqual([]);
});
test("parser bounds fail explicitly and duplicate room markers fail closed", () => {
  expect(() =>
    collaborationMessageMentions("x".repeat(128 * 1024 + 1)),
  ).toThrow(/capacity/);
  expect(() =>
    extractCollaborationMetadata([marker, marker, config], source),
  ).toThrow(/identity/);
});
