/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import type { ProjectControlCreateRequest } from "@cocalc/conat/inter-bay/api";
import { isValidUUID } from "@cocalc/util/misc";
import type { CreatedProjectBootstrap } from "@cocalc/conat/hub/api/projects";

let schema: Promise<void> | undefined;
export async function ensureProjectCreationReceiptSchema(): Promise<void> {
  schema ??= getPool()
    .query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS creation_request_hash TEXT",
    )
    .then(() => undefined)
    .catch((err) => {
      schema = undefined;
      throw err;
    });
  await schema;
}

export function projectCreationRequestHash(
  request: ProjectControlCreateRequest,
): string {
  if (
    !request.source_bay_id ||
    !isValidUUID(request.operation_id) ||
    !isValidUUID(request.options?.project_id) ||
    !isValidUUID(request.options?.host_id) ||
    !isValidUUID(request.options?.account_id) ||
    request.operation_id !== request.options.project_id ||
    request.options.src_project_id
  ) {
    throw Error("invalid inter-bay project creation request");
  }
  // The allocated project UUID is also the operation identity. Reusing an
  // operation with a different project UUID is invalid, not a second create.
  // Sort object keys recursively; omitted/undefined fields have identical wire semantics.
  const canonical = JSON.stringify(request, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export async function hasProjectCreationReceipt(
  request: ProjectControlCreateRequest,
  hash: string,
  client?: PoolClient,
): Promise<boolean> {
  const { rows } = await (client ?? getPool()).query(
    "SELECT creation_request_hash, deleted, users FROM projects WHERE project_id=$1",
    [request.options.project_id],
  );
  if (!rows[0]) return false;
  if (rows[0].creation_request_hash !== hash) {
    throw Error("project creation request conflicts with existing project");
  }
  if (rows[0].deleted) throw Error("created project has been deleted");
  if (!rows[0].users?.[request.options.account_id]) {
    throw Error("created project is no longer accessible to this account");
  }
  return true;
}

// Serialize the commit, not post-commit host initialization. An exact retry
// can observe the durable result while the first request is still provisioning.
export async function lockProjectCreation(
  client: PoolClient,
  project_id: string,
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `project-create:${project_id}`,
  ]);
}

export async function createWithReconciliation(
  request: ProjectControlCreateRequest,
  destination: {
    create(
      request: ProjectControlCreateRequest,
    ): Promise<CreatedProjectBootstrap>;
    createStatus(
      request: ProjectControlCreateRequest,
    ): Promise<CreatedProjectBootstrap | null>;
  },
): Promise<CreatedProjectBootstrap> {
  try {
    return await destination.create(request);
  } catch (cause) {
    // A failed RPC does not imply that the destination transaction rolled back.
    // This is a read-only reconciliation, never another creation attempt.
    try {
      const committed = await destination.createStatus(request);
      if (committed) return committed;
    } catch {
      // Preserve the allocated identity when even reconciliation is unavailable.
    }
    const error = new Error(
      `Project creation outcome is unknown for ${request.options.project_id} ` +
        `(operation ${request.operation_id}). Check this project before creating another. ` +
        `Original error: ${cause}`,
    );
    Object.assign(error, {
      code: "project_create_unknown",
      project_id: request.options.project_id,
      operation_id: request.operation_id,
    });
    throw error;
  }
}
