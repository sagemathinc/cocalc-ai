export function normalizeContentType(value: string | undefined): string | undefined {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.split(";")[0].trim() || undefined;
}

export function extensionForContentType(
  contentType: string | undefined,
): string | undefined {
  switch (normalizeContentType(contentType)) {
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
    default:
      return undefined;
  }
}

export function pastedBlobFilename(contentType: string | undefined): string {
  const ext = extensionForContentType(contentType) ?? "";
  return `paste-${Math.random().toString(36).slice(2)}${ext}`;
}
