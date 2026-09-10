// DStream transport sequences identify immutable batches. ACP event sequences
// cannot do this job: appendStreamMessages coalesces several of them into one.
export type LiveLogRanges = readonly (readonly [number, number])[];

export class LiveLogReplay {
  // A continuously active turn may run for days without recovery. Store runs
  // of received sequences, not one Set entry per batch for that entire turn.
  private received: [number, number][] = [];

  constructor(ranges: LiveLogRanges = []) {
    this.received = ranges.map(([start, end]) => [start, end]);
  }

  snapshot(): LiveLogRanges {
    return this.received.map(([start, end]) => [start, end]);
  }

  // Only a consumed prefix starting at the beginning of the transport stream
  // is proof that a resume request can safely skip older retained messages.
  startSeq(): number | undefined {
    return this.received[0]?.[0] === 1 ? this.received[0][1] + 1 : undefined;
  }

  accept(seq?: number): boolean {
    if (seq == null || !Number.isFinite(seq)) return true;
    let low = 0;
    let high = this.received.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.received[mid][0] <= seq) low = mid + 1;
      else high = mid;
    }
    const left = this.received[low - 1];
    const right = this.received[low];
    if (left && seq <= left[1]) return false;
    if (left && left[1] + 1 === seq) {
      left[1] = seq;
      if (right && right[0] === seq + 1) {
        left[1] = right[1];
        this.received.splice(low, 1);
      }
    } else if (right && right[0] === seq + 1) {
      right[0] = seq;
    } else {
      this.received.splice(low, 0, [seq, seq]);
    }
    return true;
  }

  read<T>(stream: {
    length: number;
    seqs: () => number[];
    get: (index: number) => T;
  }): { payloads: T[] } {
    const seqs = stream.seqs();
    const payloads: T[] = [];
    const length = stream.length;
    for (let index = 0; index < length; index++) {
      const seq = seqs[index];
      if (this.accept(seq)) payloads.push(stream.get(index));
    }
    // Snapshots can be partial while CoreStream backfills missing messages.
    // Preserve their holes exactly, including when these ranges are cached.
    return { payloads };
  }
}
