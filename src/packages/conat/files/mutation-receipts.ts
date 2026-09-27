import { randomId } from "@cocalc/conat/names";
import { ConatError } from "@cocalc/conat/util";

export type MutationState = "reserved" | "running" | "succeeded" | "failed";

interface Receipt {
  scope: string;
  state: MutationState;
  expires: number;
  fingerprint?: string;
  result?: Promise<void>;
}

/**
 * Process-local at-most-once execution, not durable exactly-once delivery.
 * Callers must authorize every request, including outcome reads and retries,
 * and derive scope and payload fingerprints on the server. Receipt possession
 * is not authorization. A restart/eviction returns unknown, never a fresh run.
 */
export class MutationReceipts {
  private receipts = new Map<string, Receipt>();

  constructor(
    private readonly options: {
      maxEntries: number;
      maxPerScope: number;
      retentionMs: number;
      now?: () => number;
    },
  ) {
    for (const value of [
      options.maxEntries,
      options.maxPerScope,
      options.retentionMs,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("receipt limits must be positive safe integers");
      }
    }
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private prune() {
    const now = this.now();
    for (const [id, receipt] of this.receipts) {
      // Never release capacity for a still-running mutation, even if its caller
      // has gone away. Otherwise hung work could evade the admission budget.
      if (receipt.state !== "running" && receipt.expires <= now)
        this.receipts.delete(id);
    }
  }

  reserve(scope: string): string {
    if (!scope || scope.length > 512) throw new Error("invalid receipt scope");
    this.prune();
    let scopeCount = 0;
    for (const receipt of this.receipts.values())
      if (receipt.scope === scope) scopeCount++;
    const full = () =>
      this.receipts.size >= this.options.maxEntries ||
      scopeCount >= this.options.maxPerScope;
    // Completed outcomes are a bounded cache. Eviction is safe because unknown
    // IDs cannot be recreated by execute(). Active/reserved slots are protected.
    for (const [id, receipt] of this.receipts) {
      if (!full()) break;
      if (
        (receipt.state === "succeeded" || receipt.state === "failed") &&
        (scopeCount < this.options.maxPerScope || receipt.scope === scope)
      ) {
        this.receipts.delete(id);
        if (receipt.scope === scope) scopeCount--;
      }
    }
    if (full())
      throw new ConatError("mutation receipt capacity reached", { code: 429 });
    const id = randomId();
    this.receipts.set(id, {
      scope,
      state: "reserved",
      expires: this.now() + this.options.retentionMs,
    });
    return id;
  }

  status(scope: string, id: string): MutationState | "unknown" {
    this.prune();
    const receipt = this.receipts.get(id);
    return receipt?.scope === scope ? receipt.state : "unknown";
  }

  execute(
    scope: string,
    id: string,
    fingerprint: string,
    action: () => Promise<void>,
  ): Promise<void> {
    this.prune();
    const receipt = this.receipts.get(id);
    if (!receipt || receipt.scope !== scope) {
      return Promise.reject(
        new ConatError("mutation outcome unknown", { code: "OUTCOME_UNKNOWN" }),
      );
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      return Promise.reject(
        new ConatError("invalid mutation fingerprint", { code: 400 }),
      );
    }
    if (receipt.fingerprint != null && receipt.fingerprint !== fingerprint) {
      return Promise.reject(
        new ConatError("mutation payload changed", { code: 409 }),
      );
    }
    if (receipt.result) return receipt.result;
    receipt.fingerprint = fingerprint;
    receipt.state = "running";
    receipt.result = Promise.resolve()
      .then(action)
      .then(
        () => {
          receipt.state = "succeeded";
        },
        (error) => {
          receipt.state = "failed";
          // Do not retain arbitrary error objects or mutation payloads in cache.
          throw new ConatError(String(error?.message ?? error).slice(0, 1024), {
            code:
              typeof error?.code === "number"
                ? error.code
                : typeof error?.code === "string"
                  ? error.code.slice(0, 128)
                  : undefined,
          });
        },
      )
      .finally(() => {
        receipt.expires = this.now() + this.options.retentionMs;
      });
    void receipt.result.catch(() => undefined);
    return receipt.result;
  }
}
