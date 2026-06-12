/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { path_split } from "@cocalc/util/misc";

export const TEMPORARY_DOWNLOAD_ARCHIVE_PREFIX = ".cocalc-download-archive-";

export function isTemporaryDownloadArchivePath(path: string): boolean {
  const { head, tail } = path_split(path);
  return head === "/tmp" && tail.startsWith(TEMPORARY_DOWNLOAD_ARCHIVE_PREFIX);
}
