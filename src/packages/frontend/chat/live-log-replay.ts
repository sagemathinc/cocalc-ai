// DStream transport sequences identify immutable batches. ACP event sequences
// cannot do this job: appendStreamMessages coalesces several of them into one.
export class LiveLogReplay {
  // A continuously active turn may run for days without recovery. Store runs
  // of received sequences, not one Set entry per batch for that entire turn.
  private received: [number, number][] = [];

  constructor(private replayedThrough?: number) {}

  accept(seq?: number): boolean {
    if (seq == null || !Number.isFinite(seq)) return true;
    if (this.replayedThrough != null && seq <= this.replayedThrough)
      return false;
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
  }): { payloads: T[]; through?: number } {
    const seqs = stream.seqs();
    const payloads: T[] = [];
    let through = this.replayedThrough;
    const length = stream.length;
    for (let index = 0; index < length; index++) {
      const seq = seqs[index];
      if (this.accept(seq)) payloads.push(stream.get(index));
      if (seq != null && Number.isFinite(seq)) {
        through = Math.max(through ?? seq, seq);
      }
    }
    // Only a full snapshot can advance the watermark. A live receipt of N
    // must not hide a silently missed N-1 that recovery has just backfilled.
    this.replayedThrough = through;
    if (through != null)
      this.received = this.received.filter((range) => range[1] > through);
    return { payloads, through };
  }
}
