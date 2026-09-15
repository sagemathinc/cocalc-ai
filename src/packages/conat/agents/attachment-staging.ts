import { randomUUID } from "node:crypto";
import type { Client } from "@cocalc/conat/core/client";
import type { AgentSnapshot, AgentSnapshotMetadata } from "./attachments";
import { verifyAttachmentPayload } from "./attachments-integrity";

type ProjectFilesystem = Pick<
  ReturnType<Client["fs"]>,
  "mkdir" | "writeFile" | "chmod" | "rm"
>;

export interface StagedAgentAttachments {
  directory: string;
  manifest_path: string;
  files: (AgentSnapshotMetadata & { path: string })[];
}

export class AttachmentStagingCleanupError extends Error {
  constructor(
    readonly errors: unknown[],
    directory: string,
  ) {
    super(
      `Attachment staging failed and temporary cleanup failed: ${directory}`,
    );
  }
}

/** Call only after target startup and capacity admission. The supplied FS must
 * be the destination project's sandboxed service, not a privileged host FS.
 * This function neither authorizes a send nor starts an agent. */
export async function stageAgentAttachments(
  fs: ProjectFilesystem,
  metadata: AgentSnapshotMetadata[],
  files: AgentSnapshot[],
): Promise<StagedAgentAttachments> {
  verifyAttachmentPayload({ kind: "snapshots", files: metadata }, files);
  const directory = `/tmp/cocalc-agent-attachments-${randomUUID()}`;
  // No recursive mkdir or reuse: a collision must fail without removing an
  // existing directory. Only clean up after we created this exact directory.
  await fs.mkdir(directory, { mode: 0o700 });
  const result: StagedAgentAttachments = {
    directory,
    manifest_path: `${directory}/manifest.json`,
    files: [],
  };
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Separate numbered directories preserve duplicate basenames, including
      // "manifest.json", and leave the full 255-byte basename allowance intact.
      const parent = `${directory}/${i}`;
      const path = `${parent}/${file.name}`;
      await fs.mkdir(parent, { mode: 0o700 });
      await fs.writeFile(
        path,
        Buffer.from(
          file.data.buffer,
          file.data.byteOffset,
          file.data.byteLength,
        ),
        false,
      );
      await fs.chmod(path, 0o600);
      result.files.push({ ...metadata[i], path });
    }
    await fs.writeFile(
      result.manifest_path,
      JSON.stringify(
        {
          version: 1,
          temporary: true,
          note: "Temporary snapshots. Project restart may remove these files; copy selected files into the project home to retain them.",
          files: result.files,
        },
        null,
        2,
      ),
      false,
    );
    await fs.chmod(result.manifest_path, 0o600);
    return result;
  } catch (error) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AttachmentStagingCleanupError([error, cleanupError], directory);
    }
    throw error;
  }
}

export async function discardAgentAttachments(
  fs: Pick<ProjectFilesystem, "rm">,
  staged: StagedAgentAttachments,
): Promise<void> {
  // Only accept a generated staging root, never arbitrary cleanup paths from
  // the message body or a recipient-edited manifest.
  if (
    !/^\/tmp\/cocalc-agent-attachments-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      staged.directory,
    )
  )
    throw new Error("Invalid attachment staging directory");
  await fs.rm(staged.directory, { recursive: true, force: true });
}
