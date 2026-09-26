/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Admission to the transport is separate from upstream API authentication.
// These headers must never be forwarded to the hub or destination host.
export const API_RELAY_PATH = "/_cocalc/api-relay";
export const API_RELAY_PROJECT_HEADER = "x-cocalc-relay-project";
export const API_RELAY_SECRET_HEADER = "x-cocalc-relay-secret";

export interface ProjectApiRelayTarget {
  host_id: string;
  project_id: string;
  // Resolved by the owning bay, never supplied by the project making a request.
  url: string;
}
