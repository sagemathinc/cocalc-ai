import { redux } from "@cocalc/frontend/app-framework";
import TTLCache from "@isaacs/ttlcache";

const dustCache = new TTLCache<string, any>({ ttl: 1000 * 60 });

export function key({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}) {
  return `${project_id}-0-${path}`;
}

// Very Obvious TODO, depending on how we use this, which doesn't change the API:
// Just compute the entire tree once, then for any subdirectory, compute from that
// tree... until refresh or cache timeout.  Could be great... or pointless.

export default async function dust({
  project_id,
  path = "/",
  cache = true,
}: {
  project_id: string;
  path?: string;
  cache?: boolean;
}) {
  const k = key({ project_id, path });
  if (cache && dustCache.has(k)) {
    return dustCache.get(k);
  }
  const fs = redux.getProjectActions(project_id).fs();
  const { stdout, stderr, code, truncated } = await fs.dust(path, {
    options: ["-j", "-x", "-d", "1", "-s", "-o", "b"],
    timeout: 3000,
  });
  if (code) {
    throw Error(Buffer.from(stderr).toString());
  }
  const text = Buffer.from(stdout).toString();
  if (truncated || !text.trim()) {
    const errText = Buffer.from(stderr).toString().trim();
    throw Error(
      errText || `disk usage scan for '${path}' returned incomplete data`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw Error(`disk usage scan for '${path}' returned invalid JSON`);
  }
  let { size, name: abspath, children } = parsed;
  const n = abspath.length + 1;
  children = children.map(({ size, name }) => {
    return { bytes: parseInt(size.slice(0, -1)), path: name.slice(n) };
  });
  const v = { bytes: parseInt(size.slice(0, -1)), children };
  dustCache.set(k, v);
  return v;
}
