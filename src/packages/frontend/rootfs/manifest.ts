/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import {
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
      urls
        .map((url) => url?.trim())
        .filter((url) => url && url.length > 0),
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

export async function loadRootfsImages(
  manifestUrls: string[],
): Promise<RootfsImageEntry[]> {
  const urls = normalizeUrls(manifestUrls);
  if (urls.length === 0) {
    return [];
  }
  const key = urls.join("|");
  const cached = manifestCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const manifests = await Promise.all(urls.map(fetchManifest));
    return mergeRootfsManifests(
      manifests.filter((manifest): manifest is RootfsImageManifest => !!manifest),
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

  useEffect(() => {
    let active = true;
    if (urls.length === 0) {
      setState({ images: [], loading: false });
      return () => {
        active = false;
      };
    }
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    loadRootfsImages(urls)
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
  }, [urls.join("|")]);

  return state;
}

