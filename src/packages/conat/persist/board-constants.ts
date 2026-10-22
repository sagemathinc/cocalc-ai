/*
Board write service names and transport limits. No Node imports: this module
is also bundled for the browser (via the persist load balancer). The policy
itself is in board-policy.ts.
*/

import type { ReceiveLimits } from "@cocalc/conat/core/receive-budget";

export const BOARD_WRITE_SERVICE = "persist-board-write";
// The only user segment the board write service serves.
export const BOARD_WRITE_USER = "hub";

// Transport bounds for the board write service's data subscription. Raw
// fragments are counted before reassembly, so nothing larger than one snapshot
// message (at most 7 MiB encoded, plus envelope) is ever assembled, and a
// stalled or flooding writer holds at most 16 MiB. The process-wide aggregate
// in receive-budget.ts applies on top.
export const BOARD_WRITE_RECEIVE_LIMITS: ReceiveLimits = {
  maxMessageBytes: 8 * 1024 * 1024,
  maxInflightBytes: 16 * 1024 * 1024,
  maxInflightMessages: 8,
};

// Status pings and load-balancer lookups carry no data.
export const BOARD_WRITE_CONTROL_RECEIVE_LIMITS: ReceiveLimits = {
  maxMessageBytes: 64 * 1024,
  maxInflightBytes: 1024 * 1024,
  maxInflightMessages: 64,
};
