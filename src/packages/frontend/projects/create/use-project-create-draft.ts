/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Host } from "@cocalc/conat/hub/api/hosts";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { latestRootfsUpgradeEntry } from "@cocalc/frontend/rootfs/catalog-ui";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import type { RecentProjectImage } from "../create-project-rootfs";
import {
  DEFAULT_R2_REGION,
  mapCountryRegionToR2Region,
  type R2Region,
} from "@cocalc/util/consts";
import {
  applyProjectPreset,
  createInitialProjectDraft,
  normalizeProjectDraft,
  projectDraftSummary,
  setProjectDraftHost,
  setProjectDraftRegion,
  setProjectDraftRootfs,
  setProjectDraftStart,
  setProjectDraftTitle,
  type ProjectCreateContext,
  type ProjectCreateDraft,
  type ProjectCreateMode,
  type ProjectRootfsSelection,
} from "./project-create-draft";

export function useProjectCreateDraft({
  defaultValue,
}: {
  defaultValue: string;
}) {
  const cloudflareCountry = useTypedRedux("customize", "country");
  const cloudflareRegionCode = useTypedRedux(
    "customize",
    "cloudflare_region_code",
  );
  const accountDefaultRootfs = useTypedRedux("account", "default_rootfs_image");
  const accountDefaultRootfsGpu = useTypedRedux(
    "account",
    "default_rootfs_image_gpu",
  );
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const recentProjectImages = useRecentProjectImages();
  const {
    images: rootfsImages,
    loading: rootfsLoading,
    error: rootfsError,
  } = useRootfsImages([managedRootfsCatalogUrl()], {
    limit: 1000,
  });
  const [selectedHost, setSelectedHost] = useState<Host | undefined>();
  const latestRootfsVersion = useCallback(
    (entry: RootfsImageEntry) =>
      latestRootfsUpgradeEntry({ current: entry, images: rootfsImages }) ??
      entry,
    [rootfsImages],
  );

  const preferredRegion = useMemo(
    () =>
      mapCountryRegionToR2Region(cloudflareCountry, cloudflareRegionCode) ??
      DEFAULT_R2_REGION,
    [cloudflareCountry, cloudflareRegionCode],
  );

  const defaultTitleValue = defaultValue.trim();
  const context = useMemo<ProjectCreateContext>(
    () => ({
      defaultTitle: defaultTitleValue,
      preferredRegion,
      rootfsImages,
      selectedHost,
      accountDefaultRootfs,
      accountDefaultRootfsGpu,
      recentProjectImages,
      latestRootfsVersion,
      isAdmin,
    }),
    [
      accountDefaultRootfs,
      accountDefaultRootfsGpu,
      defaultTitleValue,
      isAdmin,
      latestRootfsVersion,
      preferredRegion,
      recentProjectImages,
      rootfsImages,
      selectedHost,
    ],
  );

  const [draft, setDraft] = useState<ProjectCreateDraft>(() =>
    createInitialProjectDraft(context),
  );

  useEffect(() => {
    setDraft((cur) => normalizeProjectDraft(cur, context));
  }, [context]);

  useEffect(() => {
    if (selectedHost && draft.host_id !== selectedHost.id) {
      setSelectedHost(undefined);
    }
  }, [draft.host_id, selectedHost]);

  const reset = useCallback(() => {
    setSelectedHost(undefined);
    setDraft(
      createInitialProjectDraft({ ...context, selectedHost: undefined }),
    );
  }, [context]);

  const setTitle = useCallback((title: string) => {
    setDraft((cur) => setProjectDraftTitle(cur, title));
  }, []);

  const setRegion = useCallback(
    (region: R2Region) => {
      setDraft((cur) => setProjectDraftRegion(cur, region, context));
    },
    [context],
  );

  const setHost = useCallback(
    (host?: Host) => {
      setSelectedHost(host);
      setDraft((cur) => setProjectDraftHost(cur, host, context));
    },
    [context],
  );

  const setRootfs = useCallback(
    (rootfs: ProjectRootfsSelection) => {
      setDraft((cur) => setProjectDraftRootfs(cur, rootfs, context));
    },
    [context],
  );

  const setStart = useCallback((start: boolean) => {
    setDraft((cur) => setProjectDraftStart(cur, start));
  }, []);

  const applyPreset = useCallback(
    (mode: ProjectCreateMode) => {
      setDraft((cur) => applyProjectPreset(cur, mode, context));
    },
    [context],
  );

  const summary = useMemo(
    () => projectDraftSummary(draft, context),
    [context, draft],
  );

  return {
    draft,
    summary,
    context,
    rootfsImages,
    rootfsLoading,
    rootfsError,
    isAdmin,
    selectedHost,
    setTitle,
    setRegion,
    setHost,
    setRootfs,
    setStart,
    applyPreset,
    reset,
  };
}

const RECENT_PROJECTS = 25;

// Your projects with a catalog image, most recently used *by you* first (a
// collaborator's activity in a shared project does not count).
export function recentProjectImagesFromMap(
  projectMap: any,
  accountId?: string,
): RecentProjectImage[] {
  if (!projectMap || !accountId) return [];
  const list: (RecentProjectImage & { used: number })[] = [];
  projectMap.forEach((project: any, project_id: string) => {
    if (project?.get?.("deleted")) return;
    const image_id = `${project.get("rootfs_image_id") ?? ""}`.trim();
    const used = new Date(
      project.getIn(["last_active", accountId]) ?? 0,
    ).valueOf();
    if (!image_id || !used) return;
    list.push({
      project_id,
      title: `${project.get("title") ?? ""}`.trim() || "Untitled",
      image_id,
      used,
    });
  });
  return list
    .sort((a, b) => b.used - a.used)
    .slice(0, RECENT_PROJECTS)
    .map(({ used: _used, ...project }) => project);
}

function useRecentProjectImages(): RecentProjectImage[] {
  const projectMap = useTypedRedux("projects", "project_map");
  const accountId = useTypedRedux("account", "account_id");
  const recent = recentProjectImagesFromMap(projectMap, accountId);
  // The project map changes constantly (states, activity); only a change in
  // this list should re-run the image default.
  const key = JSON.stringify(recent);
  return useMemo(() => recent, [key]);
}
