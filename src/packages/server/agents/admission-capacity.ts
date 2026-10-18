/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Kept apart from admission-state so it has no database dependency.

export type AgentRpcAdmissionKind = "permit" | "preparation";

export type AgentRpcAdmissionScope = "bay" | "sender" | "recipient";

/** Admission capacity is full; nothing was submitted, so a retry is safe. */
export class AgentRpcCapacityError extends Error {
  constructor(
    readonly scope: AgentRpcAdmissionScope,
    readonly kind: AgentRpcAdmissionKind,
    readonly active: number,
    readonly limit: number,
  ) {
    super(
      scope === "sender"
        ? "agent RPC principal capacity full"
        : scope === "recipient"
          ? "recipient project messaging capacity full"
          : kind === "permit"
            ? "too many in-flight submissions"
            : "attachment preparation capacity full",
    );
    this.name = "AgentRpcCapacityError";
  }

  /** What the sender is told. */
  get reason(): string {
    const what =
      this.kind === "permit" ? "messages" : "attachment preparations";
    const [who, whose] =
      this.scope === "sender"
        ? ["you have too many messages in flight", "from your account"]
        : this.scope === "recipient"
          ? ["the recipient is busy", "to the recipient's project"]
          : ["messaging is busy", "on this server"];
    return `${who} (${this.active} of ${this.limit} ${what} ${whose} are being delivered right now); retry in a few seconds`;
  }
}
