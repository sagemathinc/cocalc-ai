import { turnMetaKey } from "@cocalc/chat";
import { readerItems } from "../reader-model";
import {
  firstLine,
  isMachineMessage,
  itemPriority,
  itemSubject,
  itemTurnMeta,
  threadTurnMeta,
} from "../reader-turn-meta";

const msg = (id: string, content: string, extra: object = {}) =>
  ({
    message_id: id,
    sender_id: "acct",
    date: new Date(1),
    history: [{ content, author_id: "acct" }],
    ...extra,
  }) as any;
const reply = (id: string, parent: string, content: string) =>
  msg(id, content, {
    sender_id: "codex",
    acp_thread_id: "t",
    parent_message_id: parent,
  });

test("the first line worth reading, without Markdown", () => {
  expect(firstLine(msg("m", "\n\n## Fixed **the** [cache](x)\nmore"))).toBe(
    "Fixed the cache",
  );
  expect(firstLine(msg("m", ":robot: Thinking...\n- done it"))).toBe("done it");
  expect(firstLine(msg("m", "```\ncode\n```\nafter"))).toBe("after");
  expect(firstLine(msg("m", ""))).toBe("");
});

test("the subject: the agent's own, else its reply's first line, else the prompt's", () => {
  const [item] = readerItems([
    msg("p", "please fix it"),
    reply("a", "p", "I fixed the cache.\nDetails..."),
  ]);
  expect(itemSubject(item, undefined)).toBe("I fixed the cache.");
  expect(itemSubject(item, { subject: "Cache fix" } as any)).toBe("Cache fix");
  const [waiting] = readerItems([msg("p2", "please fix it")]);
  expect(itemSubject(waiting, undefined)).toBe("please fix it");
});

test("priority: an open question is high; else the agent's; else by who started it", () => {
  const [mine] = readerItems([msg("p", "hi")]);
  const [agents] = readerItems([msg("p", "hi", { agent_rpc: { x: 1 } })]);
  const [sensor] = readerItems([msg("p", "hi", { sensor_wake: { a: 1 } })]);
  expect(isMachineMessage(agents.messages[0])).toBe(true);
  expect(itemPriority(mine, undefined)).toBe("normal");
  expect(itemPriority(agents, undefined)).toBe("low");
  expect(itemPriority(sensor, undefined)).toBe("low");
  expect(itemPriority(agents, { priority: "high" } as any)).toBe("high");
  expect(itemPriority(mine, { priority: "low" } as any)).toBe("low");
  expect(itemPriority(mine, { priority: "low" } as any, true)).toBe("high");
});

test("records are read from the chat document, newest per item", () => {
  const rows = [
    {
      ...turnMetaKey({ thread_id: "t1", message_id: "a" }),
      message_id: "a",
      schema_version: 1,
      subject: "older",
      updated_at: "2026-01-01",
    },
    {
      ...turnMetaKey({ thread_id: "t1", message_id: "p" }),
      message_id: "p",
      schema_version: 1,
      subject: "newer",
      updated_at: "2026-02-01",
    },
    { event: "chat-turn-meta", junk: true },
  ];
  const syncdb = {
    get_state: () => "ready",
    get: jest.fn(() => rows),
  };
  const metas = threadTurnMeta(syncdb, "t1");
  expect(syncdb.get).toHaveBeenCalledWith({
    event: "chat-turn-meta",
    thread_id: "t1",
  });
  expect([...metas.keys()]).toEqual(["a", "p"]);
  const [item] = readerItems([msg("p", "x"), reply("a", "p", "y")]);
  expect(itemTurnMeta(item, metas)?.subject).toBe("newer");
  expect(threadTurnMeta({ get_state: () => "init" }, "t1").size).toBe(0);
});
