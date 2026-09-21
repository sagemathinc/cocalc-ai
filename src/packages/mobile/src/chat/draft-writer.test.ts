import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftWriter } from "./draft-writer";

test("a delayed draft write cannot resurrect a draft cleared after sending", async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const saved: string[] = [];
  const writer = new DraftWriter(async (_, value) => {
    if (value === "first") await wait;
    saved.push(value);
  });
  const a = writer.save("conversation", "first");
  const b = writer.save("conversation", "second");
  const c = writer.save("conversation", "");
  finish();
  await Promise.all([a, b, c]);
  assert.deepEqual(saved, ["first", "second", ""]);
});

test("storage failure is reported but does not block later drafts", async () => {
  const saved: string[] = [];
  const writer = new DraftWriter(async (_, value) => {
    if (value === "bad") throw new Error("disk error");
    saved.push(value);
  });
  const failed = writer.save("conversation", "bad");
  const next = writer.save("conversation", "recovered");
  await assert.rejects(failed, /disk error/);
  await next;
  assert.deepEqual(saved, ["recovered"]);
});

test("a blocked conversation does not block another account or conversation", async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const saved: string[] = [];
  const writer = new DraftWriter(async (key) => {
    if (key === "a") await wait;
    saved.push(key);
  });
  const a = writer.save("a", "draft");
  await writer.save("b", "draft");
  assert.deepEqual(saved, ["b"]);
  finish();
  await a;
});

test("late acceptance clears the submitted draft but preserves newer text", async () => {
  let value = "submitted";
  const writer = new DraftWriter(async (_, next) => {
    value = next;
  });
  await writer.clearIfUnchanged("chat", "submitted", async () => value);
  assert.equal(value, "");
  await writer.save("chat", "new draft after reopening");
  await writer.clearIfUnchanged("chat", "submitted", async () => value);
  assert.equal(value, "new draft after reopening");
});
