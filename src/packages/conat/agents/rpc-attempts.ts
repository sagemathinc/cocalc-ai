import { createHash } from "node:crypto";
import {
  rpcOutcome,
  type AgentRpcSource,
  agentRpcSourceKey,
  isExternalAgentSource,
  type AgentRpcAttempt,
  type AgentRpcOutcome,
  type AgentRpcSend,
} from "./rpc";

interface Entry {
  hash: string;
  expires: number;
  result?: AgentRpcOutcome;
  promise: Promise<AgentRpcOutcome>;
}

/** Volatile evidence only. Eviction/restart is unknown, never permission to replay.
 * This object has no timers, persistence, recovery or execution callbacks on read. */
export class AgentRpcAttempts {
  private readonly entries = new Map<string, Entry>();
  private readonly sources = new Map<
    string,
    { since: number; count: number; active: number }
  >();
  constructor(
    private readonly options: {
      ttlMs?: number;
      maxEntries?: number;
      now?: () => number;
    } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private key(
    source: AgentRpcSource,
    attempt: AgentRpcAttempt,
    accountId?: string,
  ) {
    return `${JSON.stringify(accountId ?? null)}/${agentRpcSourceKey(source)}/${attempt.agent_network_id}/${attempt.target.project_id}/${attempt.target.agent_id}/${attempt.attempt_id}`;
  }
  private prune() {
    for (const [key, entry] of this.entries)
      if (entry.result && entry.expires <= this.now()) this.entries.delete(key);
    for (const [key, value] of this.sources)
      if (!value.active && this.now() - value.since >= 60_000)
        this.sources.delete(key);
  }

  inspect(
    source: AgentRpcSource,
    attempt: AgentRpcAttempt,
    accountId?: string,
  ): AgentRpcOutcome {
    this.prune();
    return (
      this.entries.get(this.key(source, attempt, accountId))?.result ??
      rpcOutcome(attempt, "unknown", {
        reason: "No retained acceptance evidence",
      })
    );
  }

  async send(
    source: AgentRpcSource,
    request: AgentRpcSend,
    execute: () => Promise<AgentRpcOutcome>,
    accountId?: string,
  ): Promise<AgentRpcOutcome> {
    this.prune();
    const key = this.key(source, request, accountId);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          request.agent_network_id,
          request.body,
          request.file_references ?? null,
          request.snapshot_manifest ?? null,
        ]),
      )
      .digest("hex");
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.hash !== hash)
        return rpcOutcome(request, "rejected", {
          reason:
            "Attempt ID already used with different content; the earlier attempt may have been accepted",
        });
      return previous.promise;
    }
    if (this.entries.size >= (this.options.maxEntries ?? 2000))
      return rpcOutcome(request, "rejected", {
        reason: "Attempt evidence capacity reached",
        chat_effect: "none",
      });
    const sourceKey = isExternalAgentSource(source)
      ? `external/${source.account_id}`
      : agentRpcSourceKey(source);
    let window = this.sources.get(sourceKey);
    if (!window) {
      window = { since: this.now(), count: 0, active: 0 };
      this.sources.set(sourceKey, window);
    }
    if (this.now() - window.since >= 60_000) {
      window.since = this.now();
      window.count = 0;
    }
    if (window.count >= 60 || window.active >= 8)
      return rpcOutcome(request, "rejected", {
        reason: "Source rate or concurrency limit reached",
        chat_effect: "none",
      });
    window.count++;
    window.active++;
    // Defer execute so concurrent callers see the entry before any side effects.
    const entry: Entry = {
      hash,
      expires: Infinity,
      promise: Promise.resolve()
        .then(execute)
        .catch(() =>
          rpcOutcome(request, "unknown", {
            reason: "Submission outcome unavailable",
          }),
        )
        .then((result) => {
          window!.active--;
          entry.result = result;
          entry.expires = this.now() + (this.options.ttlMs ?? 10 * 60_000);
          return result;
        }),
    };
    this.entries.set(key, entry);
    return entry.promise;
  }
}
