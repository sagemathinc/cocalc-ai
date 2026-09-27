/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  chatIdentityMutation,
  chatIdentityWritePatch,
  planChatIdentityMigration,
  resolveChatIdentityRows,
} from "./collaboration-chat-identity";
import {
  CHAT_IDENTITY_EVENT,
  ChatIdentityError,
  buildChatIdentityMarkers,
  chatIdentityStorageKey,
  chatIdentityTimestamp,
  readChatIdentityMarkers,
} from "./collaboration-chat-identity-markers";

const migration_id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const date = "2026-09-27T00:00:00.000Z";
const ms = Date.parse(date);
const root = () => ({
  event: "chat",
  sender_id: "alice",
  date,
  history: [{ content: "untouched", author_id: "alice", date }],
  acp_config: { model: "codex" },
});
const reply = () => ({
  event: "chat",
  sender_id: "bob",
  date: ms + 1,
  reply_to: date,
});
const plan = (rows: unknown[], id = migration_id) =>
  planChatIdentityMigration(rows, { migration_id: id, history_complete: true });

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    throw Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatIdentityError);
    expect((error as ChatIdentityError).code).toBe(code);
  }
}

test("root and reply resolve through persisted markers, without changing storage or payloads", () => {
  const rows = [root(), reply()];
  const before = JSON.stringify(rows);
  Object.freeze(rows[0]);
  Object.freeze(rows[1]);
  const markers = plan(rows);
  expect(JSON.stringify(rows)).toBe(before);
  expect(markers.every((m) => m.event === CHAT_IDENTITY_EVENT)).toBe(true);
  expect(JSON.stringify(markers)).not.toContain("untouched");
  expect(JSON.stringify(markers)).not.toContain("codex");
  const resolution = resolveChatIdentityRows([...rows, ...markers]);
  const [first, second] = resolution.messages;
  expect(first.thread_id).toBe(second.thread_id);
  expect(second.parent_message_id).toBe(first.message_id);
  expect(first.parent_message_id).toBeNull();
  expect(first.raw).toBe(rows[0]);
  expect(first.projected.history).toBe(rows[0].history);
  expect(first.storage_key).toEqual({
    event: "chat",
    date,
    sender_id: "alice",
  });
  expect(second.storage_key.date).toBe(ms + 1);
  expect(plan([...rows, ...markers])).toEqual([]);
  expect(plan([...rows].reverse())).toEqual(markers);
});

test("no read-time IDs and no incomplete history guesses", () => {
  expectCode(
    () => resolveChatIdentityRows([root(), reply()]),
    "missing_identity",
  );
  expectCode(
    () =>
      planChatIdentityMigration([root()], {
        migration_id,
        history_complete: false,
      }),
    "history_required",
  );
  expectCode(() => plan([reply()]), "missing_parent");
});

test.each([date, "2026-09-27T02:00:00+02:00", ms, `${ms}`])(
  "exact root timestamp representation %s",
  (reply_to) => {
    const rows = [root(), { ...reply(), reply_to }];
    const { messages } = resolveChatIdentityRows([...rows, ...plan(rows)]);
    expect(messages[1].parent_message_id).toBe(messages[0].message_id);
  },
);

test.each([
  "2026-09-27",
  "09/27/2026",
  "2026-02-30T00:00:00Z",
  "2026-09-27T24:00:00Z",
  "2026-09-27T00:00:00.0001Z",
  "2026-09-27T00:00:00",
  "1e12",
  1.1,
  NaN,
  Infinity,
  null,
  new Date(date),
])("rejects ambiguous/invalid/precision-losing timestamp %s", (value) => {
  expectCode(() => chatIdentityTimestamp(value), "invalid_timestamp");
});

test("timestamp collisions reject instead of choosing sender/order/earliest", () => {
  const rows = [root(), { ...root(), sender_id: "charlie" }, reply()];
  expectCode(() => plan(rows), "ambiguous_timestamp");
  expectCode(() => plan(rows.reverse()), "ambiguous_timestamp");
  expectCode(
    () => plan([root(), { ...reply(), reply_to: ms - 1 }]),
    "missing_parent",
  );
});

test("exact chained timestamps keep real immediate parents", () => {
  const rows = [
    root(),
    reply(),
    { ...reply(), date: ms + 2, reply_to: ms + 1 },
  ];
  const { messages } = resolveChatIdentityRows([...rows, ...plan(rows)]);
  expect(messages[2].thread_id).toBe(messages[0].thread_id);
  expect(messages[2].parent_message_id).toBe(messages[1].message_id);
});

