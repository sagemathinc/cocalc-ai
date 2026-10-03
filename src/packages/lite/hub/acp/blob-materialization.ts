import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AcpImageAttachment } from "@cocalc/ai/acp/types";
import { ACP_MAX_IMAGE_BYTES } from "@cocalc/util/ai/harness-limits";

const CHAT_BLOB_TEMP_RELATIVE_PATH = ".local/share/cocalc/tmp";
// Pasted images kept for agents beyond one turn (attach to a PR, compare with
// a screenshot, keep as a fixture). Named by blob UUID, so repeats reuse a file.
const CHAT_ATTACHMENTS_RELATIVE_PATH = ".local/share/cocalc/chat-attachments";
export const CHAT_ATTACHMENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BLOB_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]+$/i;

export type BlobReference = {
  url: string;
  uuid: string;
  filename?: string;
};

export type MaterializedBlobAttachment = {
  ref: BlobReference;
  path: string;
};

export function acpImageAttachment(data: Buffer): AcpImageAttachment {
  const mimeType = data
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? "image/jpeg"
      : data.subarray(0, 6).toString("ascii") === "GIF87a" ||
          data.subarray(0, 6).toString("ascii") === "GIF89a"
        ? "image/gif"
        : data.subarray(0, 4).toString("ascii") === "RIFF" &&
            data.subarray(8, 12).toString("ascii") === "WEBP"
          ? "image/webp"
          : undefined;
  if (!mimeType || data.byteLength > ACP_MAX_IMAGE_BYTES)
    throw Error(
      "ACP attachment must be a PNG, JPEG, GIF or WebP image up to 5 MiB",
    );
  return { mimeType, data: data.toString("base64") };
}

export function projectBlobMaterializationRoots({
  hostProjectRoot,
  runtimeProjectRoot,
}: {
  hostProjectRoot: string;
  runtimeProjectRoot: string;
}): {
  host: string;
  runtime: string;
  attachments: { host: string; runtime: string };
  project: { host: string; runtime: string };
} {
  return {
    project: { host: hostProjectRoot, runtime: runtimeProjectRoot },
    host: path.join(hostProjectRoot, CHAT_BLOB_TEMP_RELATIVE_PATH),
    runtime: path.posix.join(runtimeProjectRoot, CHAT_BLOB_TEMP_RELATIVE_PATH),
    attachments: {
      host: path.join(hostProjectRoot, CHAT_ATTACHMENTS_RELATIVE_PATH),
      runtime: path.posix.join(
        runtimeProjectRoot,
        CHAT_ATTACHMENTS_RELATIVE_PATH,
      ),
    },
  };
}

// Tells a harness agent where its attached images are saved in the project;
// labels match rewriteBlobReferencesInPrompt.
export function harnessAttachmentNote(
  attachments: readonly MaterializedBlobAttachment[],
): string {
  if (!attachments.length) return "";
  const lines = attachments.map(
    (attachment, index) => `[Attached image ${index + 1}]: ${attachment.path}`,
  );
  return `\n\nThe attached images are also saved as files in the project (kept for ${CHAT_ATTACHMENT_MAX_AGE_MS / (24 * 60 * 60 * 1000)} days), so they can be attached to a PR, compared with other images, or used as test fixtures:\n${lines.join("\n")}\n`;
}

// Best-effort removal of saved attachments older than maxAgeMs.
async function pruneChatAttachments(
  directory: FileHandle,
  now = Date.now(),
  maxAgeMs = CHAT_ATTACHMENT_MAX_AGE_MS,
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fs.readdir(descriptorPath(directory));
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!ATTACHMENT_NAME.test(name)) continue;
    const file = path.join(descriptorPath(directory), name);
    try {
      const info = await fs.lstat(file);
      if (info.isFile() && now - info.mtimeMs > maxAgeMs) {
        await fs.rm(file, { force: true });
        removed += 1;
      }
    } catch {
      // Another turn may have removed or replaced it.
    }
  }
  return removed;
}

function descriptorPath(directory: FileHandle): string {
  return `/proc/self/fd/${directory.fd}`;
}

