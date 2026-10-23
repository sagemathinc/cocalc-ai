import {
  findItem,
  isItemArchived,
  isItemRead,
  markAllRead,
  markItemRead,
  markItemUnread,
  readerItems,
  READER_STATE_LIMITS,
  setItemArchived,
} from "../reader-model";

// A person's message, or an agent's reply (it has ACP metadata).
const person = (id: string) =>
  ({ message_id: id, sender_id: "acct", date: new Date(1) }) as any;
const agent = (id: string) =>
  ({ message_id: id, sender_id: "codex", acp_thread_id: "t" }) as any;

describe("reader items", () => {
  it("groups each incoming message with the agent replies after it", () => {
    const items = readerItems([
      agent("a0"),
      person("p1"),
      agent("a1"),
      agent("a1b"),
      person("p2"),
      person("p3"),
      agent("a3"),
    ]);
    expect(
      items.map(({ id, lastId, firstIndex, lastIndex }) => [
        id,
        lastId,
        firstIndex,
        lastIndex,
      ]),
    ).toEqual([
      ["a0", "a0", 0, 0],
      ["p1", "a1b", 1, 3],
      ["p2", "p2", 4, 4],
      ["p3", "a3", 5, 6],
    ]);
  });
});

describe("an item is one turn", () => {
  const at = (ms: number) => new Date(ms);
  const said = (id: string, ms: number, extra: object = {}) =>
    ({ message_id: id, sender_id: "acct", date: at(ms), ...extra }) as any;
  // A turn: the reply to `parent`, started at `ms`, last written at `done`.
  const turn = (
    id: string,
    parent: string,
    ms: number,
    done?: number,
    extra: object = {},
  ) =>
    ({
      message_id: id,
      sender_id: "codex",
      acp_thread_id: "t",
      parent_message_id: parent,
      date: at(ms),
      history:
        done == null
          ? []
          : [{ author_id: "codex", date: at(done).toISOString() }],
      ...extra,
    }) as any;
  const ids = (items) =>
    items.map((item) => item.messages.map((m) => m.message_id));

  it("what arrives while a turn runs goes with it", () => {
    expect(
      ids(
        readerItems([
          said("p1", 1000),
          turn("a1", "p1", 1100, 5000),
          said("steer", 2000),
          said("agent-message", 3000, { agent_rpc: { from: "x" } }),
          said("later", 6000),
        ]),
      ),
    ).toEqual([["p1", "a1", "steer", "agent-message"], ["later"]]);
  });

  it("a running turn takes what arrives, as the log shows it", () => {
    const items = readerItems(
      [said("p1", 1000), turn("a1", "p1", 1100), said("steer", 9000)],
      { acpState: new Map([["message:a1", "running"]]) },
    );
    expect(ids(items)).toEqual([["p1", "a1", "steer"]]);
    // Generating says the same.
    expect(
      ids(
        readerItems([
          said("p1", 1000),
          turn("a1", "p1", 1100, undefined, { generating: true }),
          said("steer", 9000),
        ]),
      ),
    ).toEqual([["p1", "a1", "steer"]]);
  });

  it("a delivered message goes with its turn, whatever a stale state says", () => {
    expect(
      ids(
        readerItems(
          [
            said("p1", 1000),
            turn("a1", "p1", 1100, 9000),
            said("steer", 2000, { acp_guidance_delivered_at_ms: 2100 }),
          ],
          { acpState: new Map([["message:steer", "queue"]]) },
        ),
      ),
    ).toEqual([["p1", "a1", "steer"]]);
  });

  it("the newest spanning turn by start time, in any order", () => {
    // Out of date order (e.g. clock skew): a2 started later than a1.
    const items = readerItems([
      said("p2", 1500),
      turn("a2", "p2", 1600, 9000),
      said("p1", 1000),
      turn("a1", "p1", 1100, 9000),
      said("steer", 3000),
    ]);
    expect(
      items.find((item) => item.id === "p2")!.messages.map((m) => m.message_id),
    ).toEqual(["p2", "a2", "steer"]);
  });

  it("not what waits to be sent, a note for people, or the next turn's prompt", () => {
    expect(
      ids(
        readerItems(
          [
            said("p1", 1000),
            turn("a1", "p1", 1100, 9000),
            said("queued", 2000),
            said("not-sent", 2500, { acp_state: "not-sent" }),
            said("note", 3000, { post_only: true }),
            said("p2", 4000),
            turn("a2", "p2", 9500, 9600),
          ],
          { acpState: new Map([["message:queued", "queue"]]) },
        ),
      ),
    ).toEqual([["p1", "a1"], ["queued"], ["not-sent"], ["note"], ["p2", "a2"]]);
  });
});

