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
  assert.match(updates[0], /Could not confirm/);
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
