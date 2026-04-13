/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { PostgreSQL } from "../types";
import { touchAccount } from "../account/management";
import { appendProjectOutboxEventForProject } from "../project-events-outbox";

export interface TouchProjectOptions {
  project_id: string;
}

export interface TouchOptions {
  account_id: string;
  project_id?: string;
  path?: string;
  action?: string;
  ttl_s?: number;
}

/**
 * Internal method: Update project's last_edited timestamp and track account activity.
 * Uses throttling to prevent excessive database updates (60 second window per project/account pair).
 *
 * This method:
 * - Updates the project's last_edited field to NOW()
 * - Adds/updates the account_id entry in the project's last_active JSONB field
 * - Throttles duplicate calls within 60 seconds for same project_id + account_id combination
 *
 * @param db - PostgreSQL database instance
 * @param project_id - UUID of the project to touch
 * @param account_id - UUID of the account performing the activity
 */
export async function touchProjectInternal(
  db: PostgreSQL,
  project_id: string,
  account_id: string,
): Promise<void> {
  // Check throttle - if we touched this project/account pair in last 60 seconds, skip
  if (db._throttle("_user_touch_project", 60, project_id, account_id)) {
    return;
  }

  const NOW = new Date();

  await db.async_query({
    query: "UPDATE projects",
    set: { last_edited: NOW },
    jsonb_merge: { last_active: { [account_id]: NOW } },
    where: { "project_id = $::UUID": project_id },
  });
  await appendProjectOutboxEventForProject({
    event_type: "project.summary_changed",
    project_id,
  });
}

/**
 * Public method: Update project's last_edited timestamp without account tracking.
 * Uses throttling to prevent excessive database updates (30 second window per project).
 *
 * This is a simpler version of touchProjectInternal that only updates last_edited,
 * without tracking which account performed the activity.
 *
 * @param db - PostgreSQL database instance
 * @param opts - Options with project_id
 */
export async function touchProject(
  db: PostgreSQL,
  opts: TouchProjectOptions,
): Promise<void> {
  // Check throttle - if we touched this project in last 30 seconds, skip
  if (db._throttle("touch_project", 30, opts.project_id)) {
    return;
  }

  await db.async_query({
    query: "UPDATE projects",
    set: { last_edited: "NOW()" },
    where: { "project_id = $::UUID": opts.project_id },
  });
  await appendProjectOutboxEventForProject({
    event_type: "project.summary_changed",
    project_id: opts.project_id,
  });
}

/**
 * Indicate activity by a user, possibly on a specific project, and possibly on a specific path.
 *
 * This high-level orchestration method coordinates multiple activity tracking operations:
 * - Always touches the account (updates last_active)
 * - If project_id provided, touches the project (updates last_edited and last_active)
 * - `path` and `action` are accepted for compatibility with older callers, but
 *   file-level activity is now tracked directly on the project host.
 *
 * The method uses throttling to ensure efficient database updates. By default, duplicate
 * account/project updates within 50 seconds are ignored (configurable via ttl_s).
 *
 * @param db - PostgreSQL database instance
 * @param opts - Activity tracking options
 * @param opts.account_id - UUID of the account performing the activity (required)
 * @param opts.project_id - UUID of the project (optional)
 * @param opts.path - File path within the project (optional, requires project_id)
 * @param opts.action - Type of file action: 'edit', 'read', or 'chat' (default: 'edit')
 * @param opts.ttl_s - Throttle window in seconds (default: 50)
 *
 * @example
 * // Touch account only
 * await touch(db, { account_id: uuid() });
 *
 * @example
 * // Touch account and project
 * await touch(db, { account_id: uuid(), project_id: uuid() });
 *
 * @example
 * // Touch account and project while carrying a path for compatibility
 * await touch(db, {
 *   account_id: uuid(),
 *   project_id: uuid(),
 *   path: 'notebooks/analysis.ipynb',
 *   action: 'edit'
 * });
 */
export async function touch(db: PostgreSQL, opts: TouchOptions): Promise<void> {
  const ttl_s = opts.ttl_s ?? 50;

  // Check throttle if ttl_s is set
  if (ttl_s) {
    if (db._throttle("touch", ttl_s, opts.account_id, opts.project_id)) {
      return;
    }
  }

  // Execute all touches in parallel for performance
  const promises: Promise<void>[] = [];

  // Always touch the account
  promises.push(touchAccount(db, opts.account_id));

  // Touch project if provided
  if (opts.project_id != null) {
    promises.push(touchProjectInternal(db, opts.project_id, opts.account_id));
  }

  await Promise.all(promises);
}
