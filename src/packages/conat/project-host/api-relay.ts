/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Admission to the transport is separate from upstream API authentication.
// These headers must never be forwarded to the hub or destination host.
export const API_RELAY_PATH = "/_cocalc/api-relay";
export const API_RELAY_PROJECT_HEADER = "x-cocalc-relay-project";
export const API_RELAY_SECRET_HEADER = "x-cocalc-relay-secret";
export const API_RELAY_HUB_HEADER = "x-cocalc-relay-hub";

// A requested hub is only a lookup key; the host must match it against trusted
// site/bay configuration before opening any connection.
export function normalizeApiRelayHubUrl(value: string): string {
  const url = new URL(value);
  if (
    value.length > 2048 ||
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(url.pathname)
  ) {
    throw Error("invalid API relay hub URL");
  }
  return url.toString().replace(/\/$/, "");
}

export interface ProjectApiRelayTarget {
  host_id: string;
  project_id: string;
  // Resolved by the owning bay, never supplied by the project making a request.
  url: string;
}

// Host-issued cumulative usage updates. Sequence numbers make retries safe
// when a reply is lost after the account's home bay commits a reservation.
export interface ApiRelayUsageRequest {
  project_id: string;
  session_id: string;
  started_at: number; // Host timestamp fences initial retries after lease GC.
  sequence: number;
  sent: number;
  received: number;
  transport: "http" | "websocket";
  target: string;
  close?: boolean;
  reason?: string;
}

export interface ApiRelayAllowance {
  account_id: string;
  allowance: number;
  expires_at: number;
}
