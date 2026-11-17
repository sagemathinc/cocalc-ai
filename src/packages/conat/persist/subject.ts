/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The persist service's name and subjects, for clients and servers alike.
// Kept apart from util.ts, which opens storage: the browser bundles the
// persist client, and must not bundle the server's storage (sqlite) code.

export const SERVICE = "persist";

export type User = {
  account_id?: string;
  project_id?: string;
  hub_id?: string;
  host_id?: string;
};

export function persistSubject({
  account_id,
  project_id,
  host_id,
  service = SERVICE,
}: User & { service?: string }) {
  if (account_id) {
    return `${service}.account-${account_id}`;
  } else if (project_id) {
    return `${service}.project-${project_id}`;
  } else if (host_id) {
    return `${service}.host-${host_id}`;
  } else {
    return `${service}.hub`;
  }
}
