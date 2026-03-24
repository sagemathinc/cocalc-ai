import path from "node:path";

export type BlobReference = {
  url: string;
  uuid: string;
  filename?: string;
};

export type MaterializedBlobAttachment = {
  ref: BlobReference;
  path: string;
};

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
