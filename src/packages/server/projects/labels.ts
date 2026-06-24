/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { withProjectRehomeWriteFence } from "@cocalc/database/postgres/project-rehome-fence";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { isValidUUID } from "@cocalc/util/misc";

export type ProjectLabels = Record<string, string>;
export type ProjectLabelPatch = Record<string, string | null | undefined>;

const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_LABEL_VALUE_LENGTH = 512;

function normalizeProjectId(project_id: string): string {
  const value = `${project_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw Error(`invalid project id '${project_id ?? ""}'`);
  }
  return value;
}

function normalizeAccountId(account_id?: string | null): string | null {
  const value = `${account_id ?? ""}`.trim();
  if (!value) return null;
  if (!isValidUUID(value)) {
    throw Error(`invalid account id '${account_id ?? ""}'`);
  }
  return value;
}

function normalizeLabelKey(key: string): string {
  const value = `${key ?? ""}`.trim();
  if (!LABEL_KEY_RE.test(value)) {
    throw Error(
      `invalid project label key '${key}'; expected 1-128 characters using letters, digits, '.', '_', '-', or '/'`,
    );
  }
  return value;
}

function normalizeLabelValue(value: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (normalized.length > MAX_LABEL_VALUE_LENGTH) {
    throw Error(
      `project label values must be at most ${MAX_LABEL_VALUE_LENGTH} characters`,
    );
  }
  return normalized;
}

export function normalizeProjectLabelPatch(
  labels: ProjectLabelPatch,
): ProjectLabelPatch {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw Error("labels must be an object");
  }
  const normalized: ProjectLabelPatch = {};
  for (const [rawKey, rawValue] of Object.entries(labels)) {
    const key = normalizeLabelKey(rawKey);
    normalized[key] =
      rawValue == null ? null : normalizeLabelValue(`${rawValue}`);
  }
  return normalized;
}

export async function getProjectLabels(opts: {
  project_id: string;
  db?: PoolClient;
}): Promise<ProjectLabels> {
  const project_id = normalizeProjectId(opts.project_id);
  const db = opts.db ?? getPool();
  const { rows } = await db.query<{ key: string; value: string }>(
    `SELECT key, value
       FROM project_labels
      WHERE project_id = $1
      ORDER BY key ASC`,
    [project_id],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function setProjectLabels(opts: {
  project_id: string;
  labels: ProjectLabelPatch;
  account_id?: string | null;
}): Promise<ProjectLabels> {
  const project_id = normalizeProjectId(opts.project_id);
  const account_id = normalizeAccountId(opts.account_id);
  const labels = normalizeProjectLabelPatch(opts.labels);

  await withProjectRehomeWriteFence({
    project_id,
    action: "set project labels",
    fn: async (db) => {
      for (const [key, value] of Object.entries(labels)) {
        if (value == null) {
          await db.query(
            `DELETE FROM project_labels
              WHERE project_id = $1
                AND key = $2`,
            [project_id, key],
          );
          continue;
        }
        await db.query(
          `INSERT INTO project_labels
             (project_id, key, value, created_by, updated_by, created_at, updated_at)
           VALUES
             ($1, $2, $3, $4, $4, NOW(), NOW())
           ON CONFLICT (project_id, key)
           DO UPDATE SET
             value = EXCLUDED.value,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
          [project_id, key, value, account_id],
        );
      }
      await appendProjectOutboxEventForProject({
        db,
        event_type: "project.summary_changed",
        project_id,
      });
    },
  });

  await publishProjectAccountFeedEventsBestEffort({ project_id });
  return await getProjectLabels({ project_id });
}
