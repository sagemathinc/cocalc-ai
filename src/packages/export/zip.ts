import { strToU8, zipSync } from "fflate";
import { bundleEntries, type ExportBundle } from "./bundle";

export interface ExportZipOptions {
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export function bundleToZipBytes(
  bundle: ExportBundle,
  options: ExportZipOptions = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of bundleEntries(bundle)) {
    files[entry.path] =
      typeof entry.content === "string"
        ? strToU8(entry.content)
        : entry.content;
  }
  return zipSync(files, {
    level: options.level ?? 6,
  });
}

export function bundleToZipBuffer(
  bundle: ExportBundle,
  options: ExportZipOptions = {},
): Buffer {
  return Buffer.from(bundleToZipBytes(bundle, options));
}
