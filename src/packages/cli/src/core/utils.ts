export function durationToMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const raw = value.trim().toLowerCase();
  if (!raw) return fallbackMs;
  const match = raw.match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(`invalid duration '${value}'`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  return amount * mult[unit];
}

export function normalizeUrl(url: string): string {
  const trimmed = `${url}`.trim();
  if (!trimmed) throw new Error("empty url");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed.replace(/\/+$/, "")}`;
}

export function parseSshServer(sshServer: string): { host: string; port?: number } {
  const value = sshServer.trim();
  if (!value) {
    throw new Error("host has no ssh_server configured");
  }
  if (value.startsWith("[")) {
    const match = value.match(/^\[(.*)\]:(\d+)$/);
    if (match) {
      return { host: match[1], port: Number(match[2]) };
    }
    return { host: value };
  }
  const match = value.match(/^(.*):(\d+)$/);
  if (match) {
    return { host: match[1], port: Number(match[2]) };
  }
  return { host: value };
}

export function extractCookie(
  setCookie: string | null,
  cookieName: string,
): string | undefined {
  if (!setCookie) return undefined;
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}=([^;]+)`);
  const match = setCookie.match(re);
  if (!match?.[1]) return undefined;
  return `${cookieName}=${match[1]}`;
}

export function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
