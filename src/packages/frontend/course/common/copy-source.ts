/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { isPartialUploadName } from "@cocalc/util/partial-upload";

export type CourseDirectoryCopySource = {
  project_id: string;
  path: string | string[];
  base_path?: string;
};

function joinPath(...parts: (string | undefined)[]): string {
  return parts
    .filter((part) => part != null && part !== "")
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

export async function courseDirectoryCopySource({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<CourseDirectoryCopySource> {
  let files: { name: string }[];
  try {
    ({ files } = await webapp_client.project_client.directory_listing({
      project_id,
      path,
      hidden: false,
    }));
  } catch {
    // Let the copy operation below surface the normal missing-path or
    // permission error. This helper should only adjust directory semantics.
    return { project_id, path };
  }
  const visible = files.filter((entry) => !entry.name.startsWith("."));
  // In-flight uploads vanish (renamed) before the copy reads them, which
  // used to fail the whole distribution.
  const childPaths = visible
    .filter((entry) => !isPartialUploadName(entry.name))
    .map((entry) => joinPath(path, entry.name));
  if (childPaths.length) {
    return { project_id, base_path: path, path: childPaths };
  }
  if (visible.length) {
    // Copying the directory itself would pick the in-flight upload back up.
    throw Error(
      `A file is still being uploaded to "${path}". Please try again when the upload finishes.`,
    );
  }
  return { project_id, path };
}
