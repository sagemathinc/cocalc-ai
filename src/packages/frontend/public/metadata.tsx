/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo } from "react";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

import type { PublicConfig } from "./config";
import {
  getPublicRouteMetadata as getPublicRouteMetadataData,
  type PublicRouteMetadata,
} from "./metadata-data";
import type { PublicRoute } from "./routes";

export {
  getPublicRouteMetadata,
  PUBLIC_SITE_DESCRIPTION,
  type PublicRouteMetadata,
} from "./metadata-data";

function absolutePublicUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).href;
}

function upsertManagedElement<T extends HTMLMetaElement | HTMLLinkElement>({
  attrs,
  tag,
  key,
}: {
  attrs: Record<string, string>;
  key: string;
  tag: "link" | "meta";
}): T {
  let element = document.head.querySelector<T>(
    `${tag}[data-cocalc-public-route-meta="${key}"]`,
  );
  if (element == null) {
    element = document.createElement(tag) as T;
    element.setAttribute("data-cocalc-public-route-meta", key);
    document.head.appendChild(element);
  }
  for (const attr of Array.from(element.attributes)) {
    if (attr.name !== "data-cocalc-public-route-meta") {
      element.removeAttribute(attr.name);
    }
  }
  element.setAttribute("data-cocalc-public-route-meta", key);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, value);
  }
  return element;
}

export function applyPublicRouteMetadata(metadata: PublicRouteMetadata): void {
  const canonicalUrl = absolutePublicUrl(metadata.canonicalPath);
  const imageUrl = absolutePublicUrl(metadata.imagePath);

  upsertManagedElement<HTMLMetaElement>({
    attrs: { content: metadata.description, name: "description" },
    key: "description",
    tag: "meta",
  });
  upsertManagedElement<HTMLLinkElement>({
    attrs: { href: canonicalUrl, rel: "canonical" },
    key: "canonical",
    tag: "link",
  });

  for (const [property, content] of [
    ["og:type", "website"],
    ["og:title", metadata.title],
    ["og:description", metadata.description],
    ["og:url", canonicalUrl],
    ["og:image", imageUrl],
  ] as const) {
    upsertManagedElement<HTMLMetaElement>({
      attrs: { content, property },
      key: property,
      tag: "meta",
    });
  }

  for (const [name, content] of [
    ["twitter:card", "summary_large_image"],
    ["twitter:title", metadata.title],
    ["twitter:description", metadata.description],
    ["twitter:image", imageUrl],
  ] as const) {
    upsertManagedElement<HTMLMetaElement>({
      attrs: { content, name },
      key: name,
      tag: "meta",
    });
  }
}

export function PublicRouteHeadMetadata({
  config,
  route,
}: {
  config?: PublicConfig;
  route: PublicRoute;
}) {
  const metadata = useMemo(
    () =>
      getPublicRouteMetadataData(route, config, {
        basePath: appBasePath,
      }),
    [config, route],
  );

  useEffect(() => {
    applyPublicRouteMetadata(metadata);
  }, [metadata]);

  return null;
}
