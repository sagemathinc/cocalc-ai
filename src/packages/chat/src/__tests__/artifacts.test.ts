import {
  artifactKey,
  publishArtifact,
  readArtifact,
  validateArtifact,
  validateArtifactPublication,
} from "../artifacts";

function store() {
  const rows = new Map<string, object>();
  const key = (row: any) =>
    JSON.stringify([row.event, row.sender_id, row.thread_id, row.date]);
  return {
    get_one: (where: object) => rows.get(key(where)),
    set: (row: object) => rows.set(key(row), row),
    rows,
  };
}
const input = {
  thread_id: "thread-1",
  artifact_id: "artifact-1",
  operation_id: "op-1",
  message_id: "message-1",
  title: "Replies",
  markdown: "Hello **world**",
};

test("publishes typed data and an exact historical snapshot", () => {
  const db = store();
  const first = publishArtifact(db, input);
  const next = publishArtifact(db, {
    ...input,
    operation_id: "op-2",
    base: first.base,
    markdown: "New",
  });
  expect(next.artifact.input).toBe("New");
  expect(first.publication.snapshot.markdown).toBe(input.markdown);
  expect(db.rows.size).toBe(3);
});

test("retry does not roll back a later human edit", () => {
  const db = store();
  publishArtifact(db, input);
  db.set({ ...readArtifact(db, input).artifact, input: "Human edit" });
  const retry = publishArtifact(db, input);
  expect(retry.replayed).toBe(true);
  expect(retry.artifact.input).toBe("Human edit");
  expect(db.rows.size).toBe(2);
});

test("rejects stale agent updates and duplicate creates", () => {
  const db = store();
  const first = publishArtifact(db, input);
  db.set({ ...first.artifact, input: "Human edit" });
  expect(() =>
    publishArtifact(db, { ...input, operation_id: "op-2", base: first.base }),
  ).toThrow(/changed/);
  expect(() => publishArtifact(db, { ...input, operation_id: "op-2" })).toThrow(
    /changed/,
  );
  expect(readArtifact(db, input).artifact.input).toBe("Human edit");
});

test("idempotency keys cannot be reused with a different payload", () => {
  const db = store();
  publishArtifact(db, input);
  expect(() =>
    publishArtifact(db, { ...input, markdown: "different" }),
  ).toThrow(/already used/);
});

test("targets do not leak between threads", () => {
  const db = store();
  publishArtifact(db, input);
  expect(() =>
    readArtifact(db, { ...input, thread_id: "elsewhere" }),
  ).toThrow();
  expect(artifactKey(input).thread_id).toBe(input.thread_id);
});

test("bounds UTF-8 payloads and rejects malformed imported records", () => {
  expect(() =>
    publishArtifact(store(), { ...input, markdown: "🙂".repeat(9000) }),
  ).toThrow(/bytes/);
  expect(() =>
    publishArtifact(store(), { ...input, artifact_id: "../invalid" }),
  ).toThrow();
  expect(() =>
    validateArtifact({ ...input, event: "chat-artifact", kind: "html" }),
  ).toThrow();
  expect(() =>
    validateArtifactPublication({ event: "chat-artifact-publication" }),
  ).toThrow();
});

test("markup is data, not a tool command", () => {
  const markdown = "<script>alert(1)</script> [link](javascript:alert(1))";
  expect(publishArtifact(store(), { ...input, markdown }).artifact.input).toBe(
    markdown,
  );
});
