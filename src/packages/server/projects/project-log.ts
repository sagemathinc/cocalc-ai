/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  PROJECT_LOG_STREAM_NAME,
  type ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";

const logger = getLogger("server:projects:project-log");

export async function appendProjectLogRowBestEffort({
  project_id,
  row,
  fresh,
  context,
}: {
  project_id: string;
  row: ProjectLogRow;
  fresh?: boolean;
  context?: string;
}): Promise<boolean> {
  if (`${row?.project_id ?? ""}`.trim() !== project_id) {
    throw new Error("project log row project_id mismatch");
  }
  try {
    const client = await getExplicitProjectRoutedClient({
      project_id,
      fresh,
    });
    const stream = await client.sync.dstream<ProjectLogRow>({
      project_id,
      name: PROJECT_LOG_STREAM_NAME,
      noAutosave: true,
      noCache: true,
      noInventory: true,
    });
    try {
      const existing = new Set(
        ((stream.getAll?.() as ProjectLogRow[] | undefined) ?? []).map(
          ({ id }) => id,
        ),
      );
      if (existing.has(row.id)) {
        return false;
      }
      stream.publish(row);
      await stream.save();
      return true;
    } finally {
      stream.close();
    }
  } catch (err) {
    logger.warn("failed to append project log row", {
      project_id,
      row_id: row.id,
      context,
      err,
    });
    return false;
  }
}
