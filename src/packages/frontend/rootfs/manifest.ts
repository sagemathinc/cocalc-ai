/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { publishProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import {
  DEFAULT_ROOTFS_CATALOG_URL,
  type ProjectRootfsStateEntry,
  type ProjectRootfsPublishLroRef,
  type PublishProjectRootfsBody,
  type RootfsCatalogPageRequest,
  type RootfsCatalogSaveBody,
  RootfsImageEntry,
  RootfsImageManifest,
  mergeRootfsManifests,
} from "@cocalc/util/rootfs-images";
import type { RootfsProjectPreflightScanResult } from "@cocalc/util/rootfs-scan";
import { joinUrlPath } from "@cocalc/util/url-path";

type ManifestLoadState = {
  images: RootfsImageEntry[];
  loading: boolean;
  error?: string;
};

type RootfsImageLoadOptions = {
  query?: string;
  limit?: number;
  imageIds?: string[];
  lineageImageId?: string;
  slug?: string;
  imageTarget?: string;
  allPages?: boolean;
};

const manifestCache = new Map<string, Promise<RootfsImageEntry[]>>();
let manifestRevision = 0;
const manifestListeners = new Set<() => void>();
const MANAGED_CATALOG_RPC_TIMEOUT_MS = 12_000;
const MANIFEST_FETCH_TIMEOUT_MS = 12_000;
const MANAGED_CATALOG_MAX_ALL_PAGES = 20;
const MANAGED_CATALOG_MAX_ALL_IMAGES = 4_000;

function subscribeManifestInvalidation(listener: () => void): () => void {
  manifestListeners.add(listener);
  return () => {
    manifestListeners.delete(listener);
  };
}

export function invalidateRootfsImageCache(): void {
  manifestCache.clear();
  manifestRevision += 1;
  for (const listener of manifestListeners) {
    listener();
  }
}

function normalizeUrls(urls: string[]): string[] {
  return Array.from(
    new Set(
      urls.map((url) => url?.trim()).filter((url) => url && url.length > 0),
    ),
  );
}

async function fetchManifest(url: string): Promise<RootfsImageManifest | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MANIFEST_FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as RootfsImageManifest;
    if (!json || !Array.isArray(json.images)) {
      throw new Error("Invalid manifest format");
    }
    if (!json.source) {
      json.source = url;
    }
    return json;
  } catch (err) {
    console.warn(`Failed to load RootFS manifest ${url}:`, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout != null) {
      clearTimeout(timeout);
    }
  }
}

function rootfsCatalogScopeKey(): string {
  const accountId = `${webapp_client.account_id ?? ""}`.trim();
  if (accountId) {
    return `account:${accountId}`;
  }
  if (webapp_client.conat_client.is_signed_in()) {
    return "signed-in";
  }
  return "public";
}

function isManagedCatalogUrl(url: string): boolean {
  const path = url.trim().split("?")[0];
  return (
    path === managedRootfsCatalogPath() || path === DEFAULT_ROOTFS_CATALOG_URL
  );
}

function managedRootfsCatalogPath(): string {
  return joinUrlPath(appBasePath, DEFAULT_ROOTFS_CATALOG_URL);
}

