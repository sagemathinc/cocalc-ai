import {
  createRunBatchOrderState,
  enqueueRunBatch,
  hasRunBatchGap,
} from "../run-batch-order";

describe("jupyter live-run batch ordering", () => {
  it("emits in-order batches immediately", () => {
    const state = createRunBatchOrderState<{
      id: string;
      seq: number;
    }>();
    expect(
      enqueueRunBatch(state, {
        id: "r1:1",
        seq: 1,
      }),
    ).toEqual([{ id: "r1:1", seq: 1 }]);
    expect(
      enqueueRunBatch(state, {
        id: "r1:2",
        seq: 2,
      }),
    ).toEqual([{ id: "r1:2", seq: 2 }]);
  });

  it("buffers out-of-order batches until the gap is filled", () => {
    const state = createRunBatchOrderState<{
      id: string;
      seq: number;
      label: string;
    }>();
    expect(
      enqueueRunBatch(state, {
        id: "r1:2",
        seq: 2,
        label: "run_done",
      }),
    ).toEqual([]);
    expect(
      enqueueRunBatch(state, {
        id: "r1:1",
        seq: 1,
        label: "output",
      }),
    ).toEqual([
      { id: "r1:1", seq: 1, label: "output" },
      { id: "r1:2", seq: 2, label: "run_done" },
    ]);
  });

  it("drops duplicate ids and already-processed seq numbers", () => {
    const state = createRunBatchOrderState<{
      id: string;
      seq: number;
    }>();
    expect(enqueueRunBatch(state, { id: "r1:1", seq: 1 })).toEqual([
      { id: "r1:1", seq: 1 },
    ]);
    expect(enqueueRunBatch(state, { id: "r1:1", seq: 1 })).toEqual([]);
    expect(enqueueRunBatch(state, { id: "r1:2", seq: 2 })).toEqual([
      { id: "r1:2", seq: 2 },
    ]);
    expect(enqueueRunBatch(state, { id: "r1:1b", seq: 1 })).toEqual([]);
  });

  it("only marks future seq numbers as gaps", () => {
    const state = createRunBatchOrderState<{
      id: string;
      seq: number;
    }>();
    expect(hasRunBatchGap(state, { id: "r1:1", seq: 1 })).toBe(false);
    expect(hasRunBatchGap(state, { id: "r1:2", seq: 2 })).toBe(true);
    enqueueRunBatch(state, { id: "r1:1", seq: 1 });
    expect(hasRunBatchGap(state, { id: "r1:1b", seq: 1 })).toBe(false);
    expect(hasRunBatchGap(state, { id: "r1:2", seq: 2 })).toBe(false);
    expect(hasRunBatchGap(state, { id: "r1:4", seq: 4 })).toBe(true);
  });
});
