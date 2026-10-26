/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Saving the files sent with an external-agent inbox message: fetched one at
// a time (each at most 32 MiB), checked against the sender's SHA-256, and
// written without ever replacing an existing file.

import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExternalAgentInboxAttachment } from "@cocalc/conat/agents/external";

export interface SavedInboxAttachment {
  name: string;
  size: number;
  sha256: string;
  path: string;
}

export async function saveInboxAttachments({
  message_id,
  dir,
  fetch,
}: {
  message_id: string;
  dir: string;
  fetch: (index: number) => Promise<ExternalAgentInboxAttachment>;
}): Promise<{
  message_id: string;
  dir: string;
  files: SavedInboxAttachment[];
}> {
  const target = resolve(dir);
  const files: SavedInboxAttachment[] = [];
  let count = 1;
  for (let index = 0; index < count; index++) {
    const file = await fetch(index);
    if (file.message_id !== message_id || file.index !== index)
      throw new Error("the inbox returned a different attachment");
    count = file.count;
    const data = file.data;
    if (
      data.byteLength !== file.size ||
      createHash("sha256").update(data).digest("hex") !== file.sha256
    )
      throw new Error(
        `attachment ${JSON.stringify(file.name)} does not match its SHA-256; nothing more was saved`,
      );
    // Names come without paths; never write outside the directory.
    if (basename(file.name) !== file.name || file.name.startsWith("."))
      throw new Error(`refusing attachment name ${JSON.stringify(file.name)}`);
    await mkdir(target, { recursive: true });
    const path = join(target, file.name);
    // "wx": fails if the file exists, so nothing is overwritten.
    const handle = await open(path, "wx").catch((err) => {
      throw err?.code === "EEXIST"
        ? new Error(`${path} exists; choose another --dir`)
        : err;
    });
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    files.push({ name: file.name, size: file.size, sha256: file.sha256, path });
  }
  return { message_id, dir: target, files };
}
