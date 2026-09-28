/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { JupyterRunIterator, type OutputMessage } from "./run-code";

function fixture() {
  const emitter = new EventEmitter();
  const iter = new JupyterRunIterator(emitter, "data", {
    map: ([batch, sequence]) => {
      iter.recordSequence(batch, sequence);
      return batch;
    },
  });
  const emit = (
    sequence?: unknown,
    batch: OutputMessage[] = [{ run_id: "r" }],
  ) => emitter.emit("data", batch, sequence);
  return { iter, emit };
}

it("advances the replay cursor only for consumed batches", async () => {
  const { iter, emit } = fixture();
  emit(1);
  emit(2);
  expect(iter.replayCursor).toBe(0);
  await iter.next();
  expect(iter.replayCursor).toBe(1);
  iter.cancel(new Error("transport lost"));
  await expect(iter.next()).rejects.toThrow("transport lost");
  expect(iter.replayCursor).toBe(1);
});

it.each([undefined, 0, -1, 1, 1.5, NaN, Infinity, 3, "2x", "02", "2.0"])(
  "disables replay after missing, invalid or discontinuous sequence %s",
  async (sequence) => {
    const { iter, emit } = fixture();
    emit(1);
    await iter.next();
    emit(sequence);
    await iter.next();
    expect(iter.replayCursor).toBeUndefined();
    emit(3);
    await iter.next();
    expect(iter.replayCursor).toBeUndefined();
    iter.close();
  },
);

it("accepts canonical decimal transport headers", async () => {
  const { iter, emit } = fixture();
  emit("1");
  await iter.next();
  emit("2");
  await iter.next();
  expect(iter.replayCursor).toBe(2);
  iter.close();
});

it("advances once when a waiting consumer is awakened", async () => {
  const { iter, emit } = fixture();
  const pending = iter.next();
  emit(1);
  await pending;
  expect(iter.replayCursor).toBe(1);
  iter.close();
});

it("ignores empty batches and preserves the cursor through graceful completion", async () => {
  const { iter, emit } = fixture();
  emit(undefined, []);
  await iter.next();
  emit(1);
  emit(2);
  iter.end();
  await iter.next();
  await iter.next();
  expect(iter.replayCursor).toBe(2);
  expect(await iter.next()).toMatchObject({ done: true });
});