async function loadManagedCatalogManifest(
  url: string,
  opts: RootfsImageLoadOptions = {},
): Promise<RootfsImageManifest | null> {
  const hasAccountContext =
    !!`${webapp_client.account_id ?? ""}`.trim() ||
    webapp_client.conat_client.is_signed_in();
  if (hasAccountContext) {
    try {
      const pageLimit = opts.limit ?? 200;
      const filterValues: NonNullable<RootfsCatalogPageRequest["filters"]> = {
        image_target: opts.imageTarget,
        lineage_image_id: opts.lineageImageId,
        slug: opts.slug,
      };
      const filters = Object.values(filterValues).some(Boolean)
        ? filterValues
        : undefined;
      const page = await withTimeout(
        webapp_client.conat_client.hub.system.getRootfsCatalogPage({
          filters,
          limit: pageLimit,
          query: opts.query?.trim() || undefined,
        }),
        MANAGED_CATALOG_RPC_TIMEOUT_MS,
        "RootFS catalog RPC timed out",
      );
      const manifest: RootfsImageManifest = {
        version: page.version,
        generated_at: page.generated_at,
        source: page.source,
        images: page.images,
      };
      if (opts.allPages) {
        const seenCursors = new Set<string>();
        let cursor = page.next_cursor;
        let pageCount = 1;
        while (
          cursor &&
          !seenCursors.has(cursor) &&
          pageCount < MANAGED_CATALOG_MAX_ALL_PAGES &&
          manifest.images.length < MANAGED_CATALOG_MAX_ALL_IMAGES
        ) {
          seenCursors.add(cursor);
          const next = await withTimeout(
            webapp_client.conat_client.hub.system.getRootfsCatalogPage({
              cursor,
              filters,
              limit: pageLimit,
              query: opts.query?.trim() || undefined,
            }),
            MANAGED_CATALOG_RPC_TIMEOUT_MS,
            "RootFS catalog RPC timed out",
          );
          const remaining =
            MANAGED_CATALOG_MAX_ALL_IMAGES - manifest.images.length;
          manifest.images.push(...next.images.slice(0, remaining));
          cursor = next.next_cursor;
          pageCount += 1;
        }
        if (cursor) {
          console.warn(
            `RootFS catalog loading stopped after ${pageCount} pages and ${manifest.images.length} images`,
          );
        }
      }
      const requestedImageIds = Array.from(
        new Set(
          (opts.imageIds ?? [])
            .map((id) => `${id ?? ""}`.trim())
            .filter(Boolean),
        ),
      );
      const loadedImageIds = new Set(manifest.images.map((entry) => entry.id));
      const missingImageIds = requestedImageIds.filter(
        (id) => !loadedImageIds.has(id),
      );
      if (missingImageIds.length > 0) {
        try {
          const exact =
            await webapp_client.conat_client.hub.system.getRootfsCatalogEntries(
              {
                image_ids: missingImageIds,
              },
            );
          manifest.images = mergeRootfsManifests([manifest, exact]);
        } catch (err) {
          console.warn("Failed to resolve RootFS catalog image ids:", err);
        }
      }
      if (!manifest.source) {
        manifest.source = url;
      }
      return manifest;
    } catch (err) {
      console.warn("Failed to load RootFS catalog via Conat:", err);
    }
  }
  return await fetchManifest(url);
}

async function loadManifest(
  url: string,
  opts: RootfsImageLoadOptions = {},
): Promise<RootfsImageManifest | null> {
  if (isManagedCatalogUrl(url)) {
    return await loadManagedCatalogManifest(url, opts);
  }
  return await fetchManifest(url);
}

export async function loadRootfsImages(
  manifestUrls: string[],
  scopeKey: string = rootfsCatalogScopeKey(),
  opts: RootfsImageLoadOptions = {},
): Promise<RootfsImageEntry[]> {
  const urls = normalizeUrls(manifestUrls);
  if (urls.length === 0) {
    return [];
  }
  const imageIdsKey = Array.from(
    new Set(
      (opts.imageIds ?? []).map((id) => `${id ?? ""}`.trim()).filter(Boolean),
    ),
  )
    .sort()
    .join(",");
  const key = `${scopeKey}|${opts.query ?? ""}|${opts.limit ?? ""}|${opts.allPages ? "all" : "page"}|${opts.lineageImageId ?? ""}|${opts.slug ?? ""}|${opts.imageTarget ?? ""}|${imageIdsKey}|${urls.join("|")}`;
  const cached = manifestCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const manifests = await Promise.all(
      urls.map((url) => loadManifest(url, opts)),
    );
    return mergeRootfsManifests(
      manifests.filter(
        (manifest): manifest is RootfsImageManifest => !!manifest,
      ),
    );
  })();
  manifestCache.set(key, pending);
  return pending;
}

