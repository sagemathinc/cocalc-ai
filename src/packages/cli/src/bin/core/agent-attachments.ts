import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_MAX_FILES,
  AgentAttachmentError,
  validateAttachmentMetadata,
  type AgentAttachments,
  type AgentSnapshot,
} from "@cocalc/conat/agents/attachments";

/** Call only after metadata-only destination admission succeeds. */
export async function readAgentAttachmentSnapshots(paths: string[]): Promise<{
  metadata: AgentAttachments;
  files: AgentSnapshot[];
}> {
  if (!paths.length || paths.length > AGENT_ATTACHMENT_MAX_FILES)
    throw new AgentAttachmentError(
      "attachment_limit_exceeded",
      "Select between 1 and 16 attachment files",
    );
  const files: AgentSnapshot[] = [];
  let total = 0;
  for (const path of paths) {
    // No FIFO/device hangs or final-component symlink traversal. Actual reads
    // stay within the declared bound even if a file grows after stat().
    const handle = await open(
      resolve(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile())
        throw new AgentAttachmentError(
          "attachment_invalid",
          "Attachments must be regular files; directories and special files are unsupported",
        );
      if (
        !Number.isSafeInteger(before.size) ||
        before.size > AGENT_ATTACHMENT_MAX_BYTES - total
      )
        throw new AgentAttachmentError(
          "attachment_limit_exceeded",
          "Attachment content exceeds 32 MiB per message",
        );
      const data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
      const after = await handle.stat();
      if (
        offset !== before.size ||
        extra.bytesRead ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new AgentAttachmentError(
          "attachment_unavailable",
          "Attachment changed during snapshot creation; no message was sent",
        );
      total += data.length;
      files.push({
        name: basename(resolve(path)),
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        data,
      });
    } finally {
      await handle.close();
    }
  }
  const metadata: AgentAttachments = {
    kind: "snapshots",
    files: files.map(({ data: _data, ...file }) => file),
  };
  validateAttachmentMetadata(metadata);
  return { metadata, files };
}

export async function readAgentFileReferences(
  paths: string[],
): Promise<AgentAttachments> {
  const metadata: AgentAttachments = {
    kind: "project-files",
    files: paths.map((path) => ({ kind: "project-file", path: resolve(path) })),
  };
  validateAttachmentMetadata(metadata);
  for (const file of metadata.files) {
    const handle = await open(
      file.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await handle.stat()).isFile())
        throw new AgentAttachmentError(
          "attachment_invalid",
          "Attachment reference must identify a regular file",
        );
    } finally {
      await handle.close();
    }
  }
  return metadata;
}
