import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import { from_str as legacyFromString } from "@cocalc/sync/editor/db/doc";
import {
  CHAT_PRIMARY_KEYS,
  CHAT_STRING_COLS,
  artifactKey,
  publishArtifact,
  readArtifact,
} from "@cocalc/chat";

test("independent human/agent patches merge text and preserve publication snapshots", () => {
  let initial = from_str("", [...CHAT_PRIMARY_KEYS], [...CHAT_STRING_COLS]);
  const store = {
    get_one: (key) => initial.get_one(key),
    set: (row) => {
      initial = initial.set(row);
    },
  };
  const target = { thread_id: "thread", artifact_id: "artifact" };
  publishArtifact(store, {
    ...target,
    operation_id: "create",
    message_id: "message",
    title: "Draft",
    markdown: "First paragraph.\n\nLast paragraph.",
  });
  const base = initial;
  const human = base.set({
    ...artifactKey(target),
    input: "Human first paragraph.\n\nLast paragraph.",
  });
  let agent = base;
  const agentStore = {
    get_one: (key) => agent.get_one(key),
    set: (row) => {
      agent = agent.set(row);
    },
  };
  publishArtifact(agentStore, {
    ...target,
    operation_id: "edit",
    message_id: "next-message",
    title: "Draft",
    base: readArtifact(agentStore, target).base,
    markdown: "First paragraph.\n\nAgent last paragraph.",
  });
  const humanPatch = base.make_patch(human);
  const agentPatch = base.make_patch(agent);
  const left = human.apply_patch(agentPatch);
  const right = agent.apply_patch(humanPatch);
  expect(left.get_one(artifactKey(target)).input).toBe(
    "Human first paragraph.\n\nAgent last paragraph.",
  );
  expect(left.to_str()).toBe(right.to_str());
  expect(left.get({ event: "chat-artifact-publication" })).toHaveLength(2);
});

test("an overlapping human patch invalidates the agent base before publication", () => {
  let doc = from_str("", [...CHAT_PRIMARY_KEYS], [...CHAT_STRING_COLS]);
  const store = {
    get_one: (key) => doc.get_one(key),
    set: (row) => {
      doc = doc.set(row);
    },
  };
  const target = { thread_id: "thread", artifact_id: "artifact" };
  const request = {
    ...target,
    operation_id: "create",
    message_id: "message",
    title: "Reply",
    markdown: "We will fix it today.",
  };
  publishArtifact(store, request);
  const agentRead = readArtifact(store, target);
  const human = doc.set({
    ...artifactKey(target),
    input: "We will investigate; no promised deadline.",
  });
  doc = doc.apply_patch(doc.make_patch(human));
  const beforeRejectedWrite = doc.to_str();
  expect(() =>
    publishArtifact(store, {
      ...request,
      operation_id: "reply-edit",
      base: agentRead.base,
      markdown: "We will definitely fix it today.",
    }),
  ).toThrow(/changed/);
  expect(doc.to_str()).toBe(beforeRejectedWrite);
  expect(doc.get({ event: "chat-artifact-publication" })).toHaveLength(1);

  const freshRead = readArtifact(store, target);
  publishArtifact(store, {
    ...request,
    operation_id: "reply-edit",
    base: freshRead.base,
    markdown: `${freshRead.artifact.input} Which course is this for?`,
  });
  expect(readArtifact(store, target).artifact.input).toBe(
    "We will investigate; no promised deadline. Which course is this for?",
  );
  expect(doc.get({ event: "chat-artifact-publication" })).toHaveLength(2);
});

test("legacy SyncDB roundtrip preserves artifact rows and string merge configuration", () => {
  let doc = from_str("", [...CHAT_PRIMARY_KEYS], [...CHAT_STRING_COLS]);
  publishArtifact(
    {
      get_one: (key) => doc.get_one(key),
      set: (row) => {
        doc = doc.set(row);
      },
    },
    {
      thread_id: "thread",
      artifact_id: "artifact",
      operation_id: "create",
      message_id: "message",
      title: "Draft",
      markdown: "Text",
    },
  );
  const legacy = legacyFromString(
    doc.to_str(),
    [...CHAT_PRIMARY_KEYS],
    [...CHAT_STRING_COLS],
  );
  const restored = from_str(
    legacy.to_str(),
    [...CHAT_PRIMARY_KEYS],
    [...CHAT_STRING_COLS],
  );
  const keyed = (rows) =>
    Object.fromEntries(rows.map((row) => [row.sender_id, row]));
  expect(keyed(restored.get())).toEqual(keyed(doc.get()));
});
