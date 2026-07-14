/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

import type { PublicConfig } from "./config";
import {
  getPublicRouteMetadata as getPublicRouteMetadataData,
  hasPublicDocsMetadataSource,
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

function removeManagedElement(key: string): void {
  document.head
    .querySelector(`[data-cocalc-public-route-meta="${key}"]`)
    ?.remove();
}

export function applyPublicRouteMetadata(metadata: PublicRouteMetadata): void {
  const canonicalUrl = absolutePublicUrl(metadata.canonicalPath);
  const imageUrl = absolutePublicUrl(metadata.imagePath);

  // Keep the robots noindex tag in sync during SPA navigation: restricted
  // pages (e.g. admin-only docs) carry it, everything else must not.
  if (metadata.noindex) {
    upsertManagedElement<HTMLMetaElement>({
      attrs: { content: "noindex", name: "robots" },
      key: "robots",
      tag: "meta",
    });
  } else {
    removeManagedElement("robots");
  }

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
  // Docs metadata needs the docs registry, which is deliberately kept out of
  // the initial public bundle; load it on demand (the chunk is shared with
  // the lazy docs app, so docs visitors pay for it once).
  const [docsSourceReady, setDocsSourceReady] = useState<boolean>(
    hasPublicDocsMetadataSource,
  );
  useEffect(() => {
    if (route.section !== "docs" || docsSourceReady) return;
    let cancelled = false;
    import("@cocalc/util/public-site-metadata-docs")
      .then((mod) => {
        mod.initPublicDocsMetadata();
        if (!cancelled) {
          setDocsSourceReady(true);
        }
      })
      .catch((err) => {
        console.warn("failed to load docs metadata registry", err);
      });
    return () => {
      cancelled = true;
    };
  }, [route, docsSourceReady]);

  const metadata = useMemo(() => {
    if (route.section === "docs" && !docsSourceReady) {
      // Leave the server-rendered head untouched (including a restricted
      // page's noindex tag) until the docs registry is available; applying
      // metadata now would emit generic docs metadata instead.
      return undefined;
    }
    if (
      route.section === "rootfs" &&
      (route.route.view === "slug" || route.route.view === "image-id")
    ) {
      // The rootfs app owns detail-route heads: the server shell resolved
      // the image's metadata from the runtime-image catalog (real
      // title/description, slug-preferred canonical), and after SPA
      // navigation PublicRootfsApp re-applies entry metadata once its
      // catalog loads. The generic route-echo values here would clobber
      // both.
      return undefined;
    }
    const dns =
      config?.dns ??
      (typeof window === "undefined" ? undefined : window.location.host);
    return getPublicRouteMetadataData(
      route,
      { ...config, dns },
      {
        basePath: appBasePath,
      },
    );
  }, [config, route, docsSourceReady]);

  useEffect(() => {
    if (metadata == null) return;
    applyPublicRouteMetadata(metadata);
  }, [metadata]);

  return null;
}
