/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type FilesystemClient } from "@cocalc/conat/files/fs";

export function isRecoverableFilesystemClientError(err: unknown): boolean {
  const message = `${err}`.toLowerCase();
  return (
    message.includes("closed") ||
    message.includes("disconnected") ||
    message.includes("connection closed") ||
    message.includes("socket has been disconnected") ||
    message.includes("not connected") ||
    message.includes("file server not initialized") ||
    message.includes("unable to route") ||
    message.includes("project-host") ||
    message.includes("project host")
  );
}

export async function callFilesystemClientWithRecovery({
  getClient,
  clearClient,
  prop,
  args,
}: {
  getClient: (forceRefresh?: boolean) => Promise<FilesystemClient>;
  clearClient: () => void;
  prop: PropertyKey;
  args: any[];
}) {
  let forceRefresh = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fs = await getClient(forceRefresh);
      const value = (fs as any)[prop];
      if (typeof value !== "function") {
        return value;
      }
      return await value.apply(fs, args);
    } catch (err) {
      if (attempt === 0 && isRecoverableFilesystemClientError(err)) {
        forceRefresh = true;
        clearClient();
        continue;
      }
      throw err;
    }
  }
}
