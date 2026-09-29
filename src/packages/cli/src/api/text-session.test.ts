import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Client } from "@cocalc/conat/core/client";
import { createLiveTextBinder, openLiveTextSession } from "./text";

function fixture() {
  let closed = false;
  let text = "initial";
  let finishSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const raw = {
    wait_until_ready: async (): Promise<void> => undefined,
    isClosed: () => closed,
    close: () => {
      closed = true;
      finishSave();
    },
    to_str: () => text,
    from_str: (value: string) => {
      text = value;
    },
    save: () => pendingSave,
    save_to_disk: () => pendingSave,
    historyLastVersion: () => "v1",
    hash_of_live_version: () => 1,
  };
  const client = Object.assign(new EventEmitter(), {
    state: "connected",
    info: { user: {} as { error?: string } },
    sync: { string: () => raw },
  });
  const open = (openTimeoutMs?: number) =>
    openLiveTextSession({
      client: client as unknown as Client,
      projectId: "project",
      path: "/home/user/probe.txt",
      openTimeoutMs,
    });
  return { client, raw, open, finishSave };
}

for (const method of ["save", "save_to_disk"] as const) {
  test(`text ${method} rejects authority loss even when closing resolves the raw save`, async () => {
    const { client, raw, open } = fixture();
    const { session } = await open();
    session.from_str("pending draft");
    const pending = session[method]!();
    const rejected = assert.rejects(pending, /authorization failed/);
    client.info.user.error = "denied";
    client.emit("info", client.info);
    await rejected;
    assert.equal(raw.isClosed(), true);
    assert.equal(client.listenerCount("info"), 0);
    assert.equal(client.listenerCount("closed"), 0);
    client.info.user = {};
    client.emit("info", client.info);
    assert.throws(
      () => session.from_str("must not replay"),
      /authorization failed/,
    );
    await assert.rejects(session.save(), /authorization failed/);
    assert.equal(raw.to_str(), "pending draft");
  });
}

test("healthy text lease reconnection does not interrupt a pending save", async () => {
  const { client, raw, open, finishSave } = fixture();
  const { session } = await open();
  const pending = session.save();
  client.state = "disconnected";
  client.emit("disconnected");
  client.state = "connected";
  client.emit("info", client.info);
  finishSave();
  await pending;
  assert.equal(raw.isClosed(), false);
  await session.close();
});

test("client close interrupts the session callback and removes listeners", async () => {
  const { client, raw, open } = fixture();
  const { run } = await open();
  const pending = run(() => new Promise<void>(() => {}));
  const rejected = assert.rejects(pending, /connection closed/);
  client.state = "closed";
  client.emit("closed");
  await rejected;
  assert.equal(raw.isClosed(), true);
  assert.equal(client.listenerCount("info"), 0);
});

test("idle authorization loss closes a cached session before it can be reused", async () => {
  const { client, raw, open } = fixture();
  const { session, run } = await open();
  client.info.user.error = "denied";
  client.emit("info", client.info);
  await assert.rejects(
    run(async () => "cached read"),
    /authorization failed/,
  );
  assert.equal(raw.isClosed(), true);
  assert.throws(() => session.to_str(), /authorization failed/);
});

test("explicit session close interrupts pending work instead of acknowledging it", async () => {
  const { open } = fixture();
  const { session } = await open();
  const pending = session.save();
  const rejected = assert.rejects(pending, /session closed/);
  await session.close();
  await rejected;
});

test("failed or timed-out text opening closes the raw session", async () => {
  for (const reason of ["denial", "timeout"]) {
    const { client, raw, open } = fixture();
    raw.wait_until_ready = () => new Promise<void>(() => {});
    if (reason === "denial") client.info.user.error = "denied";
    await assert.rejects(
      open(10),
      reason === "denial" ? /authorization failed/ : /timeout/,
    );
    assert.equal(raw.isClosed(), true);
    assert.equal(client.listenerCount("info"), 0);
    assert.equal(client.listenerCount("closed"), 0);
  }
});

test("text cache does not share a document across different authenticated clients", async () => {
  const a = fixture();
  const b = fixture();
  b.raw.from_str("separate authority");
  const api = createLiveTextBinder<
    { client: Client },
    { project_id: string; title: string; host_id: null }
  >({
    leaseMs: 0,
    resolveProjectConatClient: async (ctx) => ({
      client: ctx.client,
      project: { project_id: "project", title: "fixture", host_id: null },
    }),
  });
  let release!: () => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const doc = (client: typeof a.client) =>
    api.bindDocument(
      { client: client as unknown as Client },
      { path: "/home/user/probe.txt" },
    );
  const first = doc(a.client).withSession(async () => {
    opened();
    await hold;
  });
  await ready;
  try {
    assert.equal((await doc(b.client).read()).text, "separate authority");
  } finally {
    release();
    await first;
  }
});
