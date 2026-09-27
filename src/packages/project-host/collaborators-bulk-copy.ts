/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { CopyOptions } from "@cocalc/conat/files/fs";
import { journalCollaborationFilesystem } from "@cocalc/backend/collaborators/filesystem";
import { getCollaboratorsService } from "./collaborators";
import { withArtifactCatalog } from "./artifact-catalog";

/** Keep bulk/staged/reflink I/O intact, but journal its final project locators. */
export async function journalSameProjectBulkCopy({
  fs,
  project_id,
  source,
  destination,
  options,
  copy,
}: {
  fs: SandboxedFilesystem;
  project_id: string;
  source: string | string[];
  destination: string;
  options?: CopyOptions;
  copy(): Promise<void>;
}): Promise<void> {
  let service: ReturnType<typeof getCollaboratorsService>;
  try {
    service = getCollaboratorsService();
  } catch {
    return copy();
  }
  if (!(await service.journal.isEnabled())) return copy();
  // A separate facade avoids replacing the reader's cp or double-journaling
  // temporary staging paths. Only the original bulk operation touches bytes.
  const facade: SandboxedFilesystem = Object.create(fs);
  facade.cp = copy;
  const wrapped = journalCollaborationFilesystem(
    withArtifactCatalog(facade, project_id),
    project_id,
    service.journal,
  );
  await wrapped.cp(source, destination, options);
}
