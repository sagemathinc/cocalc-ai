export function parseSsOutput(
  raw: string,
): Array<{ host: string; port: number }> {
  const out: Array<{ host: string; port: number }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const cols = text.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const m = local.match(/^(.*):(\d+)$/);
    if (!m) continue;
    let host = m[1] ?? "";
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port <= 0) continue;
    out.push({ host: host || "0.0.0.0", port });
  }
  return out;
}

export function parseLsofListenOutput(
  raw: string,
): Array<{ host: string; port: number }> {
  const out: Array<{ host: string; port: number }> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const value = line.slice(1).replace(/\s+\(LISTEN\)\s*$/, "");
    if (!value) continue;
    const m = value.match(/^(.*):(\d+)$/);
    if (!m) continue;
    let host = m[1] ?? "";
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    if (host === "*" || host === "") {
      host = "0.0.0.0";
    }
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port <= 0) continue;
    out.push({ host, port });
  }
  return out;
}
