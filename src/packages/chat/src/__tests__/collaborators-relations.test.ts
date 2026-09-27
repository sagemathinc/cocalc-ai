import { randomUUID } from "node:crypto";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";
import type { CollaborationRelationThread } from "@cocalc/util/collaboration-relations";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import {
  collaborationMessageReferences,
  extractCollaborationRelations,
  nativeCollaborationRelationThreads,
} from "../collaborators-relations";

const source: CollaborationRelationThread = {
  kind: "agent",
  resource_id: "agent-thread:native-thread",
  thread_id: "native-thread",
};
const target = {
  project_id: randomUUID(),
  kind: "artifact" as const,
  resource_id: "artifact:authored",
};
const reference = {
  version: 1 as const,
  target,
  display_fallback: "Authored label",
  alias: "private-alias",
};
const atom = serializeCollaborationReference(reference);
function message(content = atom, sender_id = randomUUID()) {
  return {
    event: "chat",
    thread_id: source.thread_id,
    message_id: randomUUID(),
    sender_id,
    history: [{ content }],
  };
}

test("head and archive pages both contribute without the participant preview cap", () => {
  const rows = Array.from({ length: 250 }, () => message("text"));
  const relations = [
    ...extractCollaborationRelations(rows.slice(0, 50), [source]),
    ...extractCollaborationRelations(rows.slice(50), [source]),
  ];
  expect(relations).toHaveLength(250);
  expect(relations[249]).toEqual({
    kind: "participant",
    source,
    account_id: rows[249].sender_id,
  });
});
test("reference edges preserve native source and exact authored target, not display aliases", () => {
  const row = message(`${atom} ${atom}`);
  expect([...extractCollaborationRelations([row], [source])]).toEqual([
    { kind: "participant", source, account_id: row.sender_id },
    {
      kind: "reference",
      source,
      message_id: row.message_id,
      reference: { version: 1, target },
    },
  ]);
});
test("copy namespace stays on source while authored reference target is never rewritten", () => {
  const copied = { ...source, resource_id: `copy:${randomUUID()}` };
  expect(
    [...extractCollaborationRelations([message()], [copied])][1],
  ).toMatchObject({ source: copied, reference: { target } });
});
test("references follow current edits and omit superseded historical targets", () => {
  const row = {
    ...message("No reference now"),
    history: [{ content: "No reference now" }, { content: atom }],
  };
  expect(
    [...extractCollaborationRelations([row], [source])].map((r) => r.kind),
  ).toEqual(["participant"]);
});
test.each([
  `\`${atom}\``,
  `\`\`\`html\n${atom}\n\`\`\``,
  "@private-alias",
  atom
    .replace("Authored label", "Forged label")
    .replace("@private-alias", "Forged label"),
])("non-reference display/code does not create a graph edge: %s", (content) => {
  expect([...collaborationMessageReferences(content)]).toEqual([]);
});
test("unknown nonhuman sender is not a participant but authored references remain", () => {
  expect([
    ...extractCollaborationRelations([message(atom, "assistant")], [source]),
  ]).toHaveLength(1);
});
test("missing message identity or unresolved thread aborts rather than claiming an empty set", () => {
  expect(() => [
    ...extractCollaborationRelations(
      [{ ...message(), message_id: undefined }],
      [source],
    ),
  ]).toThrow("durable message");
  expect(() => [...extractCollaborationRelations([message()], [])]).toThrow(
    "native thread provenance",
  );
});
test("missing content and oversized messages fail explicitly", () => {
  expect(() => [
    ...extractCollaborationRelations([{ ...message(), history: [] }], [source]),
  ]).toThrow("current authored content");
  expect(() => [
    ...collaborationMessageReferences("x".repeat(1024 * 1024 + 1)),
  ]).toThrow("capacity");
});
test("native thread binding excludes artifacts and rejects already adapted agent IDs", () => {
  const resource = {
    ...source,
    project_id: randomUUID(),
    chat_path: "/home/user/a.chat",
    title: "Agent",
    activity: 1,
    participant_ids: [],
    created_at: 1,
    updated_at: 1,
  } as CollaborationResource;
  expect(
    nativeCollaborationRelationThreads([
      resource,
      { ...resource, kind: "artifact" },
    ]),
  ).toEqual([source]);
  expect(() =>
    nativeCollaborationRelationThreads([
      { ...resource, agent_id: randomUUID() },
    ]),
  ).toThrow("native thread provenance");
});
