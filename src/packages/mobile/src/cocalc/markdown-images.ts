/* CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL. */
import { Buffer } from "buffer";
import { posix } from "path-browserify";
import { isValidUUID } from "@cocalc/util/misc";
import type { ImageResolver } from "../chat/markdown-image";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import { getActiveSiteSession } from "./session-registry";
import { openProjectHost } from "./site-session";
import { isPreviewProfile } from "../preview/fixtures";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
export function createMarkdownImageResolver(
  profile: string,
  project: string,
  chatPath: string,
): ImageResolver {
  return async (src) => {
    if (isPreviewProfile(profile) && src === "preview-plot.png")
      return require("../../assets/preview-plot.png");
    if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith("//"))
      throw Error("Unsupported image URL");
    if (isPreviewProfile(profile)) throw Error("Unsupported image");
    const session = await getActiveSiteSession(profile);
    const siteUrl = new URL(session.profile.canonical_app_url);
    const basePath = siteUrl.pathname.replace(/\/+$/, "");
    if (src.startsWith("/blobs/") || src.startsWith(`${basePath}/blobs/`)) {
      const blobPath = src.startsWith("/blobs/") ? `${basePath}${src}` : src;
      const blobUrl = new URL(blobPath, siteUrl.origin);
      if (!blobUrl.pathname.startsWith(`${basePath}/blobs/`)) {
        throw Error("Invalid blob image URL");
      }
      if (!isValidUUID(blobUrl.searchParams.get("uuid") ?? "")) {
        throw Error("Invalid blob image URL");
      }
      return { uri: blobUrl.toString() };
    }
    const path = posix.resolve(
      posix.dirname(chatPath),
      decodeURIComponent(src),
    );
    const mime = TYPES[posix.extname(path).slice(1).toLowerCase()];
    if (!mime) throw Error("Unsupported image");
    const host = await resolveNamedAgentHost(
      session.hubApi,
      session.profile.account_id,
      project,
    );
    const lease = await openProjectHost(session, {
      project_id: project,
      host_id: host,
    });
    // File bytes go directly to the owning project host with its scoped lease.
    const files = lease.client.call<{
      stat(path: string): Promise<{ size: number }>;
      readFile(path: string): Promise<Uint8Array>;
    }>(`fs.project-${project}`, { timeout: 30000 });
    if ((await files.stat(path)).size > MAX_IMAGE_BYTES)
      throw Error("Image too large");
    const bytes = Buffer.from(await files.readFile(path));
    if (bytes.length > MAX_IMAGE_BYTES) throw Error("Image too large");
    return { uri: `data:${mime};base64,${bytes.toString("base64")}` };
  };
}
