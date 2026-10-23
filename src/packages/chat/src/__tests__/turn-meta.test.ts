import {
  normalizeTurnSubject,
  readTurnMeta,
  setTurnMeta,
  TURN_SUBJECT_MAX,
  turnMetaKey,
} from "../turn-meta";

// The chat document's set merges fields into the record with the same key.
function store() {
  const rows = new Map<string, any>();
  const keyOf = (r: any) =>
    JSON.stringify([r.event, r.date, r.sender_id, r.thread_id]);
  return {
    rows,
    get_one: (where: any) => rows.get(keyOf(where)),
    set: (record: any) => {
      const merged = { ...(rows.get(keyOf(record)) ?? {}), ...record };
      for (const k of Object.keys(merged))
        if (merged[k] == null) delete merged[k];
      rows.set(keyOf(record), merged);
    },
  };
}

const target = { thread_id: "t1", message_id: "m1" };

test("a turn's subject and priority are set apart and kept", () => {
  const s = store();
  setTurnMeta(s, { ...target, subject: "Fixed the cache" });
  setTurnMeta(s, { ...target, priority: "high" });
  expect(readTurnMeta(s.get_one(turnMetaKey(target)))).toMatchObject({
    message_id: "m1",
    subject: "Fixed the cache",
    priority: "high",
  });
  // An empty subject clears it; the priority stays.
  setTurnMeta(s, { ...target, subject: "  " });
  const meta = readTurnMeta(s.get_one(turnMetaKey(target)))!;
  expect(meta.subject).toBeUndefined();
  expect(meta.priority).toBe("high");
});

test("subjects are one bounded line; bad input is refused", () => {
  expect(normalizeTurnSubject(" a\n  b\tc ")).toBe("a b c");
  expect(normalizeTurnSubject("x".repeat(500))).toHaveLength(TURN_SUBJECT_MAX);
  const s = store();
  expect(() => setTurnMeta(s, { ...target })).toThrow(/subject or a priority/);
  expect(() =>
    setTurnMeta(s, { ...target, priority: "urgent" as any }),
  ).toThrow(/priority must be/);
  expect(() => setTurnMeta(s, { thread_id: "t1", message_id: "" })).toThrow();
});

test("only well-formed records are read", () => {
  expect(readTurnMeta(undefined)).toBeUndefined();
  expect(readTurnMeta({ event: "chat" })).toBeUndefined();
  // Not its own key: e.g. a record copied to another message.
  expect(
    readTurnMeta({
      event: "chat-turn-meta",
      schema_version: 1,
      thread_id: "t1",
      message_id: "m2",
      sender_id: "__turn__:m1",
    }),
  ).toBeUndefined();
  expect(
    readTurnMeta({
      ...turnMetaKey(target),
      message_id: "m1",
      schema_version: 1,
      priority: "urgent",
      subject: 5,
    }),
  ).toMatchObject({ message_id: "m1" });
});