test("cycles are never given an earliest/root fallback", () => {
  expectCode(
    () => plan([{ ...root(), reply_to: ms + 1 }, reply()]),
    "cyclic_parent",
  );
});

test("native IDs and existing legacy-prefixed thread IDs are preserved", () => {
  const first = {
    ...root(),
    message_id: "native-root",
    thread_id: "legacy-thread-123",
  };
  const rows = [first, reply()];
  const { messages } = resolveChatIdentityRows([...rows, ...plan(rows)]);
  expect(messages[0].message_id).toBe("native-root");
  expect(messages[1]).toMatchObject({
    thread_id: "legacy-thread-123",
    parent_message_id: "native-root",
  });
  expect(plan([first])).toEqual([]);
});

test("fully native v2 rows keep native parent semantics despite stale legacy fields", () => {
  const native = {
    ...root(),
    schema_version: 2,
    message_id: "m",
    thread_id: "t",
    reply_to: ms - 100,
  };
  expect(plan([native])).toEqual([]);
  expect(
    resolveChatIdentityRows([native]).messages[0].parent_message_id,
  ).toBeNull();
});

test("conflicting native thread identities and legacy parent forms reject", () => {
  expectCode(
    () =>
      plan([
        { ...root(), message_id: "root", thread_id: "one" },
        { ...reply(), thread_id: "two" },
      ]),
    "conflicting_identity",
  );
  expectCode(
    () =>
      plan([
        { ...root(), message_id: "root", thread_id: "one" },
        { ...reply(), reply_to_message_id: "other" },
      ]),
    "conflicting_identity",
  );
});

test("manifest-last commits reject partial reads but allow deterministic retry", () => {
  const rows = [root(), reply()];
  const markers = plan(rows);
  expectCode(
    () => resolveChatIdentityRows([...rows, markers[0]]),
    "incomplete_marker",
  );
  expect(plan([...rows, markers[0]])).toEqual(markers);
  expectCode(() => plan([...rows, markers[0]], other), "incomplete_marker");
  expectCode(
    () => plan([{ ...root(), sender_id: "changed" }, reply(), markers[0]]),
    "changed_source",
  );
  expectCode(
    () => resolveChatIdentityRows([...rows, markers.at(-1)]),
    "incomplete_marker",
  );
});

test("chunks are bounded and complete manifests validate every chunk", () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({
    ...root(),
    date: ms + i,
  }));
  const markers = plan(rows);
  expect(markers).toHaveLength(3);
  expect(markers[0]).toHaveProperty("entries.length", 128);
  expect(markers[1]).toHaveProperty("entries.length", 2);
  expect(resolveChatIdentityRows([...rows, ...markers]).messages).toHaveLength(
    130,
  );
  expectCode(
    () => resolveChatIdentityRows([...rows, markers[0], markers[2]]),
    "incomplete_marker",
  );
  expectCode(
    () => resolveChatIdentityRows([...rows, ...markers, markers[0]]),
    "invalid_marker",
  );
});

test("corrupt, duplicate and conflicting mappings are rejected", () => {
  const markers = plan([root()]);
  const corrupt = JSON.parse(JSON.stringify(markers));
  corrupt[0].entries[0].message_id = "changed";
  expectCode(() => readChatIdentityMarkers(corrupt), "invalid_marker");
  expectCode(
    () => readChatIdentityMarkers([...markers, ...plan([root()], other)]),
    "duplicate_identity",
  );
  const e = [...readChatIdentityMarkers(markers).entries.values()][0];
  expectCode(
    () =>
      buildChatIdentityMarkers(
        [{ ...e, storage_key: { ...e.storage_key, message_id: "native" } }],
        other,
      ),
    "invalid_marker",
  );
});

test("archive pages resolve using head markers without resurrecting absent rows", () => {
  const rows = [root(), reply()];
  const markers = plan(rows);
  const original = resolveChatIdentityRows([...rows, ...markers]).messages;
  const archive = resolveChatIdentityRows([rows[1], ...markers]);
  expect(archive.messages).toHaveLength(1);
  expect(archive.messages[0].parent_message_id).toBe(original[0].message_id);
  expect(resolveChatIdentityRows(markers).messages).toEqual([]);
});

