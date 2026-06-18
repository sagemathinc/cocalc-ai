/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { publishProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import {
  DEFAULT_ROOTFS_CATALOG_URL,
  type ProjectRootfsStateEntry,
  type ProjectRootfsPublishLroRef,
  type PublishProjectRootfsBody,
  type RootfsCatalogSaveBody,
  RootfsImageEntry,
  RootfsImageManifest,
  mergeRootfsManifests,
} from "@cocalc/util/rootfs-images";
import type { RootfsProjectPreflightScanResult } from "@cocalc/util/rootfs-scan";

type ManifestLoadState = {
  images: RootfsImageEntry[];
  loading: boolean;
  error?: string;
};

type RootfsImageLoadOptions = {
  query?: string;
  limit?: number;
  imageIds?: string[];
};

const manifestCache = new Map<string, Promise<RootfsImageEntry[]>>();
let manifestRevision = 0;
const manifestListeners = new Set<() => void>();

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
  try {
    const res = await fetch(url);
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
  return url.trim().split("?")[0] === DEFAULT_ROOTFS_CATALOG_URL;
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
      const page =
        await webapp_client.conat_client.hub.system.getRootfsCatalogPage({
          limit: opts.limit ?? 200,
          query: opts.query?.trim() || undefined,
        });
      const manifest: RootfsImageManifest = {
        version: page.version,
        generated_at: page.generated_at,
        source: page.source,
        images: page.images,
      };
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
  const key = `${scopeKey}|${opts.query ?? ""}|${opts.limit ?? ""}|${imageIdsKey}|${urls.join("|")}`;
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
    loadRootfsImages(urls, scopeKey, { query, limit, imageIds })
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
  }, [imageIdsKey, limit, query, revision, scopeKey, urls.join("|")]);

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
  if (refresh == null) {
    return DEFAULT_ROOTFS_CATALOG_URL;
  }
  return `${DEFAULT_ROOTFS_CATALOG_URL}?refresh=${encodeURIComponent(
    `${refresh}`,
  )}`;
}