describe("read state", () => {
  const messages = [person("p1"), agent("a1"), person("p2"), person("p3")];
  const items = readerItems(messages);
  const [one, two, three] = items;

  it("is read at or before the watermark, unless marked unread", () => {
    expect(isItemRead(one, 1, {})).toBe(true);
    expect(isItemRead(two, 1, {})).toBe(false);
    // Only the prompt was read in order; its reply came later.
    expect(isItemRead(one, 0, {})).toBe(false);
    expect(isItemRead(one, 1, { u: ["p1"] })).toBe(false);
  });

  it("opening the next item moves the watermark over it", () => {
    expect(markItemRead(items, two, 1, {})).toEqual({
      state: {},
      watermarkCount: 3,
      unmoved: expect.any(Object),
    });
  });

  it("opening an item out of order keeps it read until a new reply", () => {
    const { state, watermarkCount } = markItemRead(items, three, 1, {});
    expect(watermarkCount).toBeUndefined();
    expect(state).toEqual({ r: { p3: "p3" } });
    expect(isItemRead(three, 1, state)).toBe(true);
    // A reply arrives: it is unread again.
    const later = readerItems([...messages, agent("a3")]);
    expect(isItemRead(later[2], 1, state)).toBe(false);
    // Then reading the gap moves the watermark over both, and r empties.
    expect(markItemRead(items, two, 1, state)).toEqual({
      state: {},
      watermarkCount: 4,
      unmoved: expect.any(Object),
    });
  });

  it("marking unread, then opening again", () => {
    const unread = markItemUnread(one, {});
    expect(unread).toEqual({ u: ["p1"] });
    expect(isItemRead(one, 3, unread)).toBe(false);
    // An item marked unread stops the watermark: it covers p2 only.
    expect(markItemRead(items, two, 1, markItemUnread(three, {}))).toEqual({
      state: { u: ["p3"] },
      watermarkCount: 3,
      unmoved: expect.any(Object),
    });
    // Before the watermark it stays: p1 unread with p2 opened past it.
    expect(markItemRead(items, three, 1, unread)).toEqual({
      state: { r: { p3: "p3" }, u: ["p1"] },
    });
    expect(markItemRead(items, one, 3, unread)).toEqual({ state: {} });
  });

  it("archives until a new reply", () => {
    const state = setItemArchived(three, true, {});
    expect(isItemArchived(three, state)).toBe(true);
    const later = readerItems([...messages, agent("a3")]);
    expect(isItemArchived(later[2], state)).toBe(false);
    expect(setItemArchived(three, false, state)).toEqual({});
  });

  it("mark all read keeps archives and drops the exceptions", () => {
    expect(
      markAllRead(items, { r: { p3: "p3" }, u: ["p1"], a: { p2: "p2" } }),
    ).toEqual({
      state: { a: { p2: "p2" } },
      watermarkCount: 4,
      // If the watermark cannot move, nothing changes.
      unmoved: { r: { p3: "p3" }, u: ["p1"], a: { p2: "p2" } },
    });
  });

  it("keeps each list bounded, newest last", () => {
    let state = {};
    const many = readerItems(
      Array.from({ length: READER_STATE_LIMITS.archived + 5 }, (_, i) =>
        person(`m${i}`),
      ),
    );
    for (const item of many) state = setItemArchived(item, true, state);
    const ids = Object.keys((state as any).a);
    expect(ids).toHaveLength(READER_STATE_LIMITS.archived);
    expect(ids[ids.length - 1]).toBe(`m${READER_STATE_LIMITS.archived + 4}`);
    expect(ids[0]).toBe("m5");
  });

  it("finds the next matching item either way", () => {
    expect(findItem(items, 0, 1)).toBe(1);
    expect(findItem(items, 0, -1)).toBeUndefined();
    expect(findItem(items, -1, 1, (item) => item.id === "p3")).toBe(2);
  });
});

describe("agent replies without ACP metadata", () => {
  it("join their prompt when a language model wrote them", () => {
    const failure = {
      message_id: "f1",
      sender_id: "openai-gpt-4o",
      history: [{ author_id: "openai-gpt-4o", content: "failed" }],
    } as any;
    const legacy = {
      message_id: "l1",
      sender_id: "someone",
      history: [
        { author_id: "anthropic-claude-3-5-sonnet", content: "old reply" },
      ],
    } as any;
    expect(
      readerItems([person("p1"), failure, person("p2"), legacy]).map((item) => [
        item.id,
        item.lastId,
      ]),
    ).toEqual([
      ["p1", "f1"],
      ["p2", "l1"],
    ]);
  });
});

describe("interleaved histories", () => {
  // prompt-A, prompt-B, then a late reply to A.
  const lateReply = {
    ...agent("ra"),
    parent_message_id: "pa",
  };
  const messages = [person("pa"), person("pb"), lateReply];
  const items = readerItems(messages);
  const itemA = items.find((item) => item.id === "pa")!;
  const itemB = items.find((item) => item.id === "pb")!;

  it("a reply joins its prompt's item, which moves on to its time", () => {
    // In the order of each item's latest message: A's reply is the newest.
    expect(
      items.map(({ id, lastId, indexes }) => [id, lastId, indexes]),
    ).toEqual([
      ["pb", "pb", [1]],
      ["pa", "ra", [0, 2]],
    ]);
  });

  it("the watermark moves only over messages whose items are read", () => {
    // Reading A (both its messages) leaves B's message unread between them.
    const a = markItemRead(items, itemA, -1, {});
    expect(a).toEqual({
      state: { r: { pa: "ra" } },
      watermarkCount: 1,
      unmoved: expect.any(Object),
    });
    // Then B: everything is read, in order.
    expect(markItemRead(items, itemB, 0, a.state)).toEqual({
      state: {},
      watermarkCount: 3,
      unmoved: expect.any(Object),
    });
  });
});

describe("when the watermark cannot move", () => {
  it("the change says what to keep: the exceptions as they were", () => {
    const items = readerItems([person("p1"), person("p2")]);
    expect(markItemRead(items, items[0], -1, { r: { p2: "p2" } })).toEqual({
      state: {},
      watermarkCount: 2,
      unmoved: { r: { p1: "p1", p2: "p2" } },
    });
  });
});
