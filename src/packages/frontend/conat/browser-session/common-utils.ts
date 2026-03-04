/*
Common browser-session utility helpers (path/value normalization, logging text
sanitization, and serializable conversions).
*/

export function asStringArray(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => `${v ?? ""}`.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value.toArray === "function") {
    return asStringArray(value.toArray());
  }
  const out: string[] = [];
  if (typeof value.forEach === "function") {
    value.forEach((v) => {
      const s = `${v ?? ""}`.trim();
      if (s.length > 0) out.push(s);
    });
  }
  return out;
}

export function toAbsolutePath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function sanitizePathList(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths
    .map((path) => `${path ?? ""}`.trim())
    .filter((path) => path.length > 0);
}

export function asFinitePositive(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(`${value}`);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num;
}

export function asFiniteNonNegative(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(`${value}`);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return num;
}

export function requireAbsolutePath(path: unknown, label = "path"): string {
  const cleanPath = `${path ?? ""}`.trim();
  if (!cleanPath) {
    throw Error(`${label} must be specified`);
  }
  if (!cleanPath.startsWith("/")) {
    throw Error(`${label} must be absolute`);
  }
  return cleanPath;
}

export function requireAbsolutePathOrList(
  value: unknown,
  label = "path",
): string | string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw Error(`${label} must be a non-empty array`);
    }
    return value.map((x, i) => requireAbsolutePath(x, `${label}[${i}]`));
  }
  return requireAbsolutePath(value, label);
}

export function splitAbsolutePath(path: string): { dir: string; base: string } {
  const cleanPath = requireAbsolutePath(path);
  if (cleanPath === "/") {
    throw Error("path cannot be '/'");
  }
  const i = cleanPath.lastIndexOf("/");
  if (i < 0) {
    throw Error("path must be absolute");
  }
  const dir = i === 0 ? "/" : cleanPath.slice(0, i);
  const base = cleanPath.slice(i + 1);
  if (!base) {
    throw Error("path must reference a file");
  }
  return { dir, base };
}

export function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return Buffer.from(value as any).toString();
  } catch {
    return `${value}`;
  }
}

export function truncateRuntimeMessage(text: string, max = 2_000): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

export function safeStringifyForRuntimeLog(value: unknown): string {
  try {
    if (value instanceof Error) {
      const msg = `${value.name || "Error"}: ${value.message || ""}`.trim();
      if (value.stack) {
        return `${msg}\n${value.stack}`;
      }
      return msg;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || value == null) {
      return `${value}`;
    }
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, next) => {
      if (typeof next === "object" && next != null) {
        if (seen.has(next as object)) {
          return "[Circular]";
        }
        seen.add(next as object);
      }
      if (typeof next === "bigint") {
        return `${next}n`;
      }
      if (typeof next === "function") {
        return `[Function ${next.name || "anonymous"}]`;
      }
      return next;
    });
  } catch {
    return `${value}`;
  }
}

export function normalizeTerminalFrameCommand(value: unknown): string | undefined {
  const command = `${value ?? ""}`.trim();
  return command.length > 0 ? command : undefined;
}

export function normalizeTerminalFrameArgs(value: unknown): string[] {
  return asStringArray(value);
}

export function terminalCommandSuffix(command?: string): string {
  return command ? `-${command.replace(/\//g, "-")}` : "";
}

export function toNotifyMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return `${value ?? ""}`;
  }
}

export function asOptionalFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n =
    typeof value === "number" ? value : Number.parseFloat(`${value ?? ""}`);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export function toSerializableValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return `${value}`;
  }
}
