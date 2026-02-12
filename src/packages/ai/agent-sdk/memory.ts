/*
Simple in-memory helper implementations for tests and local runtimes.
*/

import type {
  AgentActionResult,
  AgentAuditEvent,
  AgentAuditEventStatus,
} from "./types";
import type { AgentAuditSink, AgentIdempotencyStore } from "./executor";

export class InMemoryIdempotencyStore implements AgentIdempotencyStore {
  private readonly store = new Map<string, AgentActionResult>();

  async get(key: string): Promise<AgentActionResult | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: AgentActionResult): Promise<void> {
    this.store.set(key, value);
  }
}

export class InMemoryAuditSink implements AgentAuditSink {
  private readonly events: AgentAuditEvent[] = [];

  async record(event: AgentAuditEvent): Promise<void> {
    this.events.push(event);
  }

  list(options?: { status?: AgentAuditEventStatus }): AgentAuditEvent[] {
    if (!options?.status) {
      return [...this.events];
    }
    return this.events.filter((event) => event.status === options.status);
  }
}

