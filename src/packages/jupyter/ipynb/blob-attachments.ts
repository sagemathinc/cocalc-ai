/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuidsha1 } from "@cocalc/backend/misc_node";
import { MAX_BLOB_SIZE } from "@cocalc/util/db-schema/blobs";
import { isValidUUID } from "@cocalc/util/misc";
import { splitSourceLines } from "@cocalc/jupyter/util/misc";

const METADATA_KEY = "blob_attachments";
const METADATA_VERSION = 1;
const MAX_NOTEBOOK_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_NOTEBOOK_ATTACHMENT_COUNT = 4096;

const MIME_PREFERENCE = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
] as const;

type SafeRasterMime = (typeof MIME_PREFERENCE)[number];

interface BlobVariantMetadata {
  uuid: string;
  url: string;
  content_id: string;
}

interface BlobAttachmentEntryMetadata {
  primary_mime: SafeRasterMime;
  variants: Partial<Record<SafeRasterMime, BlobVariantMetadata>>;
}

interface BlobAttachmentMetadata {
  version: 1;
  entries: Record<string, BlobAttachmentEntryMetadata>;
}

export interface LoadedBlob {
  bytes: Buffer;
}

export interface SavedBlob {
  uuid: string;
  url: string;
}

export interface EmbedBlobImagesOptions {
  ipynb: any;
  previousIpynb?: any;
  loadBlob: (uuid: string) => Promise<LoadedBlob | undefined>;
}

export interface ExternalizeAttachmentsOptions {
  ipynb: any;
  loadBlob: (uuid: string) => Promise<LoadedBlob | undefined>;
  saveBlob: (opts: {
    bytes: Buffer;
    content_id: string;
    filename: string;
    media_type: SafeRasterMime;
  }) => Promise<SavedBlob>;
}

interface RasterInfo {
  mediaType: SafeRasterMime;
  extension: string;
}

interface ResolvedVariant extends BlobVariantMetadata {
  media_type: SafeRasterMime;
  base64: string;
  byte_length: number;
}

interface ParsedBlobUrl {
  uuid: string;
  filename: string;
  pathname: string;
  url: string;
}

