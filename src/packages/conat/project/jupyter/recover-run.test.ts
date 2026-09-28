/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { recoverRunOutput } from "./recover-run";
import { JupyterRunTransportError } from "./run-code";
import type { JupyterLiveRunPage } from "./live-run";

const batch = (seq: number) => ({
  path: "test.ipynb",
  run_id: "r",
  id: `r:${seq}`,
  seq,
  mesgs: [{ run_id: "r", content: { text: `${seq}` } }],
  sent_at_ms: 0,
});
function page(seqs: number[], next: number, done = true): JupyterLiveRunPage {
  return {
    path: "test.ipynb",
    run_id: "r",
    batches: seqs.map(batch),
    next_seq: next,
    done,
    has_more: false,
    updated_at_ms: 0,
  };
}
function source(cursor: number | undefined = 1) {
  return {
    replayCursor: cursor,
    async *[Symbol.asyncIterator]() {
      yield batch(1).mesgs;
      throw new JupyterRunTransportError("r");
    },
  };
}
async function collect(iter: AsyncIterable<unknown>) {
  const result: unknown[] = [];
  for await (const value of iter) result.push(value);
  return result;
}

it("reads only missing output after an interrupted run", async () => {
  const readPage = jest
    .fn()
    .mockResolvedValueOnce({ ...page([2], 2), has_more: true })
    .mockResolvedValueOnce(page([3], 3));
  const result = await collect(
    recoverRunOutput({
      source: source(),
      runId: "r",
      readPage,
      signal: new AbortController().signal,
    }),
  );
  expect(result).toEqual([1, 2, 3].map((seq) => batch(seq).mesgs));
  expect(readPage.mock.calls).toEqual([[1], [2]]);
});

it("polls unfinished output without restarting execution", async () => {
  const readPage = jest
    .fn()
    .mockResolvedValueOnce(page([], 1, false))
    .mockResolvedValueOnce(page([2], 2));
  expect(
    await collect(
      recoverRunOutput({
        source: source(),
        runId: "r",
        readPage,
        signal: new AbortController().signal,
        pollMs: 1,
      }),
    ),
  ).toHaveLength(2);
  expect(readPage.mock.calls).toEqual([[1], [1]]);
});

it.each([
  page([1], 1),
  page([3], 3),
  page([2], 4),
  { ...page([], 1), has_more: true },
  { ...page([2], 2), run_id: "other" },
  { ...page([2], 2), batches: [{ ...batch(2), mesgs: [{ run_id: "other" }] }] },
])("rejects inconsistent replay", async (value) => {
  await expect(
    collect(
      recoverRunOutput({
        source: source(),
        runId: "r",
        readPage: async () => value,
        signal: new AbortController().signal,
      }),
    ),
  ).rejects.toThrow();
});

it("does not guess when replay has expired", async () => {
  await expect(
    collect(
      recoverRunOutput({
        source: source(),
        runId: "r",
        readPage: async () => null,
        signal: new AbortController().signal,
      }),
    ),
  ).rejects.toMatchObject({ code: "JUPYTER_RUN_TRANSPORT_LOST", run_id: "r" });
});

it("preserves authorization failure as a recovery failure", async () => {
  const denied = Object.assign(new Error("denied"), { code: 403 });
  await expect(
    collect(
      recoverRunOutput({
        source: source(),
        runId: "r",
        readPage: async () => {
          throw denied;
        },
        signal: new AbortController().signal,
      }),
    ),
  ).rejects.toMatchObject({
    code: "JUPYTER_RUN_RECOVERY_FAILED",
    run_id: "r",
    cause: denied,
  });
});

it("does not recover unnumbered legacy output", async () => {
  const readPage = jest.fn();
  const legacy = source();
  legacy.replayCursor = undefined;
  await expect(
    collect(
      recoverRunOutput({
        source: legacy,
        runId: "r",
        readPage,
        signal: new AbortController().signal,
      }),
    ),
  ).rejects.toThrow();
  expect(readPage).not.toHaveBeenCalled();
});

it("drops a response arriving after cancellation", async () => {
  const controller = new AbortController();
  const result = await collect(
    recoverRunOutput({
      source: source(),
      runId: "r",
      readPage: async () => {
        controller.abort();
        return page([2], 2);
      },
      signal: controller.signal,
    }),
  );
  expect(result).toEqual([batch(1).mesgs]);
});
