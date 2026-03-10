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

export function initialPastedImageDimensions(opts: {
  filename?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  devicePixelRatio?: number;
}): { width: string; height: string } | undefined {
  const filename = `${opts.filename ?? ""}`.trim();
  if (!filename.startsWith("paste-")) return undefined;
  const naturalWidth = Number(opts.naturalWidth);
  const naturalHeight = Number(opts.naturalHeight);
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    return undefined;
  }
  const dpr = Math.max(1, Number(opts.devicePixelRatio) || 1);
  const width = Math.max(1, Math.round(naturalWidth / dpr));
  const height = Math.max(1, Math.round(naturalHeight / dpr));
  return {
    width: `${width}px`,
    height: `${height}px`,
  };
}

export function reportSlateUploadError(
  actions: { set_error?: (message: string) => void } | undefined,
  message: unknown,
  alertMessage: (opts: { type: "error"; message: string }) => void,
): void {
  const normalized = `${message ?? ""}`;
  if (actions?.set_error != null) {
    actions.set_error(normalized);
    return;
  }
  alertMessage({ type: "error", message: normalized });
}
