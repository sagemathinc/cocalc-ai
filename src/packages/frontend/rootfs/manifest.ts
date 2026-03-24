/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
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

type ManifestLoadState = {
  images: RootfsImageEntry[];
  loading: boolean;
  error?: string;
};

const manifestCache = new Map<string, Promise<RootfsImageEntry[]>>();

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
): Promise<RootfsImageManifest | null> {
  const hasAccountContext =
    !!`${webapp_client.account_id ?? ""}`.trim() ||
    webapp_client.conat_client.is_signed_in();
  if (hasAccountContext) {
    try {
      const manifest =
        await webapp_client.conat_client.hub.system.getRootfsCatalog({});
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

async function loadManifest(url: string): Promise<RootfsImageManifest | null> {
  if (isManagedCatalogUrl(url)) {
    return await loadManagedCatalogManifest(url);
  }
  return await fetchManifest(url);
}

export async function loadRootfsImages(
  manifestUrls: string[],
  scopeKey: string = rootfsCatalogScopeKey(),
): Promise<RootfsImageEntry[]> {
  const urls = normalizeUrls(manifestUrls);
  if (urls.length === 0) {
    return [];
  }
  const key = `${scopeKey}|${urls.join("|")}`;
  const cached = manifestCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const manifests = await Promise.all(urls.map(loadManifest));
    return mergeRootfsManifests(
      manifests.filter(
        (manifest): manifest is RootfsImageManifest => !!manifest,
      ),
    );
  })();
  manifestCache.set(key, pending);
  return pending;
}

export function useRootfsImages(manifestUrls: string[]): ManifestLoadState {
  const [state, setState] = useState<ManifestLoadState>({
    images: [],
    loading: true,
  });
  const urls = useMemo(() => normalizeUrls(manifestUrls), [manifestUrls]);
  const scopeKey = rootfsCatalogScopeKey();

  useEffect(() => {
    let active = true;
    if (urls.length === 0) {
      setState({ images: [], loading: false });
      return () => {
        active = false;
      };
    }
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    loadRootfsImages(urls, scopeKey)
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
  }, [scopeKey, urls.join("|")]);

  return state;
}

export async function saveRootfsCatalogEntry(
  body: RootfsCatalogSaveBody,
): Promise<RootfsImageEntry> {
  return await webapp_client.conat_client.hub.system.saveRootfsCatalogEntry(
    body,
  );
}

export async function publishProjectRootfsImage(
  body: PublishProjectRootfsBody,
): Promise<ProjectRootfsPublishLroRef> {
  return await webapp_client.conat_client.hub.system.publishProjectRootfsImage(
    body,
  );
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
  return await webapp_client.conat_client.hub.system.setProjectRootfsImage(
    body,
  );
}

export function managedRootfsCatalogUrl(refresh?: number | string): string {
  if (refresh == null) {
    return DEFAULT_ROOTFS_CATALOG_URL;
  }
  return `${DEFAULT_ROOTFS_CATALOG_URL}?refresh=${encodeURIComponent(
    `${refresh}`,
  )}`;
}