export function useRootfsImages(
  manifestUrls: string[],
  opts: RootfsImageLoadOptions = {},
): ManifestLoadState {
  const [state, setState] = useState<ManifestLoadState>({
    images: [],
    loading: true,
  });
  const [revision, setRevision] = useState<number>(manifestRevision);
  const urls = useMemo(() => normalizeUrls(manifestUrls), [manifestUrls]);
  const scopeKey = rootfsCatalogScopeKey();
  const query = opts.query?.trim() ?? "";
  const limit = opts.limit;
  const allPages = opts.allPages;
  const lineageImageId = opts.lineageImageId?.trim() ?? "";
  const slug = opts.slug?.trim() ?? "";
  const imageTarget = opts.imageTarget?.trim() ?? "";
  const imageIdsKey = useMemo(
    () =>
      Array.from(
        new Set(
          (opts.imageIds ?? [])
            .map((id) => `${id ?? ""}`.trim())
            .filter(Boolean),
        ),
      )
        .sort()
        .join(","),
    [opts.imageIds?.join("|")],
  );

  useEffect(
    () => subscribeManifestInvalidation(() => setRevision(manifestRevision)),
    [],
  );

  useEffect(() => {
    let active = true;
    if (urls.length === 0) {
      setState({ images: [], loading: false });
      return () => {
        active = false;
      };
    }
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    const imageIds = imageIdsKey ? imageIdsKey.split(",") : [];
    loadRootfsImages(urls, scopeKey, {
      query,
      limit,
      imageIds,
      lineageImageId,
      slug,
      imageTarget,
      allPages,
    })
      .then((images) => {
        if (!active) return;
        setState({ images, loading: false });
      })
      .catch((err) => {
        if (!active) return;
        setState({
          images: [],
          loading: false,
          error: err ? String(err) : "Failed to load manifest",
        });
      });
    return () => {
      active = false;
    };
  }, [
    allPages,
    imageIdsKey,
    limit,
    lineageImageId,
    slug,
    imageTarget,
    query,
    revision,
    scopeKey,
    urls.join("|"),
  ]);

  return state;
}

export async function saveRootfsCatalogEntry(
  body: RootfsCatalogSaveBody,
): Promise<RootfsImageEntry> {
  const entry =
    await webapp_client.conat_client.hub.system.saveRootfsCatalogEntry({
      ...body,
      browser_id: body.browser_id ?? webapp_client.browser_id,
    });
  invalidateRootfsImageCache();
  return entry;
}

export async function publishProjectRootfsImage(
  body: PublishProjectRootfsBody,
): Promise<ProjectRootfsPublishLroRef> {
  return await webapp_client.conat_client.hub.system.publishProjectRootfsImage({
    ...body,
    browser_id: body.browser_id ?? webapp_client.browser_id,
  });
}

export async function getProjectRootfsStates(
  project_id: string,
): Promise<ProjectRootfsStateEntry[]> {
  return await webapp_client.conat_client.hub.system.getProjectRootfsStates({
    project_id,
  });
}

export async function setProjectRootfsImage(body: {
  project_id: string;
  image: string;
  image_id?: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const states =
    await webapp_client.conat_client.hub.system.setProjectRootfsImage(body);
  publishProjectDetailInvalidation({
    project_id: body.project_id,
    fields: ["rootfs"],
  });
  return states;
}

export async function scanProjectRootfs(
  project_id: string,
): Promise<RootfsProjectPreflightScanResult> {
  return await webapp_client.conat_client.hub.system.scanProjectRootfs({
    project_id,
    timeout: 35 * 60 * 1000,
  });
}

export function managedRootfsCatalogUrl(refresh?: number | string): string {
  const path = managedRootfsCatalogPath();
  if (refresh == null) {
    return path;
  }
  return `${path}?refresh=${encodeURIComponent(`${refresh}`)}`;
}
