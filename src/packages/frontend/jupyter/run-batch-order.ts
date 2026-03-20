export interface SequencedRunBatch {
  id?: string;
  seq?: number | string;
}

export interface RunBatchOrderState<T extends SequencedRunBatch> {
  nextSeq: number;
  pending: Map<number, T>;
  seenIds: Set<string>;
}

export function createRunBatchOrderState<
  T extends SequencedRunBatch,
>(): RunBatchOrderState<T> {
  return {
    nextSeq: 1,
    pending: new Map<number, T>(),
    seenIds: new Set<string>(),
  };
}

export function parseRunBatchSeq(batch: SequencedRunBatch): number | null {
  const seq =
    typeof batch?.seq === "number"
      ? batch.seq
      : Number.parseInt(`${batch?.seq ?? ""}`, 10);
  if (!Number.isFinite(seq) || seq <= 0) {
    return null;
  }
  return seq;
}

export function hasRunBatchGap<T extends SequencedRunBatch>(
  state: RunBatchOrderState<T>,
  batch: T,
): boolean {
  const seq = parseRunBatchSeq(batch);
  return seq != null && seq > state.nextSeq;
}

export function enqueueRunBatch<T extends SequencedRunBatch>(
  state: RunBatchOrderState<T>,
  batch: T,
): T[] {
  const batchId = `${batch?.id ?? ""}`.trim();
  if (batchId) {
    if (state.seenIds.has(batchId)) {
      return [];
    }
    state.seenIds.add(batchId);
  }
  const seq = parseRunBatchSeq(batch);
  if (seq == null) {
    return [batch];
  }
  if (seq < state.nextSeq) {
    return [];
  }
  if (!state.pending.has(seq)) {
    state.pending.set(seq, batch);
  }
  const ready: T[] = [];
  while (state.pending.has(state.nextSeq)) {
    const next = state.pending.get(state.nextSeq);
    state.pending.delete(state.nextSeq);
    if (next != null) {
      ready.push(next);
    }
    state.nextSeq += 1;
  }
  return ready;
}
