import {
  normalizeTurnSubject,
  readTurnMeta,
  setTurnMeta,
  TURN_SUBJECT_MAX,
} from "../turn-meta";

// The chat document's set merges fields into the row with the same keys;
// null removes a field.
function store(row: Record<string, unknown>) {
  let current = { ...row };
  return {
    get: () => current,
    set: (update: Record<string, unknown>) => {
      for (const k of ["event", "date", "sender_id", "message_id", "thread_id"])
        if (update[k] !== current[k]) throw Error(`wrong row: ${k}`);
      const merged: Record<string, unknown> = { ...current, ...update };
      for (const k of Object.keys(merged))
        if (merged[k] == null) delete merged[k];
      current = merged;
    },
  };
}

const row = {
  event: "chat",
  date: "2026-10-23T01:00:00.000Z",
  sender_id: "codex",
  message_id: "m1",
  thread_id: "t1",
  history: [{ content: "reply" }],
};

test("a turn's subject and priority go on its message, set apart and kept", () => {
  const s = store(row);
  setTurnMeta(s, s.get(), { subject: "Fixed the cache" });
  setTurnMeta(s, s.get(), { priority: "high" });
  expect(readTurnMeta(s.get())).toEqual({
    subject: "Fixed the cache",
    priority: "high",
  });
  // The message itself is untouched.
  expect(s.get().history).toEqual(row.history);
  // An empty subject clears it; the priority stays.
  expect(setTurnMeta(s, s.get(), { subject: "  " })).toEqual({
    priority: "high",
  });
  expect(readTurnMeta(s.get())).toEqual({ priority: "high" });
});

test("subjects are one bounded line; bad input is refused", () => {
  expect(normalizeTurnSubject(" a\n  b\tc ")).toBe("a b c");
  expect(normalizeTurnSubject("x".repeat(500))).toHaveLength(TURN_SUBJECT_MAX);
  // Emoji are one character each, and never cut in half.
  const emoji = normalizeTurnSubject("😀".repeat(200));
  expect(Array.from(emoji)).toHaveLength(TURN_SUBJECT_MAX);
  expect(emoji.endsWith("😀…")).toBe(true);
  expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  const s = store(row);
  expect(() => setTurnMeta(s, row, {})).toThrow(/subject or a priority/);
  expect(() => setTurnMeta(s, row, { priority: "urgent" as any })).toThrow(
    /priority must be/,
  );
  expect(() =>
    setTurnMeta(s, { ...row, event: "chat-thread-config" }, { subject: "x" }),
  ).toThrow(/chat message/);
});

test("only valid values are read", () => {
  expect(readTurnMeta(undefined)).toEqual({});
  expect(
    readTurnMeta({ acp_turn_subject: 5, acp_turn_priority: "urgent" }),
  ).toEqual({});
  expect(
    readTurnMeta({ acp_turn_subject: "a\nb", acp_turn_priority: "low" }),
  ).toEqual({ subject: "a b", priority: "low" });
});
