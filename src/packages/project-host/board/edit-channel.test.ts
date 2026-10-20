import { randomUUID } from "node:crypto";
import {
  editState as makeEditState,
  sharedPreviewBudget,
} from "@sagemathinc/sagebrush-board/submission";
import { EDIT_CHANNEL_LIMITS, EditChannel, editClientId } from "./edit-channel";

const board = JSON.stringify({
  format: "sagebrush-board",
  version: 1,
  title: "t",
  nodes: [{ id: "a", text: "hi" }],
});

let t = 0;
const clock = () => t;

function channel(
  opts: {
    budget?: ReturnType<typeof sharedPreviewBudget>;
    limits?: Partial<typeof EDIT_CHANNEL_LIMITS>;
  } = {},
) {
  const sent: any[] = [];
  const editState = makeEditState(board, {
    pictures: "by-reference",
    previewBudget: opts.budget ?? sharedPreviewBudget(),
  });
  const ch = new EditChannel({
    clientId: editClientId(randomUUID(), "conn1"),
    editState,
    send: (m) => sent.push(m),
    now: clock,
    limits: { ...EDIT_CHANNEL_LIMITS, ...opts.limits },
  });
  return { ch, sent, editState };
}

function edit(text = "hello", id = randomUUID()) {
  return {
    sagebrush: "edit",
    version: 1,
    id,
    base: "r0",
    changes: [
      {
        op: "set",
        key: { type: "item", page: "", id: "a" },
        fields: { text },
        was: { text: "hi" },
      },
    ],
  };
}

beforeEach(() => {
  t = 1_000_000;
});

test("the client id has one fixed format", () => {
  const a = randomUUID();
  expect(editClientId(a, "c-1_x")).toBe(`${a}:c-1_x`);
  expect(() => editClientId("not-a-uuid", "c")).toThrow();
  expect(() => editClientId(a, "has space")).toThrow();
  expect(() => editClientId(a, "x".repeat(33))).toThrow();
  expect(() => editClientId(a, "")).toThrow();
});

test("an acceptable edit is admitted with its editBytes, pending, and nothing changes", () => {
  const { ch, sent, editState } = channel();
  const before = JSON.stringify(editState.records());
  const m = edit();
  const r = ch.intake(m);
  expect(r).toMatchObject({ kind: "admit", id: m.id });
  expect((r as any).editBytes).toBe(Buffer.byteLength(JSON.stringify(m)));
  expect(ch.pending).toBe(m.id);
  expect(sent).toEqual([]);
  expect(JSON.stringify(editState.records())).toBe(before);
});

test("non-edits are ignored", () => {
  const { ch, sent } = channel();
  for (const m of [
    null,
    "edit",
    [],
    { sagebrush: "edit", version: 2, id: randomUUID() },
    { sagebrush: "resync", version: 1, id: randomUUID() },
    { sagebrush: "edit", version: 1, id: "not-a-uuid" },
  ]) {
    expect(ch.intake(m)).toEqual({ kind: "ignore" });
  }
  expect(sent).toEqual([]);
});

test("a message over 1 MiB is refused too-large, typed, before preview", () => {
  const { ch, sent, editState } = channel();
  const preview = jest.spyOn(editState, "preview");
  const m = edit("x".repeat(EDIT_CHANNEL_LIMITS.messageBytes));
  const r = ch.intake(m);
  expect(r).toMatchObject({
    kind: "answered",
    answer: { reason: "too-large", what: "edit", limit: 1024 * 1024 },
  });
  expect((r as any).answer.size).toBeGreaterThan(1024 * 1024);
  expect(sent).toHaveLength(1);
  // Refused by the channel's own check: preview never ran.
  expect(preview).not.toHaveBeenCalled();
});

test("one edit in flight: a second is refused busy; a duplicate of the pending one is ignored", () => {
  const { ch, sent } = channel();
  const first = edit("one");
  expect(ch.intake(first).kind).toBe("admit");
  // The same id again: ignored, its own answer comes later.
  expect(ch.intake(first)).toEqual({ kind: "ignore" });
  const second = edit("two");
  expect(ch.intake(second)).toMatchObject({
    kind: "answered",
    answer: { id: second.id, reason: "busy", retryAfter: 250 },
  });
  expect(sent).toHaveLength(1);
  // Answering the first frees the channel.
  ch.answer(first.id, { sagebrush: "saved", version: 1, id: first.id });
  expect(ch.pending).toBeUndefined();
  expect(ch.intake(edit("three")).kind).toBe("admit");
});

