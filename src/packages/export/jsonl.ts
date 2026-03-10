import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonlRows(filePath: string): Promise<any[]> {
  const raw = await readFile(filePath, "utf8");
  return parseJsonlRows(raw, filePath);
}

export function parseJsonlRows(raw: string, filePath = "document"): any[] {
  const rows: any[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        rows.push(parsed);
      }
    } catch (err) {
      throw new Error(
        `invalid JSON in ${filePath} at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return rows;
}

export function stringifyJsonlRows(rows: any[]): string {
  if (!rows.length) return "";
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

export function sanitizeExportName(value: string, fallback: string): string {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

export function defaultExportRootDir(
  filePath: string,
  fallback: string,
): string {
  return sanitizeExportName(path.parse(filePath).name, fallback);
}

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeIsoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : undefined;
  }
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    return value.toISOString();
  }
  return undefined;
}