// The blob URL syntax, for reference and tests only. Never run it over
// notebook text: it backtracks quadratically (see blobUrlMatches).
const GLOBAL_BLOB_URL =
  /(?:https?:\/\/[^/\s"'<>()[\]]+)?\/[^\s"'<>()[\]]*blobs\/[^\s"'<>()[\]]+/gi;
const ATTACHMENT_URL = /attachment:([^\s"'<>()[\]]+)/gi;

interface TextMatch {
  0: string;
  1?: string;
  index: number;
}

// The characters that end a URL in Markdown or HTML, as in GLOBAL_BLOB_URL:
// ECMAScript whitespace and line terminators (exactly regex \s), quotes,
// angle brackets, parentheses and square brackets.
function isUrlDelimiter(code: number): boolean {
  switch (code) {
    case 0x09: // \t
    case 0x0a: // \n
    case 0x0b: // \v
    case 0x0c: // \f
    case 0x0d: // \r
    case 0x20: // space
    case 0x22: // "
    case 0x27: // '
    case 0x28: // (
    case 0x29: // )
    case 0x3c: // <
    case 0x3e: // >
    case 0x5b: // [
    case 0x5d: // ]
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
    case 0xfeff:
      return true;
    default:
      return code >= 0x2000 && code <= 0x200a;
  }
}

const SLASH = 0x2f;

// ASCII-only case-insensitive comparison of text at index with a lowercase
// ASCII literal, as the non-Unicode /i flag does for ASCII letters.
function startsWithAt(text: string, index: number, literal: string): boolean {
  if (index < 0 || index + literal.length > text.length) return false;
  for (let i = 0; i < literal.length; i++) {
    let code = text.charCodeAt(index + i);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    if (code !== literal.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The match of GLOBAL_BLOB_URL in text[start, end), a run with no URL
 * delimiters, or undefined. The pattern's last part extends to the end of the
 * run, so the match is text[p, end) for the leftmost start p at which
 *   - no origin: text[p] is "/" and "blobs/" occurs after p with at least
 *     one character after it; or
 *   - origin: "http://" or "https://" starts at p, followed by at least one
 *     non-"/" host character, a "/" and then such a "blobs/".
 * Let K be the last such "blobs/". The no-origin case holds first at a, the
 * first "/" in the run, iff a < K. An origin start has its "://" slashes at
 * a and a + 1, so it can only be p = a - 6 ("https") or a - 5 ("http"), and
 * it fails whenever a >= K. One pass, no backtracking.
 */
function blobUrlInRun(
  text: string,
  start: number,
  end: number,
): number | undefined {
  let lastBlobs = -1;
  for (let k = end - 7; k >= start; k--) {
    if (startsWithAt(text, k, "blobs/")) {
      lastBlobs = k;
      break;
    }
  }
  if (lastBlobs < 0) return;
  let firstSlash = -1;
  for (let i = start; i < lastBlobs; i++) {
    if (text.charCodeAt(i) === SLASH) {
      firstSlash = i;
      break;
    }
  }
  if (firstSlash < 0) return;
  if (text.charCodeAt(firstSlash + 1) === SLASH) {
    for (const [scheme, offset] of [
      ["https:", 6],
      ["http:", 5],
    ] as const) {
      const p = firstSlash - offset;
      if (p < start || !startsWithAt(text, p, scheme)) continue;
      const host = firstSlash + 2;
      if (host >= end || text.charCodeAt(host) === SLASH) continue;
      let pathSlash = host + 1;
      while (pathSlash < end && text.charCodeAt(pathSlash) !== SLASH) {
        pathSlash += 1;
      }
      if (pathSlash < lastBlobs) return p;
    }
  }
  return firstSlash;
}

/**
 * The CoCalc blob URLs in Markdown text, exactly what
 * text.matchAll(GLOBAL_BLOB_URL) finds, in linear time and without a regular
 * expression.
 *
 * The pattern itself backtracks quadratically on a long run of URL characters
 * with many "/" (an inline base64 image, or crafted input): it retries from
 * every "/" and scans to the end of the run each time. A 2 MB inline image
 * took about 80 seconds of CPU and stalled a whole project host. Every
 * character the pattern can match is a URL-run character and its last part
 * extends to the end of the run, so a match never crosses a run boundary and
 * there is at most one per run: blobUrlInRun finds it directly.
 */
function blobUrlMatches(text: string): TextMatch[] {
  const matches: TextMatch[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isUrlDelimiter(text.charCodeAt(i))) i += 1;
    const start = i;
    while (i < text.length && !isUrlDelimiter(text.charCodeAt(i))) i += 1;
    if (i > start) {
      const p = blobUrlInRun(text, start, i);
      if (p != null) matches.push({ 0: text.slice(p, i), index: p });
    }
  }
  return matches;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeMime(value: unknown): SafeRasterMime | undefined {
  if (typeof value !== "string") return;
  const mime = value.toLowerCase().split(";", 1)[0].trim();
  if (mime === "image/jpg" || mime === "image/pjpeg") {
    return "image/jpeg";
  }
  return MIME_PREFERENCE.includes(mime as SafeRasterMime)
    ? (mime as SafeRasterMime)
    : undefined;
}

function sniffSafeRaster(bytes: Buffer): RasterInfo | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { mediaType: "image/png", extension: "png" };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mediaType: "image/jpeg", extension: "jpg" };
  }
  const signature6 = bytes.subarray(0, 6).toString("ascii");
  if (signature6 === "GIF87a" || signature6 === "GIF89a") {
    return { mediaType: "image/gif", extension: "gif" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mediaType: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") {
    return { mediaType: "image/bmp", extension: "bmp" };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 1 &&
    bytes[3] === 0
  ) {
    return { mediaType: "image/x-icon", extension: "ico" };
  }
  if (
    bytes.length >= 16 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
    /avif|avis/.test(
      bytes.subarray(8, Math.min(bytes.length, 40)).toString("ascii"),
    )
  ) {
    return { mediaType: "image/avif", extension: "avif" };
  }
  return;
}

function decodeBase64(value: unknown, description: string): Buffer {
  const base64 = Array.isArray(value) ? value.join("") : value;
  if (typeof base64 !== "string") {
    throw Error(`${description} is not base64 text`);
  }
  const compact = base64.replace(/\s/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw Error(`${description} has invalid base64 encoding`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length > MAX_BLOB_SIZE) {
    throw Error(
      `${description} is too large (${bytes.length} bytes; max ${MAX_BLOB_SIZE})`,
    );
  }
  return bytes;
}

function validateRaster(
  bytes: Buffer,
  description: string,
  declaredMime?: string,
): RasterInfo {
  const info = sniffSafeRaster(bytes);
  if (info == null) {
    throw Error(`${description} is not a supported safe raster image`);
  }
  if (declaredMime != null && normalizeMime(declaredMime) !== info.mediaType) {
    throw Error(
      `${description} declares ${declaredMime}, but its bytes are ${info.mediaType}`,
    );
  }
  return info;
}

function sourceText(source: unknown): string {
  if (Array.isArray(source)) {
    return source.join("");
  }
  return typeof source === "string" ? source : "";
}

function assertAttachmentReferenceLimit(
  ipynb: any,
  kind: "blob" | "native",
): void {
  let count = 0;
  for (const cell of ipynb?.cells ?? []) {
    if (cell?.cell_type !== "markdown") continue;
    const seen = new Set<string>();
    const regex = new RegExp(ATTACHMENT_URL.source, ATTACHMENT_URL.flags);
    const matches =
      kind === "blob"
        ? blobUrlMatches(sourceText(cell.source))
        : sourceText(cell.source).matchAll(regex);
    for (const match of matches) {
      const key =
        kind === "blob" ? parseBlobUrl(match[0])?.uuid : (match[1] ?? match[0]);
      if (key == null || seen.has(key)) continue;
      seen.add(key);
      count += 1;
      if (count > MAX_NOTEBOOK_ATTACHMENT_COUNT) {
        throw Error(
          `notebook has too many image attachments (max ${MAX_NOTEBOOK_ATTACHMENT_COUNT})`,
        );
      }
    }
  }
}

function setSource(cell: any, source: string): void {
  if (Array.isArray(cell.source)) {
    cell.source = splitSourceLines(source);
  } else {
    cell.source = source;
  }
}

function parseBlobUrl(candidate: string): ParsedBlobUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(candidate, "https://cocalc.invalid");
  } catch {
    return;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const blobIndex = segments.lastIndexOf("blobs");
  if (blobIndex < 0 || blobIndex + 1 >= segments.length) {
    return;
  }
  const uuid = parsed.searchParams.get("uuid") ?? "";
  if (!isValidUUID(uuid)) {
    return;
  }
  let filename = segments.at(-1) ?? "image";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // Keep the encoded filename; it is only a display hint.
  }
  return { uuid, filename, pathname: parsed.pathname, url: candidate };
}

function canonicalBlobUrl(parsed: ParsedBlobUrl): string {
  return `${parsed.pathname}?uuid=${parsed.uuid}`;
}

function metadataForCell(cell: any): BlobAttachmentMetadata | undefined {
  const metadata = cell?.metadata?.cocalc?.[METADATA_KEY];
  if (
    metadata?.version !== METADATA_VERSION ||
    metadata.entries == null ||
    typeof metadata.entries !== "object"
  ) {
    return;
  }
  return metadata as BlobAttachmentMetadata;
}

function isValidVariantMetadata(value: unknown): value is BlobVariantMetadata {
  if (value == null || typeof value !== "object") return false;
  const variant = value as BlobVariantMetadata;
  const parsed =
    typeof variant.url === "string" ? parseBlobUrl(variant.url) : undefined;
  return (
    isValidUUID(variant.uuid) &&
    isValidUUID(variant.content_id) &&
    variant.url.startsWith("/") &&
    !variant.url.startsWith("//") &&
    parsed?.uuid === variant.uuid
  );
}

function isValidEntryMetadata(
  value: unknown,
): value is BlobAttachmentEntryMetadata {
  if (value == null || typeof value !== "object") return false;
  const entry = value as BlobAttachmentEntryMetadata;
  const primaryMime = normalizeMime(entry.primary_mime);
  if (
    primaryMime == null ||
    entry.variants == null ||
    typeof entry.variants !== "object"
  ) {
    return false;
  }
  const variants = Object.entries(entry.variants);
  return (
    variants.length > 0 &&
    variants.every(
      ([mime, variant]) =>
        normalizeMime(mime) === mime && isValidVariantMetadata(variant),
    ) &&
    isValidVariantMetadata(entry.variants[primaryMime])
  );
}

function setCellMetadata(
  cell: any,
  entries: Record<string, BlobAttachmentEntryMetadata>,
): void {
  cell.metadata ??= {};
  cell.metadata.cocalc ??= {};
  if (Object.keys(entries).length === 0) {
    delete cell.metadata.cocalc[METADATA_KEY];
    if (Object.keys(cell.metadata.cocalc).length === 0) {
      delete cell.metadata.cocalc;
    }
    return;
  }
  cell.metadata.cocalc[METADATA_KEY] = {
    version: METADATA_VERSION,
    entries,
  } satisfies BlobAttachmentMetadata;
}

function safeAttachmentName(
  filename: string,
  info: RasterInfo,
  used: Set<string>,
): string {
  const cleaned = filename
    .replace(/[\\/\0-\x1f\x7f]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  const expectedExtensions =
    info.mediaType === "image/jpeg" ? ["jpg", "jpeg"] : [info.extension];
  const currentExtension = cleaned.split(".").at(-1)?.toLowerCase();
  const withExtension = expectedExtensions.includes(currentExtension ?? "")
    ? cleaned
    : `${cleaned || "image"}.${info.extension}`;
  let candidate = withExtension;
  let index = 2;
  while (used.has(candidate)) {
    const dot = withExtension.lastIndexOf(".");
    const stem = dot > 0 ? withExtension.slice(0, dot) : withExtension;
    const extension = dot > 0 ? withExtension.slice(dot) : "";
    candidate = `${stem}-${index++}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function variantFromPreviousNotebook(
  previousIpynb: any,
): Map<string, ResolvedVariant> {
  const variants = new Map<string, ResolvedVariant>();
  for (const cell of previousIpynb?.cells ?? []) {
    const metadata = metadataForCell(cell);
    if (metadata == null || cell.attachments == null) continue;
    for (const [name, entry] of Object.entries(metadata.entries)) {
      if (!isValidEntryMetadata(entry)) continue;
      const bundle = cell.attachments[name];
      if (bundle == null || typeof bundle !== "object") continue;
      for (const [declaredMime, variant] of Object.entries(entry.variants)) {
        if (!isValidVariantMetadata(variant)) continue;
        const mime = normalizeMime(declaredMime);
        if (mime == null || bundle[declaredMime] == null) continue;
        try {
          const bytes = decodeBase64(
            bundle[declaredMime],
            `previous attachment ${name}`,
          );
          validateRaster(bytes, `previous attachment ${name}`, declaredMime);
          if (uuidsha1(bytes) !== variant.content_id) continue;
          variants.set(variant.uuid, {
            ...variant,
            media_type: mime,
            base64: bytes.toString("base64"),
            byte_length: bytes.length,
          });
        } catch {
          // A stale or malformed cache entry must never affect the new save.
        }
      }
    }
  }
  return variants;
}

function findMetadataEntryForUuid(
  metadata: BlobAttachmentMetadata | undefined,
  uuid: string,
): [string, BlobAttachmentEntryMetadata] | undefined {
  if (metadata == null) return;
  return Object.entries(metadata.entries).find(
    ([, entry]) =>
      isValidEntryMetadata(entry) &&
      Object.values(entry.variants).some((variant) => variant?.uuid === uuid),
  );
}

async function replaceAsync(
  source: string,
  find: RegExp | ((source: string) => TextMatch[]),
  replacement: (match: string, captured: string | undefined) => Promise<string>,
): Promise<string> {
  const matches: TextMatch[] =
    typeof find === "function"
      ? find(source)
      : [...source.matchAll(find)].map((match) => ({
          0: match[0],
          1: match[1],
          index: match.index ?? 0,
        }));
  if (matches.length === 0) return source;
  let result = "";
  let offset = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    result += source.slice(offset, index);
    result += await replacement(match[0], match[1]);
    offset = index + match[0].length;
  }
  return result + source.slice(offset);
}

export async function embedCoCalcBlobImages({
  ipynb,
  previousIpynb,
  loadBlob,
}: EmbedBlobImagesOptions): Promise<any> {
  assertAttachmentReferenceLimit(ipynb, "blob");
  const result = deepCopy(ipynb);
  const previous = variantFromPreviousNotebook(previousIpynb);
  const blobLoads = new Map<string, Promise<LoadedBlob | undefined>>();
  const loaded = new Map<string, Promise<ResolvedVariant | undefined>>();
  let totalBytes = 0;
  let attachmentCount = 0;

  const loadAvailableBlob = async (
    uuid: string,
  ): Promise<LoadedBlob | undefined> => {
    let promise = blobLoads.get(uuid);
    if (promise == null) {
      promise = loadBlob(uuid);
      blobLoads.set(uuid, promise);
    }
    return await promise;
  };

  const resolveVariant = async (
    variant: BlobVariantMetadata,
    declaredMime?: string,
  ): Promise<ResolvedVariant | undefined> => {
    const cached = previous.get(variant.uuid);
    if (
      cached != null &&
      cached.content_id === variant.content_id &&
      (declaredMime == null ||
        cached.media_type === normalizeMime(declaredMime))
    ) {
      return cached;
    }
    let promise = loaded.get(variant.uuid);
    if (promise == null) {
      promise = (async () => {
        const blob = await loadAvailableBlob(variant.uuid);
        if (blob == null) {
          return;
        }
        const info = validateRaster(
          blob.bytes,
          `CoCalc image blob ${variant.uuid}`,
          declaredMime,
        );
        const contentId = uuidsha1(blob.bytes);
        if (contentId !== variant.content_id) {
          throw Error(
            `CoCalc image blob ${variant.uuid} has unexpected content`,
          );
        }
        return {
          ...variant,
          media_type: info.mediaType,
          base64: blob.bytes.toString("base64"),
          byte_length: blob.bytes.length,
        };
      })();
      loaded.set(variant.uuid, promise);
    }
    return await promise;
  };

  for (const cell of result.cells ?? []) {
    if (cell?.cell_type !== "markdown") continue;
    const metadata = metadataForCell(cell);
    const used = new Set<string>(Object.keys(cell.attachments ?? {}));
    const namesByUuid = new Map<string, string>();
    const newEntries: Record<string, BlobAttachmentEntryMetadata> = {};
    cell.attachments ??= {};

    const rewritten = await replaceAsync(
      sourceText(cell.source),
      blobUrlMatches,
      async (candidate) => {
        const parsed = parseBlobUrl(candidate);
        if (parsed == null) return candidate;
        const existingName = namesByUuid.get(parsed.uuid);
        if (existingName != null) {
          return `attachment:${encodeURIComponent(existingName)}`;
        }
        attachmentCount += 1;
        if (attachmentCount > MAX_NOTEBOOK_ATTACHMENT_COUNT) {
          throw Error(
            `notebook has too many image attachments (max ${MAX_NOTEBOOK_ATTACHMENT_COUNT})`,
          );
        }

        const mapped = findMetadataEntryForUuid(metadata, parsed.uuid);
        let name = mapped?.[0];
        let entry = mapped?.[1];
        if (entry == null) {
          const blob = await loadAvailableBlob(parsed.uuid);
          if (blob == null) {
            return candidate;
          }
          const info = validateRaster(
            blob.bytes,
            `CoCalc image blob ${parsed.uuid}`,
          );
          totalBytes += blob.bytes.length;
          if (totalBytes > MAX_NOTEBOOK_ATTACHMENT_BYTES) {
            throw Error(
              `notebook image attachments exceed ${MAX_NOTEBOOK_ATTACHMENT_BYTES} bytes`,
            );
          }
          const contentId = uuidsha1(blob.bytes);
          name = safeAttachmentName(parsed.filename, info, used);
          entry = {
            primary_mime: info.mediaType,
            variants: {
              [info.mediaType]: {
                uuid: parsed.uuid,
                url: canonicalBlobUrl(parsed),
                content_id: contentId,
              },
            },
          };
          cell.attachments[name] = {
            [info.mediaType]: blob.bytes.toString("base64"),
          };
        } else {
          const nameWasUsed = used.has(name!);
          if (nameWasUsed) {
            used.delete(name!);
          }
          const primaryVariant = entry.variants[entry.primary_mime];
          if (primaryVariant?.uuid !== parsed.uuid) {
            return candidate;
          }
          const bundle: Record<string, string> = {};
          let bundleBytes = 0;
          for (const [mime, variant] of Object.entries(entry.variants)) {
            if (variant == null) continue;
            const resolved = await resolveVariant(variant, mime);
            if (resolved == null) {
              // Preserve the live blob URL until its bytes become available.
              // This is especially important for legacy cocalc.com blobs that
              // have not yet been migrated into the current blob store.
              if (nameWasUsed) {
                used.add(name!);
              }
              newEntries[name!] = entry;
              return candidate;
            }
            bundleBytes += resolved.byte_length;
            bundle[mime] = resolved.base64;
          }
          if (Object.keys(bundle).length === 0) {
            throw Error(
              `CoCalc image blob ${parsed.uuid} has no image variants`,
            );
          }
          totalBytes += bundleBytes;
          if (totalBytes > MAX_NOTEBOOK_ATTACHMENT_BYTES) {
            throw Error(
              `notebook image attachments exceed ${MAX_NOTEBOOK_ATTACHMENT_BYTES} bytes`,
            );
          }
          cell.attachments[name!] = bundle;
          used.add(name!);
        }
        namesByUuid.set(parsed.uuid, name!);
        newEntries[name!] = entry;
        return `attachment:${encodeURIComponent(name!)}`;
      },
    );
    setSource(cell, rewritten);
    setCellMetadata(cell, newEntries);
    if (Object.keys(cell.attachments).length === 0) {
      delete cell.attachments;
    }
  }
  return result;
}

function parseAttachmentName(encoded: string): string {
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    throw Error(`Jupyter attachment name '${encoded}' is not valid URL text`);
  }
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\0-\x1f\x7f]/.test(name)
  ) {
    throw Error(`Jupyter attachment name '${name}' is not safe`);
  }
  return name;
}

function preferredMime(
  variants: Partial<Record<SafeRasterMime, BlobVariantMetadata>>,
): SafeRasterMime {
  const mime = MIME_PREFERENCE.find((candidate) => variants[candidate] != null);
  if (mime == null) {
    throw Error("Jupyter attachment has no supported raster image variant");
  }
  return mime;
}

export async function externalizeJupyterAttachments({
  ipynb,
  loadBlob,
  saveBlob,
}: ExternalizeAttachmentsOptions): Promise<any> {
  assertAttachmentReferenceLimit(ipynb, "native");
  const result = deepCopy(ipynb);
  let totalBytes = 0;
  let attachmentCount = 0;

  for (const cell of result.cells ?? []) {
    if (cell?.cell_type !== "markdown") continue;
    const originalMetadata = metadataForCell(cell);
    const newEntries: Record<string, BlobAttachmentEntryMetadata> = {};
    const resolved = new Map<
      string,
      Promise<BlobAttachmentEntryMetadata | undefined>
    >();
    const consumedAttachments = new Set<string>();
    for (const match of blobUrlMatches(sourceText(cell.source))) {
      const parsed = parseBlobUrl(match[0]);
      if (parsed == null) continue;
      const mapped = findMetadataEntryForUuid(originalMetadata, parsed.uuid);
      if (mapped != null) {
        newEntries[mapped[0]] = mapped[1];
      }
    }

    const resolveAttachment = async (
      name: string,
    ): Promise<BlobAttachmentEntryMetadata | undefined> => {
      let promise = resolved.get(name);
      if (promise != null) return await promise;
      attachmentCount += 1;
      if (attachmentCount > MAX_NOTEBOOK_ATTACHMENT_COUNT) {
        throw Error(
          `notebook has too many image attachments (max ${MAX_NOTEBOOK_ATTACHMENT_COUNT})`,
        );
      }
      promise = (async () => {
        const bundle = cell.attachments?.[name];
        if (bundle == null || typeof bundle !== "object") {
          // Broken attachment references are valid notebook content in practice.
          // Preserve the reference so one missing image cannot block the entire
          // notebook from loading or saving.
          return;
        }
        consumedAttachments.add(name);
        const variants: Partial<Record<SafeRasterMime, BlobVariantMetadata>> =
          {};
        for (const [declaredMime, encoded] of Object.entries(bundle)) {
          const mime = normalizeMime(declaredMime);
          if (mime == null) {
            throw Error(
              `Jupyter attachment '${name}' has unsupported MIME type ${declaredMime}`,
            );
          }
          const bytes = decodeBase64(
            encoded,
            `Jupyter attachment '${name}' (${declaredMime})`,
          );
          validateRaster(
            bytes,
            `Jupyter attachment '${name}' (${declaredMime})`,
            mime,
          );
          totalBytes += bytes.length;
          if (totalBytes > MAX_NOTEBOOK_ATTACHMENT_BYTES) {
            throw Error(
              `notebook image attachments exceed ${MAX_NOTEBOOK_ATTACHMENT_BYTES} bytes`,
            );
          }
          const contentId = uuidsha1(bytes);
          const previous = originalMetadata?.entries?.[name]?.variants?.[mime];
          let target: SavedBlob | undefined;
          if (
            previous?.content_id === contentId &&
            isValidVariantMetadata(previous)
          ) {
            const existing = await loadBlob(previous.uuid);
            if (existing != null && uuidsha1(existing.bytes) === contentId) {
              target = { uuid: previous.uuid, url: previous.url };
            }
          }
          target ??= await saveBlob({
            bytes,
            content_id: contentId,
            filename: name,
            media_type: mime,
          });
          if (!isValidUUID(target.uuid)) {
            throw Error(`blob service returned invalid UUID '${target.uuid}'`);
          }
          variants[mime] = {
            uuid: target.uuid,
            url: target.url,
            content_id: contentId,
          };
        }
        const primaryMime = preferredMime(variants);
        return { primary_mime: primaryMime, variants };
      })();
      resolved.set(name, promise);
      return await promise;
    };

    const rewritten = await replaceAsync(
      sourceText(cell.source),
      ATTACHMENT_URL,
      async (original, encodedName) => {
        if (encodedName == null) return original;
        const name = parseAttachmentName(encodedName);
        const entry = await resolveAttachment(name);
        if (entry == null) return original;
        newEntries[name] = entry;
        const primary = entry.variants[entry.primary_mime];
        if (primary == null) {
          throw Error(`Jupyter attachment '${name}' has no primary image`);
        }
        return primary.url;
      },
    );
    setSource(cell, rewritten);
    setCellMetadata(cell, newEntries);
    for (const name of consumedAttachments) {
      delete cell.attachments?.[name];
    }
    if (
      cell.attachments != null &&
      Object.keys(cell.attachments).length === 0
    ) {
      delete cell.attachments;
    }
  }
  return result;
}

export const BLOB_ATTACHMENT_METADATA_KEY = METADATA_KEY;
// For tests: the linear blob URL scan and the pattern it must agree with.
export const blobUrlScanForTesting = {
  blobUrlMatches,
  GLOBAL_BLOB_URL,
  isUrlDelimiter,
};
export const MAX_JUPYTER_ATTACHMENT_BYTES = MAX_NOTEBOOK_ATTACHMENT_BYTES;
export const MAX_JUPYTER_ATTACHMENT_COUNT = MAX_NOTEBOOK_ATTACHMENT_COUNT;
