/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "path";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { pastedBlobFilename } from "@cocalc/frontend/editors/slate/upload-utils";

interface UploadBlobImageOptions {
  file: Blob;
  filename?: string;
  projectId?: string;
}

interface UploadBlobImageResult {
  filename: string;
  url: string;
  uuid: string;
}

export async function uploadBlobImage({
  file,
  filename,
  projectId,
}: UploadBlobImageOptions): Promise<UploadBlobImageResult> {
  const resolvedFilename =
    typeof filename === "string" && filename.trim()
      ? filename.trim()
      : pastedBlobFilename(file.type);

  const formData = new FormData();
  formData.append("file", file, resolvedFilename);
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`${join(appBasePath, "blobs")}${query}`, {
    method: "POST",
    body: formData,
    credentials: "include",
  });
  if (!response.ok) {
    const message = await response.text();
    throw Error(message || `HTTP ${response.status}`);
  }
  const { uuid } = await response.json();
  if (!uuid) {
    throw Error("missing upload uuid");
  }
  return {
    filename: resolvedFilename,
    url: `${join(
      appBasePath,
      "blobs",
      encodeURIComponent(resolvedFilename),
    )}?uuid=${uuid}`,
    uuid,
  };
}
