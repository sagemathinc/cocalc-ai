export const AGENT_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
export const AGENT_ATTACHMENT_MAX_FILES = 16;
export const AGENT_ATTACHMENT_PROJECT_BYTES = 256 * 1024 * 1024;
export const AGENT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface AgentFileReference {
  kind: "project-file";
  path: string;
}

export interface AgentSnapshotMetadata {
  name: string;
  size: number;
  sha256: string;
}

export interface AgentSnapshot extends AgentSnapshotMetadata {
  data: Uint8Array;
}

export type AgentAttachments =
  | { kind: "project-files"; files: AgentFileReference[] }
  | { kind: "snapshots"; files: AgentSnapshotMetadata[] };

export class AgentAttachmentError extends Error {
  constructor(
    readonly code:
      | "attachment_limit_exceeded"
      | "attachment_invalid"
      | "attachment_unavailable",
    message: string,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new AgentAttachmentError("attachment_invalid", message);
}

function exactFields(value: object, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    invalid("unexpected attachment field");
}

export function validateAttachmentMetadata(value: AgentAttachments): void {
  if (!value || !["project-files", "snapshots"].includes(value.kind))
    invalid("invalid attachment kind");
  exactFields(value, ["kind", "files"]);
  if (!Array.isArray(value.files) || !value.files.length)
    invalid("attachments must contain files");
  if (value.files.length > AGENT_ATTACHMENT_MAX_FILES)
    throw new AgentAttachmentError(
      "attachment_limit_exceeded",
      "At most 16 attachments may be sent",
    );
  if (value.kind === "project-files") {
    for (const file of value.files) {
      if (
        !file ||
        file.kind !== "project-file" ||
        typeof file.path !== "string" ||
        !file.path.startsWith("/") ||
        file.path.length > 4096 ||
        new TextEncoder().encode(file.path).length > 4096 ||
        /[\x00-\x1f\x7f]/.test(file.path) ||
        file.path.split("/").some((part) => part === ".." || part === ".")
      )
        invalid(
          "attachment references require absolute normalized project paths",
        );
      exactFields(file, ["kind", "path"]);
    }
    return;
  }
  let bytes = 0;
  for (const file of value.files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 255 ||
      new TextEncoder().encode(file.name).length > 255 ||
      /[\\/\x00-\x1f\x7f]/.test(file.name) ||
      file.name === "." ||
      file.name === ".." ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      invalid("invalid attachment manifest");
    exactFields(file, ["name", "size", "sha256"]);
    bytes += file.size;
    if (bytes > AGENT_ATTACHMENT_MAX_BYTES)
      throw new AgentAttachmentError(
        "attachment_limit_exceeded",
        "Attachment content exceeds 32 MiB per message",
      );
  }
}

/** Wire payloads are native MsgPack binary values, never JSON/base64. */
export function validateAttachmentPayload(
  metadata: AgentAttachments,
  files: AgentSnapshot[],
): void {
  validateAttachmentMetadata(metadata);
  if (
    metadata.kind !== "snapshots" ||
    !Array.isArray(files) ||
    files.length !== metadata.files.length
  )
    invalid("attachment payload does not match prepared manifest");
  for (let i = 0; i < files.length; i++) {
    const file = files[i],
      expected = metadata.files[i];
    if (
      !file ||
      !(file.data instanceof Uint8Array) ||
      file.data.byteLength !== expected.size ||
      file.name !== expected.name ||
      file.size !== expected.size ||
      file.sha256 !== expected.sha256
    )
      invalid("attachment payload does not match prepared manifest");
    exactFields(file, ["name", "size", "sha256", "data"]);
  }
}

export function validateAttachmentLocation(
  metadata: AgentAttachments,
  sourceProject: string,
  targetProject: string,
): void {
  validateAttachmentMetadata(metadata);
  if (metadata.kind === "project-files" && sourceProject !== targetProject)
    invalid(
      "project path references cannot cross projects; send snapshots instead",
    );
}