test("every refusal point is answered exactly once: replays are ignored", () => {
  const { ch, sent } = channel();
  const big = edit("x".repeat(EDIT_CHANNEL_LIMITS.messageBytes));
  ch.intake(big);
  expect(ch.intake(big)).toEqual({ kind: "ignore" });

  const a = edit("a");
  ch.intake(a); // admitted
  const busy = edit("b");
  ch.intake(busy); // refused busy (in flight)
  expect(ch.intake(busy)).toEqual({ kind: "ignore" });
  ch.answer(a.id, { sagebrush: "saved", version: 1, id: a.id });
  expect(ch.intake(a)).toEqual({ kind: "ignore" });

  const invalid = {
    ...edit(),
    changes: [{ op: "explode", key: { type: "item", page: "", id: "a" } }],
  };
  expect(ch.intake(invalid)).toMatchObject({
    kind: "answered",
    answer: { reason: "invalid" },
  });
  expect(ch.intake(invalid)).toEqual({ kind: "ignore" });

  const ids = sent.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(() => ch.answer(a.id, {})).toThrow(/already answered/);
});

test("the count token is taken before preview: a burst of 40, then 4 a second", () => {
  const { ch } = channel({
    budget: sharedPreviewBudget({ editBurst: 1000, editsPerSecond: 1000 }),
  });
  let admitted = 0;
  let busy: any;
  for (let i = 0; i < 50 && busy == null; i++) {
    const r = ch.intake(edit(`v${i}`));
    if (r.kind === "admit") {
      admitted += 1;
      ch.answer(r.id, { sagebrush: "saved", version: 1, id: r.id });
    } else if (r.kind === "answered") {
      busy = r.answer;
    }
  }
  expect(admitted).toBe(40);
  expect(busy).toMatchObject({ reason: "busy", retryAfter: 250 });
  t += 250;
  expect(ch.intake(edit("again")).kind).toBe("admit");
});

test("preview work is charged to the channel even when the preview refuses", () => {
  const { ch } = channel({
    budget: sharedPreviewBudget({
      editBurst: 1000,
      editsPerSecond: 1000,
      workBurst: 1 << 30,
      workPerSecond: 1 << 30,
    }),
    // Only the channel's work bucket can run out here: 4 MiB.
    limits: {
      previewBurst: 1000,
      previewPerSecond: 1000,
      previewWorkBurst: 4 << 20,
    },
  });
  // Large refused edits (their changes are invalid) still cost their size.
  const refusedLarge = () => ({
    ...edit("y".repeat(900 * 1024)),
    changes: [
      {
        op: "set",
        key: { type: "item", page: "", id: "nope" },
        fields: { text: "y".repeat(900 * 1024) },
        was: { text: "z" },
      },
    ],
  });
  let refusedBusy: any;
  for (let i = 0; i < 100 && refusedBusy == null; i++) {
    const r = ch.intake(refusedLarge());
    if (r.kind === "answered" && r.answer.reason === "busy")
      refusedBusy = r.answer;
    if (r.kind === "admit")
      ch.answer(r.id, { sagebrush: "saved", version: 1, id: r.id });
  }
  // The channel's work bucket ran out from these refused previews alone.
  expect(refusedBusy).toBeDefined();
  expect(refusedBusy.retryAfter).toBeGreaterThan(0);
});

test("a throttled preview (the host's shared budget) is busy, never a refusal of the edit", () => {
  const shared = sharedPreviewBudget({ editBurst: 2, editsPerSecond: 0.001 });
  const one = channel({ budget: shared });
  const two = channel({ budget: shared });
  // Two channels on two boards, one shared host budget of 2.
  const a = one.ch.intake(edit("a"));
  expect(a.kind).toBe("admit");
  one.ch.answer((a as any).id, {
    sagebrush: "saved",
    version: 1,
    id: (a as any).id,
  });
  expect(two.ch.intake(edit("b")).kind).toBe("admit");
  const third = one.ch.intake(edit("c"));
  expect(third).toMatchObject({ kind: "answered", answer: { reason: "busy" } });
  expect((third as any).answer.retryAfter).toBeGreaterThan(0);
});

test("one abusive channel can't starve another's previews", () => {
  const shared = sharedPreviewBudget({ editBurst: 100, editsPerSecond: 10 });
  const abusive = channel({ budget: shared });
  const quiet = channel({ budget: shared });
  // The abusive channel retries at once, again and again.
  for (let i = 0; i < 200; i++) {
    const r = abusive.ch.intake(edit(`x${i}`));
    if (r.kind === "admit")
      abusive.ch.answer(r.id, { sagebrush: "saved", version: 1, id: r.id });
  }
  // Its own bucket (40) stopped it long before the shared 100.
  expect(quiet.ch.intake(edit("q")).kind).toBe("admit");
});
