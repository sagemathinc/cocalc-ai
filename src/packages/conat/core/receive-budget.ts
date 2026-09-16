export interface ReceiveLimits {
  maxMessageBytes: number;
  maxInflightBytes: number;
  maxInflightMessages: number;
  maxFragmentsPerMessage?: number;
}

// Interim process-wide bound for retained raw fragments across every bounded
// subscription. Structured decode overhead is intentionally handled by the
// separate structured-decoding work; this prevents per-service limits from
// multiplying raw retained bytes without bound in the meantime.
export const MAX_PROCESS_INFLIGHT_RECEIVE_BYTES = 512 * 1024 * 1024;

export class AggregateReceiveBudget {
  private bytes = 0;

  constructor(
    private readonly maxBytes: number = MAX_PROCESS_INFLIGHT_RECEIVE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("positive aggregate receive limit required");
  }

  add(bytes: number): boolean {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.bytes + bytes > this.maxBytes
    )
      return false;
    this.bytes += bytes;
    return true;
  }

  remove(bytes: number): void {
    this.bytes = Math.max(0, this.bytes - bytes);
  }
}

const processReceiveBudget = new AggregateReceiveBudget();

/** Raw fragment accounting, before concatenation or MsgPack decoding. */
export class ReceiveBudget {
  private readonly sizes = new Map<
    string,
    { bytes: number; fragments: number }
  >();
  private bytes = 0;
  readonly limits: Required<ReceiveLimits>;

  constructor(
    limits: ReceiveLimits,
    private readonly aggregate: AggregateReceiveBudget = processReceiveBudget,
  ) {
    this.limits = {
      maxMessageBytes: limits.maxMessageBytes,
      maxInflightBytes: limits.maxInflightBytes,
      maxInflightMessages: limits.maxInflightMessages,
      maxFragmentsPerMessage: limits.maxFragmentsPerMessage ?? 1024,
    };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("positive integer receive limits required");
  }

  add(id: string, bytes: number): boolean {
    const previous = this.sizes.get(id);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      (previous === undefined &&
        this.sizes.size >= this.limits.maxInflightMessages) ||
      (previous?.fragments ?? 0) >= this.limits.maxFragmentsPerMessage ||
      (previous?.bytes ?? 0) + bytes > this.limits.maxMessageBytes ||
      this.bytes + bytes > this.limits.maxInflightBytes
    ) {
      this.remove(id);
      return false;
    }
    if (!this.aggregate.add(bytes)) {
      this.remove(id);
      return false;
    }
    this.sizes.set(id, {
      bytes: (previous?.bytes ?? 0) + bytes,
      fragments: (previous?.fragments ?? 0) + 1,
    });
    this.bytes += bytes;
    return true;
  }

  remove(id: string): void {
    const bytes = this.sizes.get(id)?.bytes ?? 0;
    this.bytes -= bytes;
    this.aggregate.remove(bytes);
    this.sizes.delete(id);
  }

  clear(): void {
    this.aggregate.remove(this.bytes);
    this.bytes = 0;
    this.sizes.clear();
  }
}
