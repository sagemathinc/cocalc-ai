import { extractCollaborationMetadata } from "../collaborators";
import { planChatIdentityMigration } from "@cocalc/util/collaboration-chat-identity";

const creator = "11111111-1111-4111-8111-111111111111";
const author = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const source = { project_id: creator, chat_path: "/home/user/room.chat" };
const first = {
  event: "chat",
  thread_id: "thread",
  message_id: "a",
  date: "2026-09-26T00:00:00.000Z",
  sender_id: creator,
};
const latest = {
  ...first,
  message_id: "b",
  date: "2026-09-27T00:00:00.000Z",
  sender_id: author.toUpperCase(),
};
const config = {
  event: "chat-thread-config",
  thread_id: "thread",
  agent_kind: "none",
  name: "Discussion",
};
const metadata = [
  config,
  { event: "chat-thread", thread_id: "thread", created_by: creator },
];
const extract = (rows: unknown[]) =>
  extractCollaborationMetadata(rows, source).resources[0];

test("latest message sender is distinct from creator and subsequent message/config editors", () => {
  const before = extract([...metadata, first, latest]);
  const after = extract([
    ...metadata.slice(1),
    {
      ...config,
      name: "Renamed",
      updated_by: creator,
      updated_at: "2026-10-01",
    },
    {
      ...latest,
      history: [{ author_id: creator, date: "2026-10-02", content: "edited" }],
    },
    {
      ...first,
      history: [
        { author_id: creator, date: "2026-10-03", content: "edited later" },
      ],
    },
  ]);
  expect(before).toMatchObject({
    created_by: creator,
    latest_message_author_id: author,
  });
  expect(after).toMatchObject({
    created_by: creator,
    latest_message_author_id: author,
    updated_at: before.updated_at,
  });
});

test("equal message timestamps use stable message identity rather than row order", () => {
  const a = { ...first, date: latest.date };
  expect(extract([a, latest]).latest_message_author_id).toBe(author);
  expect(extract([latest, a]).latest_message_author_id).toBe(author);
});

test.each([undefined, "assistant", "legacy-unknown"])(
  "unknown latest sender %s never falls back to creator, previous sender or editor",
  (sender_id) => {
    expect(
      extract([
        ...metadata,
        first,
        { ...latest, sender_id, history: [{ author_id: author }] },
      ]),
    ).not.toHaveProperty("latest_message_author_id");
  },
);

test("archive timestamp without its message does not attribute an older head sender", () => {
  const archived = {
    ...config,
    archived_chat_rows: 1,
    latest_chat_date_ms: Date.parse(latest.date),
  };
  expect(extract([archived, first])).not.toHaveProperty(
    "latest_message_author_id",
  );
  expect(extract([archived])).not.toHaveProperty("latest_message_author_id");
  expect(extract([archived, first, latest])).toMatchObject({
    latest_message_author_id: author,
  });
});

test("merged archived legacy rows use the same persisted identity projection and actual sender", () => {
  const root = { event: "chat", date: first.date, sender_id: creator };
  const reply = {
    event: "chat",
    date: latest.date,
    sender_id: author,
    reply_to: first.date,
  };
  const markers = planChatIdentityMigration([root, reply], {
    migration_id: creator,
    history_complete: true,
  });
  expect(extract([...markers, root, reply])).toMatchObject({
    latest_message_author_id: author,
  });
  expect(root).not.toHaveProperty("message_id");
  expect(reply).not.toHaveProperty("message_id");
});

test("complete relation extraction does not guess an author from a stale archive timestamp", () => {
  const result = extractCollaborationMetadata(
    [
      {
        ...config,
        archived_chat_rows: 1,
        latest_chat_date_ms: Date.parse(latest.date),
      },
      first,
    ],
    source,
    { relationsComplete: true },
  );
  expect(result.resources[0]).not.toHaveProperty("latest_message_author_id");
});

test("agent resources and message-free conversations have no latest human message attribution", () => {
  expect(
    extract([{ ...config, agent_kind: "acp" }, latest]),
  ).not.toHaveProperty("latest_message_author_id");
  expect(extract(metadata)).not.toHaveProperty("latest_message_author_id");
});
