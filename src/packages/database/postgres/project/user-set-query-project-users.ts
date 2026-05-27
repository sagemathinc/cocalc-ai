/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  assert_valid_account_id,
  is_object,
  is_valid_uuid_string,
} from "@cocalc/util/misc";
import {
  isProjectUserRole,
  type ProjectUserRole,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";

type AllowedUserFields = {
  group?: ProjectUserRole;
  hide?: boolean;
  ssh_keys?: Record<string, Record<string, unknown> | undefined>;
  read_policy?: ProjectViewerReadPolicy;
};

function ensureAllowedKeys(
  user: Record<string, unknown>,
  allowGroupChanges: boolean,
): void {
  const allowed = new Set(["hide", "ssh_keys", "read_policy"]);
  for (const key of Object.keys(user)) {
    if (key === "group") {
      if (!allowGroupChanges) {
        throw Error(
          "changing collaborator group via user_set_query is not allowed",
        );
      }
      continue;
    }
    if (!allowed.has(key)) {
      throw Error(`unknown field '${key}'`);
    }
  }
}

function sanitizeViewerReadPolicy(
  read_policy: unknown,
): ProjectViewerReadPolicy {
  if (!is_object(read_policy)) {
    throw Error("read_policy must be an object");
  }
  const rules = (read_policy as any).rules;
  if (!Array.isArray(rules)) {
    throw Error("read_policy.rules must be an array");
  }
  return {
    rules: rules.map((rule, index) => {
      if (!is_object(rule)) {
        throw Error(`read_policy.rules[${index}] must be an object`);
      }
      const action = `${(rule as any).action ?? ""}`;
      if (action !== "include" && action !== "exclude") {
        throw Error(
          `read_policy.rules[${index}].action must be 'include' or 'exclude'`,
        );
      }
      const path = `${(rule as any).path ?? ""}`.trim();
      if (!path) {
        throw Error(`read_policy.rules[${index}].path must be nonempty`);
      }
      return { action, path };
    }),
  };
}

function sanitizeSshKeys(
  ssh_keys: unknown,
): Record<string, Record<string, unknown> | undefined> {
  if (!is_object(ssh_keys)) {
    throw Error("ssh_keys must be an object");
  }
  const sanitized: Record<string, Record<string, unknown> | undefined> = {};
  for (const fingerprint of Object.keys(ssh_keys)) {
    const key = (ssh_keys as Record<string, unknown>)[fingerprint];
    if (!key) {
      sanitized[fingerprint] = undefined;
      continue;
    }
    if (!is_object(key)) {
      throw Error("each key in ssh_keys must be an object");
    }
    for (const field of Object.keys(key)) {
      if (
        !["title", "value", "creation_date", "last_use_date"].includes(field)
      ) {
        throw Error(`invalid ssh_keys field '${field}'`);
      }
    }
    sanitized[fingerprint] = key as Record<string, unknown>;
  }
  return sanitized;
}

/**
 * Sanitize and security-check project user mutations submitted via user set query.
 *
 * Only permits modifying the requesting user's own entry (hide/ssh_keys).
 * Collaborator role changes must use dedicated APIs that enforce ownership rules.
 */
export function sanitizeUserSetQueryProjectUsers(
  obj: { users?: unknown } | undefined,
  account_id?: string,
): Record<string, AllowedUserFields> | undefined {
  if (obj?.users == null) {
    return undefined;
  }
  if (account_id != null) {
    assert_valid_account_id(account_id);
  }
  if (!is_object(obj.users)) {
    throw Error("users must be an object");
  }

  const sanitized: Record<string, AllowedUserFields> = {};
  const usersInput = obj.users as Record<string, unknown>;

  for (const id of Object.keys(usersInput)) {
    if (!is_valid_uuid_string(id)) {
      throw Error(`invalid account_id '${id}'`);
    }
    const user = usersInput[id];
    if (!is_object(user)) {
      throw Error("user entry must be an object");
    }

    const isSelf = account_id == null || id === account_id;
    ensureAllowedKeys(user as Record<string, unknown>, account_id == null);

    const entry: AllowedUserFields = {};
    if ("group" in user) {
      if (account_id != null) {
        throw Error(
          "changing collaborator group via user_set_query is not allowed",
        );
      }
      const group = `${(user as any).group ?? ""}`;
      if (!isProjectUserRole(group)) {
        throw Error(
          `invalid group value '${group}' - must be 'owner', 'collaborator', or 'viewer'`,
        );
      }
      entry.group = group;
    }
    if ("read_policy" in user) {
      if (account_id != null) {
        throw Error(
          "changing viewer read_policy via user_set_query is not allowed",
        );
      }
      entry.read_policy = sanitizeViewerReadPolicy((user as any).read_policy);
    }
    if ("hide" in user) {
      if (typeof (user as any).hide !== "boolean") {
        throw Error("invalid type for field 'hide'");
      }
      entry.hide = (user as any).hide;
    }
    if ("ssh_keys" in user) {
      if (!isSelf) {
        throw Error(
          "users set queries may only change ssh_keys for the requesting account",
        );
      }
      entry.ssh_keys = sanitizeSshKeys((user as any).ssh_keys);
    }
    sanitized[id] = entry;
  }

  return sanitized;
}