// The project mount is host-controlled, but every directory beneath it is
// project-controlled. Pin each component before using it; realpath/lstat checks
// followed by pathname writes are not a confinement boundary.
export async function openProjectBlobStorage({
  hostProjectRoot,
  runtimeProjectRoot,
  persist,
}: {
  hostProjectRoot: string;
  runtimeProjectRoot: string;
  persist: boolean;
}): Promise<{
  write: (ref: BlobReference, data: Buffer) => Promise<string>;
  finish: () => Promise<void>;
}> {
  if (process.platform !== "linux") {
    throw Error("Confined project attachment storage requires Linux");
  }
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const handles: FileHandle[] = [];
  let temporary: { parent: FileHandle; name: string } | undefined;
  const files = new Set<string>();
  let finished = false;
  const close = async () => {
    for (const handle of handles.reverse()) await handle.close();
  };
  try {
    let directory = await fs.open(hostProjectRoot, flags);
    handles.push(directory);
    const relative = persist
      ? CHAT_ATTACHMENTS_RELATIVE_PATH
      : CHAT_BLOB_TEMP_RELATIVE_PATH;
    for (const component of relative.split("/")) {
      const child = path.join(descriptorPath(directory), component);
      try {
        await fs.mkdir(child, { mode: 0o755 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      directory = await fs.open(child, flags);
      handles.push(directory);
    }
    let runtimeDirectory = path.posix.join(runtimeProjectRoot, relative);
    if (persist) {
      await pruneChatAttachments(directory);
    } else {
      const name = `cocalc-blobs-${randomUUID()}`;
      temporary = { parent: directory, name };
      const child = path.join(descriptorPath(directory), name);
      await fs.mkdir(child, { mode: 0o755 });
      directory = await fs.open(child, flags);
      handles.push(directory);
      runtimeDirectory = path.posix.join(runtimeDirectory, name);
    }
    return {
      write: async (ref, data) => {
        if (finished) throw Error("Attachment storage is closed");
        const name = buildSafeBlobFilename(ref);
        const temporaryName = `.attachment-${randomUUID()}`;
        const temp = path.join(descriptorPath(directory), temporaryName);
        // Exclusive creation and rename never follow a pre-existing file link
        // or truncate a hard-linked target. The parent remains fd-anchored.
        try {
          const file = await fs.open(temp, "wx", 0o644);
          try {
            await file.writeFile(data);
          } finally {
            await file.close();
          }
          await fs.rename(temp, path.join(descriptorPath(directory), name));
          files.add(name);
        } finally {
          await fs.unlink(temp).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          });
        }
        return path.posix.join(runtimeDirectory, name);
      },
      finish: async () => {
        if (finished) return;
        finished = true;
        try {
          if (temporary) {
            for (const name of files) {
              await fs
                .unlink(path.join(descriptorPath(directory), name))
                .catch(() => {});
            }
            // Never recursively remove a project-controlled directory tree.
            await fs
              .rmdir(
                path.join(descriptorPath(temporary.parent), temporary.name),
              )
              .catch(() => {});
          }
        } finally {
          await close();
        }
      },
    };
  } catch (err) {
    try {
      if (temporary) {
        await fs
          .rmdir(path.join(descriptorPath(temporary.parent), temporary.name))
          .catch(() => {});
      }
    } finally {
      await close();
    }
    throw err;
  }
}

const BLOB_MARKDOWN_RE = /!\[[^\]]*\]\(((?:[^)]+)?\/blobs\/[^)]+)\)/gi;
const BLOB_HTML_RE =
  /<img[^>]+src=["']((?:[^"']+)?\/blobs\/[^"']+)["'][^>]*>/gi;

export function dedupeBlobReferences(
  refs: readonly BlobReference[],
): BlobReference[] {
  const seen = new Set<string>();
  const result: BlobReference[] = [];
  for (const ref of refs) {
    if (seen.has(ref.uuid)) continue;
    seen.add(ref.uuid);
    result.push(ref);
  }
  return result;
}

export function buildSafeBlobFilename(ref: BlobReference): string {
  if (!BLOB_UUID.test(ref.uuid)) throw Error("Invalid attachment blob UUID");
  const baseName = sanitizeFilename(ref.filename || ref.uuid);
  const extension = path.extname(baseName);
  const finalName =
    extension.length > 0 ? baseName : `${baseName || ref.uuid}.bin`;
  return `${ref.uuid}-${finalName}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function extractBlobReferences(prompt: string): BlobReference[] {
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = BLOB_MARKDOWN_RE.exec(prompt)) != null) {
    urls.add(match[1]);
  }
  while ((match = BLOB_HTML_RE.exec(prompt)) != null) {
    urls.add(match[1]);
  }
  const refs: BlobReference[] = [];
  for (const url of urls) {
    const parsed = parseBlobReference(url);
    if (parsed?.uuid) {
      refs.push(parsed);
    }
  }
  return refs;
}

export function rewriteBlobReferencesInPrompt(
  prompt: string,
  attachments: readonly MaterializedBlobAttachment[],
): string {
  if (!attachments.length) return prompt;
  const labels = new Map<string, string>();
  for (const [index, attachment] of attachments.entries()) {
    labels.set(attachment.ref.uuid, `[Attached image ${index + 1}]`);
  }
  const replaceReference = (target: string): string | undefined => {
    const ref = parseBlobReference(target);
    if (!ref) return undefined;
    return labels.get(ref.uuid);
  };
  const rewrittenMarkdown = prompt.replace(BLOB_MARKDOWN_RE, (full, target) => {
    return replaceReference(target) ?? full;
  });
  return rewrittenMarkdown.replace(BLOB_HTML_RE, (full, target) => {
    return replaceReference(target) ?? full;
  });
}

function parseBlobReference(target: string): BlobReference | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(
      trimmed,
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? undefined
        : "http://placeholder",
    );
    if (!url.pathname.includes("/blobs/")) {
      return undefined;
    }
    const uuid = url.searchParams.get("uuid");
    if (!uuid) return undefined;
    const filename = path.basename(url.pathname);
    return {
      url: trimmed,
      uuid,
      filename,
    };
  } catch {
    return undefined;
  }
}
