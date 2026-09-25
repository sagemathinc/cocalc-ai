import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveDelegation } from "./delegation";
import type { ProjectedChatMessage } from "@cocalc/chat-client";

test("delegation submits each transcript once and returns only its matching final reply", async () => {
  const sent: string[] = [],
    updates: unknown[][] = [];
  const bridge = new LiveDelegation(
    async (text) => {
      sent.push(text);
      return { message_id: "human-1" };
    },
    (...args) => updates.push(args),
    () => {},
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    event_id: "t1",
    delta: "Make a plot.",
    end_ms: 900,
  });
  await bridge.event({
    type: "session.input_transcript.delta",
    event_id: "t1",
    delta: "Make a plot.",
    end_ms: 900,
  });
  const event = {
    type: "session.delegation.created",
    offset_ms: 1000,
    delegation: { id: "d1", target: "client" },
  };
  await bridge.event(event);
  await bridge.event(event);
  assert.deepEqual(sent, ["Make a plot."]);
  const reply = {
    role: "agent",
    parent_message_id: "human-1",
    content: "**Done.**",
    generating: false,
  } as ProjectedChatMessage;
  bridge.observe([
    { ...reply, parent_message_id: "other" },
    { ...reply, generating: true },
  ]);
  assert.equal(updates.length, 1);
  bridge.observe([reply]);
  bridge.observe([reply]);
  assert.equal(updates.length, 2);
  assert.equal(updates[1][2], "d1");
  assert.match(String(updates[1][1]), /Done/);
});

test("a correction after delegation offset is not folded into the earlier request", async () => {
  const sent: string[] = [];
  const bridge = new LiveDelegation(
    async (text) => {
      sent.push(text);
      return { message_id: String(sent.length) };
    },
    () => {},
    () => {},
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Plot x.",
    end_ms: 900,
  });
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Actually x squared.",
    end_ms: 1500,
  });
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 1000,
    delegation: { id: "d1", target: "client" },
  });
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 1600,
    delegation: { id: "d2", target: "client" },
  });
  assert.deepEqual(sent, ["Plot x.", "Actually x squared."]);
});

test("overlapping spoken tasks wait for separate durable send acknowledgments", async () => {
  let acceptFirst!: (value: { message_id: string }) => void;
  const sent: string[] = [];
  const accepted: string[] = [];
  const bridge = new LiveDelegation(
    (text) => {
      sent.push(text);
      return text === "First task."
        ? new Promise((resolve) => {
            acceptFirst = resolve;
          })
        : Promise.resolve({ message_id: "human-2" });
    },
    (type, _, id) => {
      if (type === "session.thinking.append") accepted.push(id);
    },
    () => {},
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "First task.",
    end_ms: 10,
  });
  const first = bridge.event({
    type: "session.delegation.created",
    offset_ms: 11,
    delegation: { id: "d1", target: "client" },
  });
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Second task.",
    end_ms: 20,
  });
  const second = bridge.event({
    type: "session.delegation.created",
    offset_ms: 21,
    delegation: { id: "d2", target: "client" },
  });
  assert.deepEqual(sent, ["First task."]);
  acceptFirst({ message_id: "human-1" });
  await Promise.all([first, second]);
  assert.deepEqual(sent, ["First task.", "Second task."]);
  assert.deepEqual(accepted, ["d1", "d2"]);
});

test("uncertain admission is not retried or announced as accepted", async () => {
  let sends = 0;
  const updates: string[] = [];
  const bridge = new LiveDelegation(
    async () => {
      sends++;
      throw Error("timeout");
    },
    (_, text) => updates.push(text),
    () => {},
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Run it.",
    end_ms: 1,
  });
  const event = {
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "d", target: "client" },
  };
  await bridge.event(event);
  await bridge.event(event);
  assert.equal(sends, 1);
  assert.match(updates[0], /could not be confirmed/);
});

test("ending the call fences late admission but does not cancel accepted work", async () => {
  let resolve!: (value: { message_id: string }) => void;
  const updates: string[] = [];
  const bridge = new LiveDelegation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    (_, text) => updates.push(text),
    () => {},
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Run it.",
    end_ms: 1,
  });
  const task = bridge.event({
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "d", target: "client" },
  });
  bridge.close();
  resolve({ message_id: "accepted" });
  await task;
  assert.deepEqual(updates, []);
});

test("no transcript means no speculative backend submission", async () => {
  let sends = 0;
  const bridge = new LiveDelegation(
    async () => {
      sends++;
      return { message_id: "x" };
    },
    () => {},
    () => {},
  );
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "d", target: "client" },
  });
  assert.equal(sends, 0);
});

test("does not send raw submission errors to the voice provider", async () => {
  const updates: string[] = [];
  let sends = 0;
  const bridge = new LiveDelegation(
    async () => {
      sends++;
      throw Error("Selected ChatGPT credential is unavailable");
    },
    (_type, text) => updates.push(text),
    () => {},
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Run tests",
    end_ms: 1,
  });
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "d", target: "client" },
  });
  assert.equal(sends, 1);
  assert.doesNotMatch(updates[0], /Selected ChatGPT credential is unavailable/);
  assert.match(updates[0], /could not be confirmed/);
  assert.match(updates[0], /Do not retry/);
});

test("reports a failed accepted task instead of waiting forever for an assistant reply", async () => {
  const updates: string[] = [];
  const bridge = new LiveDelegation(
    async () => ({ message_id: "m" }),
    (_type, text) => updates.push(text),
    () => {},
  );
  await bridge.event({
    type: "session.input_transcript.delta",
    delta: "Run tests",
    end_ms: 1,
  });
  await bridge.event({
    type: "session.delegation.created",
    offset_ms: 2,
    delegation: { id: "d", target: "client" },
  });
  bridge.observe([
    { message_id: "m", role: "human", state: "error" } as ProjectedChatMessage,
  ]);
  assert.match(updates.at(-1)!, /request failed/);
  const count = updates.length;
  bridge.observe([
    { message_id: "m", role: "human", state: "error" } as ProjectedChatMessage,
  ]);
  assert.equal(updates.length, count);
});
