export interface ReceiveLimits {
  maxMessageBytes: number;
  maxInflightBytes: number;
  maxInflightMessages: number;
  maxFragmentsPerMessage?: number;
}

/** Raw fragment accounting, before concatenation or MsgPack decoding. */
export class ReceiveBudget {
  private readonly sizes = new Map<
    string,
    { bytes: number; fragments: number }
  >();
  private bytes = 0;
  readonly limits: Required<ReceiveLimits>;

  constructor(limits: ReceiveLimits) {
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
    this.sizes.set(id, {
      bytes: (previous?.bytes ?? 0) + bytes,
      fragments: (previous?.fragments ?? 0) + 1,
    });
    this.bytes += bytes;
    return true;
  }

  remove(id: string): void {
    this.bytes -= this.sizes.get(id)?.bytes ?? 0;
    this.sizes.delete(id);
  }
}
