import { join } from "node:path";

const LITE_DATA_DIR_SUFFIX = [".local", "share", "cocalc-lite"];
const CONNECTION_INFO_FILENAME = "connection-info.json";

function defaultLiteDataDir(): string {
  const home = process.env.HOME?.trim();
  const base = home && home.length > 0 ? home : process.cwd();
  return join(base, ...LITE_DATA_DIR_SUFFIX);
}

// Canonical on-disk location for lite startup connection metadata.
// If COCALC_WRITE_CONNECTION_INFO is set, that path is used explicitly.
export function connectionInfoPath(): string {
  const explicit = process.env.COCALC_WRITE_CONNECTION_INFO?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return join(defaultLiteDataDir(), CONNECTION_INFO_FILENAME);
}
