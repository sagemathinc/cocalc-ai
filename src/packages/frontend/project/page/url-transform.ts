import { join } from "path";
import { fileURL } from "@cocalc/frontend/lib/cocalc-urls";
import { containingPath } from "@cocalc/util/misc";
import { hasHostAbsoluteRoutePrefix } from "@cocalc/util/routing/app";
import { isCoCalcURL, parseCoCalcURL } from "@cocalc/frontend/lib/cocalc-urls";

interface Options {
  project_id: string;
  path: string;
}
// NOTE: there is a similar function in next/lib/share/url-transform.ts

function isHostAbsoluteResource(href: string): boolean {
  return hasHostAbsoluteRoutePrefix(href);
}

export default function getUrlTransform({ project_id, path }: Options) {
  const dir = containingPath(path);
  return (href: string, tag: string) => {
    if (href.startsWith("data:")) return; // never change data: urls in any way.
    if (href.startsWith("/")) {
      if (tag === "img" && !isHostAbsoluteResource(href)) {
        return fileURL({ project_id, path: href.replace(/^\/+/, "") });
      }
      // Absolute paths that target CoCalc web routes stay host-root resources.
      return href;
    }
    // AnchorTagComponent owns anchor navigation. Rewriting a same-site anchor
    // here discards its project route and double-encodes escaped file paths.
    if (tag == "a") {
      return;
    }
    if (href.includes("://")) {
      // We only modify local urls and cloud urls (only on frontend -- they will fail on share server).
      if (isCoCalcURL(href)) {
        const { project_id, path } = parseCoCalcURL(href);
        if (project_id != null && path != null) {
          return fileURL({ project_id, path });
        }
      }
      return;
    }
    return fileURL({ project_id, path: join(dir, href) });
  };
}
