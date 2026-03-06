export interface ExportManifest {
  format: string;
  version: number;
  kind: string;
  exported_at: string;
  [key: string]: unknown;
}

export function normalizeExportManifest(
  manifest: ExportManifest,
): ExportManifest {
  const exportedAt =
    typeof manifest.exported_at === "string" && manifest.exported_at.trim()
      ? manifest.exported_at
      : new Date().toISOString();
  return {
    ...manifest,
    exported_at: exportedAt,
  };
}
