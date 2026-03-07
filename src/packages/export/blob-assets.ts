import { createHash } from "node:crypto";
import path from "node:path";
import { posix as pathPosix } from "node:path";

import type { ExportAsset } from "./bundle";

export interface ExportAssetIndexEntry {
  originalRef: string;
  path: string;
  sha256: string;
  contentType?: string;
}

export interface BlobReference {
  originalRef: string;
  fetchUrl: string;
  filename: string;
}

const BLOB_MARKDOWN = /!\[[^\]]*\]\(((?:https?:\/\/[^)]+)?\/blobs\/[^)]+)\)/gi;
const BLOB_HTML = /<img[^>]+src=["']((?:https?:\/\/[^"']+)?\/blobs\/[^"']+)["'][^>]*>/gi;

export async function collectReferencedAssets({
  contents,
  blobBaseUrl,
  blobBearerToken,
}: {
  contents: Iterable<string | undefined>;
  blobBaseUrl?: string;
  blobBearerToken?: string;
}): Promise<{
  assets: ExportAsset[];
  index: ExportAssetIndexEntry[];
  byOriginalRef: Map<string, ExportAssetIndexEntry>;
}> {
  const discovered = new Map<string, BlobReference>();
  for (const content of contents) {
    for (const ref of extractBlobReferences(content, blobBaseUrl)) {
      discovered.set(ref.originalRef, ref);
    }
  }
  const byOriginalRef = new Map<string, ExportAssetIndexEntry>();
  const byPath = new Map<string, ExportAsset>();
  for (const ref of Array.from(discovered.values()).sort((a, b) =>
    a.originalRef.localeCompare(b.originalRef),
  )) {
    const fetched = await fetchBlobAsset(ref, blobBearerToken);
    if (!byPath.has(fetched.path)) {
      byPath.set(fetched.path, fetched);
    }
    const asset = byPath.get(fetched.path)!;
    byOriginalRef.set(ref.originalRef, {
      originalRef: ref.originalRef,
      path: asset.path,
      sha256: asset.sha256,
      contentType: asset.contentType,
    });
  }
  return {
    assets: Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path)),
    index: Array.from(byOriginalRef.values()).sort((a, b) =>
      a.originalRef.localeCompare(b.originalRef),
    ),
    byOriginalRef,
  };
}

export function buildRelativeBlobReplacementMap(
  filePath: string,
  assetRefs: ExportAssetIndexEntry[] | undefined,
): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const asset of assetRefs ?? []) {
    const rel = pathPosix.relative(pathPosix.dirname(filePath), asset.path) || ".";
    replacements.set(asset.originalRef, rel);
  }
  return replacements;
}

export function rewriteBlobRefs(content: string, replacements: Map<string, string>): string {
  let next = `${content ?? ""}`;
  for (const [original, replacement] of replacements.entries()) {
    next = next.split(original).join(replacement);
  }
  return next;
}

export function extractBlobReferences(
  content: string | undefined,
  blobBaseUrl?: string,
): BlobReference[] {
  const text = `${content ?? ""}`.trim();
  if (!text) return [];
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = BLOB_MARKDOWN.exec(text)) != null) {
    urls.add(match[1]);
  }
  while ((match = BLOB_HTML.exec(text)) != null) {
    urls.add(match[1]);
  }
  BLOB_MARKDOWN.lastIndex = 0;
  BLOB_HTML.lastIndex = 0;
  return Array.from(urls)
    .map((target) => parseBlobReference(target, blobBaseUrl))
    .filter((value): value is BlobReference => !!value);
}

function parseBlobReference(
  target: string,
  blobBaseUrl?: string,
): BlobReference | undefined {
  const trimmed = `${target ?? ""}`.trim();
  if (!trimmed) return undefined;
  const absolute = trimmed.startsWith("http://") || trimmed.startsWith("https://");
  if (!absolute && !blobBaseUrl) {
    throw new Error(
      `relative blob reference requires --blob-base-url/COCALC_API_URL: ${trimmed}`,
    );
  }
  const parsed = new URL(trimmed, absolute ? undefined : blobBaseUrl);
  if (!parsed.pathname.includes("/blobs/")) return undefined;
  const uuid = parsed.searchParams.get("uuid")?.trim();
  if (!uuid) return undefined;
  const filename = path.basename(parsed.pathname) || `${uuid}.bin`;
  return {
    originalRef: trimmed,
    fetchUrl: parsed.toString(),
    filename,
  };
}

async function fetchBlobAsset(
  ref: BlobReference,
  bearerToken?: string,
): Promise<ExportAsset> {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const response = await fetch(ref.fetchUrl, { headers });
  if (!response.ok) {
    throw new Error(`failed to fetch blob ${ref.originalRef}: HTTP ${response.status}`);
  }
  const content = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(content).digest("hex");
  const headerContentType = normalizeContentType(response.headers.get("content-type"));
  const sniffed = sniffBlobType(content);
  const contentType =
    headerContentType && headerContentType !== "application/octet-stream"
      ? headerContentType
      : sniffed.contentType;
  const ext =
    sanitizeExtension(path.extname(ref.filename)) ||
    extensionForContentType(contentType) ||
    sniffed.extension ||
    ".bin";
  return {
    originalRef: ref.originalRef,
    path: `assets/${sha256}${ext}`,
    sha256,
    contentType,
    content,
  };
}

function sanitizeExtension(ext: string): string {
  const trimmed = `${ext ?? ""}`.trim().toLowerCase();
  if (!trimmed) return "";
  return /^[.][a-z0-9._-]+$/.test(trimmed) && /[a-z]/.test(trimmed) ? trimmed : "";
}

function normalizeContentType(contentType: string | null | undefined): string | undefined {
  const normalized = `${contentType ?? ""}`.trim().toLowerCase();
  if (!normalized) return undefined;
  const head = normalized.split(";")[0]?.trim();
  return head || undefined;
}

function extensionForContentType(contentType: string | undefined): string {
  switch (contentType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    case "image/svg+xml":
      return ".svg";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

function sniffBlobType(content: Uint8Array): { contentType?: string; extension?: string } {
  if (
    content.length >= 8 &&
    content[0] === 0x89 &&
    content[1] === 0x50 &&
    content[2] === 0x4e &&
    content[3] === 0x47 &&
    content[4] === 0x0d &&
    content[5] === 0x0a &&
    content[6] === 0x1a &&
    content[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: ".png" };
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return { contentType: "image/jpeg", extension: ".jpg" };
  }
  if (content.length >= 6) {
    const prefix = new TextDecoder("ascii").decode(content.slice(0, 12));
    if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) {
      return { contentType: "image/gif", extension: ".gif" };
    }
    if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
      return { contentType: "image/webp", extension: ".webp" };
    }
    if (prefix.startsWith("%PDF-")) {
      return { contentType: "application/pdf", extension: ".pdf" };
    }
  }
  return {};
}
