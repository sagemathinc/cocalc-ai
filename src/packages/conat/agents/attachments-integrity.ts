import { createHash } from "node:crypto";
import {
  AgentAttachmentError,
  validateAttachmentPayload,
  type AgentAttachments,
  type AgentSnapshot,
} from "./attachments";

/** Receiver-side check, before writing any file or admitting execution. */
export function verifyAttachmentPayload(
  metadata: AgentAttachments,
  files: AgentSnapshot[],
): void {
  validateAttachmentPayload(metadata, files);
  for (const file of files) {
    if (createHash("sha256").update(file.data).digest("hex") !== file.sha256)
      throw new AgentAttachmentError(
        "attachment_invalid",
        "Attachment digest does not match its content; no message was submitted",
      );
  }
}
