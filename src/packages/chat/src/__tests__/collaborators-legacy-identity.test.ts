import { extractCollaborationMetadata } from "../collaborators";
import {
  planChatIdentityMigration,
  resolveChatIdentityRows,
} from "@cocalc/util/collaboration-chat-identity";
const operation = "11111111-1111-4111-8111-111111111111";
const source = { project_id: operation, chat_path: "/home/user/old.chat" };
const root = {
  event: "chat",
  date: "2026-09-27T00:00:00.000Z",
  sender_id: operation,
  history: [],
};
const reply = {
  ...root,
  date: "2026-09-27T00:00:00.001Z",
  reply_to: root.date,
};
const markers = (rows: any[]) =>
  planChatIdentityMigration(rows, {
    migration_id: operation,
    history_complete: true,
  });

test("legacy extraction agrees with resolver across rename and keeps copies isolated", () => {
  const rows = [root, reply];
  const saved = [...rows, ...markers(rows)];
  const thread = resolveChatIdentityRows(saved).messages[0].thread_id;
  const extracted = extractCollaborationMetadata(saved, source);
  expect(extracted.resources).toHaveLength(1);
  expect(extracted.resources[0]).toMatchObject({
    kind: "conversation",
    resource_id: thread,
    thread_id: thread,
  });
  expect(extracted.activity_ids[thread]).toHaveLength(2);
  expect(
    extractCollaborationMetadata(saved, {
      ...source,
      chat_path: "/home/user/new.chat",
    }).resources[0].resource_id,
  ).toBe(thread);
  const copied = extractCollaborationMetadata(
    [
      ...saved,
      {
        event: "collaborators-identity",
        schema_version: 1,
        identity_namespace: operation,
      },
    ],
    source,
  );
  expect(copied.resources[0].resource_id).not.toBe(thread);
  expect(copied.resources[0].thread_id).toBe(thread);
});

test("legacy unnamed ACP sessions remain agents without enrollment or naming", () => {
  const rows = [{ ...root, acp_config: { model: "codex" } }, reply];
  const extracted = extractCollaborationMetadata(
    [...rows, ...markers(rows)],
    source,
  );
  expect(extracted.resources[0]).toMatchObject({
    kind: "agent",
    title: "Untitled agent",
  });
  expect(extracted.resources[0].resource_id).toMatch(/^agent-thread:/);
  expect(extracted.resources[0].agent_id).toBeUndefined();
  expect(rows).toHaveLength(2);
});

test("unresolved or partial migration rejects the entire source, never a partial resource list", () => {
  expect(() => extractCollaborationMetadata([root, reply], source)).toThrow(
    "durable thread",
  );
  expect(() =>
    extractCollaborationMetadata(
      [root, reply, markers([root, reply])[0]],
      source,
    ),
  ).toThrow("incomplete_marker");
});
