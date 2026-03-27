import { existsSync } from "fs";
import { join } from "path";

import createApiV2Router, { type ApiV2RouterOptions } from "./router";

export default function createConatRouter(
  opts: ApiV2RouterOptions = {},
): ReturnType<typeof createApiV2Router> {
  return createApiV2Router({
    ...opts,
    rootDir: resolveConatApiRoot(opts.rootDir),
  });
}

function resolveConatApiRoot(override?: string): string {
  if (process.env.COCALC_CONAT_API_ROOT) {
    return process.env.COCALC_CONAT_API_ROOT;
  }
  if (override) {
    return override;
  }
  const bundleDir = process.env.COCALC_BUNDLE_DIR;
  if (bundleDir) {
    const bundledCandidates = [
      join(bundleDir, "http-api-dist", "pages", "api", "conat"),
      join(
        bundleDir,
        "bundle",
        "node_modules",
        "@cocalc",
        "http-api",
        "dist",
        "pages",
        "api",
        "conat",
      ),
      join(bundleDir, "next-dist", "pages", "api", "conat"),
    ];
    for (const bundled of bundledCandidates) {
      if (existsSync(bundled)) {
        return bundled;
      }
    }
  }
  return join(__dirname, "..", "pages", "api", "conat");
}