test("explicit reparent/null updates override markers, legacy rewiring does not silently rebind", () => {
  const rows = [root(), reply()];
  const markers = plan(rows);
  const changed = { ...rows[1], parent_message_id: null, reply_to: null };
  expect(
    resolveChatIdentityRows([rows[0], changed, ...markers]).messages[1]
      .parent_message_id,
  ).toBeNull();
  expectCode(
    () =>
      resolveChatIdentityRows([
        rows[0],
        { ...rows[1], reply_to: ms - 1 },
        ...markers,
      ]),
    "changed_source",
  );
});

test("edits retain exact original keys, including nulls and noncanonical timestamp spelling", () => {
  const row = {
    ...root(),
    date: "2026-09-27T02:00:00+02:00",
    message_id: null,
    thread_id: "",
  };
  const markers = plan([row]);
  const message = resolveChatIdentityRows([row, ...markers]).messages[0];
  expect(
    chatIdentityWritePatch(message, {
      ...message.projected,
      history: [],
      date: "wrong",
    }),
  ).toEqual({
    ...row,
    history: [],
    parent_message_id: null,
  });
  expect(chatIdentityStorageKey(row)).toEqual({
    event: "chat",
    date: row.date,
    sender_id: "alice",
    message_id: null,
    thread_id: "",
  });
});

test("renames do not affect mapping; copied namespace markers remain untouched", () => {
  const rows = [root(), reply()];
  const markers = plan(rows);
  const copy = {
    event: "collaborators-identity",
    identity_namespace: other,
    schema_version: 1,
  };
  const source = resolveChatIdentityRows([...rows, ...markers]);
  const copied = resolveChatIdentityRows([...rows, ...markers, copy]);
  expect(copied.messages.map((m) => m.message_id)).toEqual(
    source.messages.map((m) => m.message_id),
  );
  expect(copied.rows.at(-1)).toBe(copy);
  expect(plan([...rows, ...markers, copy])).toEqual([]);
});

test("new legacy rows extend rather than reassign completed mappings", () => {
  const rows = [root(), reply()];
  const markers = plan(rows);
  const next = { ...reply(), date: ms + 2 };
  const additions = plan([...rows, ...markers, next], other);
  const before = resolveChatIdentityRows([...rows, ...markers]);
  const after = resolveChatIdentityRows([
    ...rows,
    next,
    ...markers,
    ...additions,
  ]);
  expect(after.messages.slice(0, 2)).toEqual(before.messages);
  expect(after.messages[2].thread_id).toBe(before.messages[0].thread_id);
});

test("read projections normalize numeric timestamp strings without altering write keys", () => {
  const row = { ...root(), date: `${ms}` };
  const markers = plan([row]);
  const resolved = resolveChatIdentityRows([row, ...markers]).messages[0];
  expect(resolved.projected.date).toBe(date);
  expect(resolved.storage_key.date).toBe(`${ms}`);
});

test("removed mapped messages cannot be recreated by stale edits", () => {
  const markers = plan([root()]);
  const resolved = resolveChatIdentityRows([root(), ...markers]).messages[0];
  expectCode(
    () => chatIdentityMutation(markers, resolved.projected),
    "missing_identity",
  );
});

test("timestamp-only roots at the same instant remain unresolved", () => {
  expectCode(
    () => plan([root(), { ...root(), sender_id: "other" }]),
    "ambiguous_timestamp",
  );
});

test("validly encoded cyclic marker graphs are still rejected", () => {
  const entries = [
    ...readChatIdentityMarkers(plan([root(), reply()])).entries.values(),
  ];
  entries[0].parent_message_id = entries[1].message_id;
  entries[1].parent_message_id = entries[0].message_id;
  expectCode(
    () => readChatIdentityMarkers(buildChatIdentityMarkers(entries, other)),
    "cyclic_parent",
  );
});

test("persisted legacy timestamp thread configuration keeps its identity", () => {
  const config = {
    event: "chat-thread-config",
    thread_id: `legacy-thread-${ms}`,
    agent_kind: "acp",
    name: "existing name",
  };
  const rows = [root(), reply(), config];
  const resolved = resolveChatIdentityRows([...rows, ...plan(rows)]);
  expect(
    resolved.messages.every((row) => row.thread_id === config.thread_id),
  ).toBe(true);
  expect(resolved.rows[2]).toBe(config);
});
