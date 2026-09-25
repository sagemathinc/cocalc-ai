import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

export function blobImageUrl(
  blob: string | undefined | null,
  filename = "theme-image.png",
) {
  const trimmed = `${blob ?? ""}`.trim();
  if (!trimmed) return undefined;
  return `${joinUrlPath("/", appBasePath, "blobs", encodeURIComponent(filename))}?uuid=${encodeURIComponent(trimmed)}`;
}
