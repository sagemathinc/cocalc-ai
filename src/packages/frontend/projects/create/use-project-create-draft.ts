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
  setProjectDraftAdvancedOpen,
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

function defaultTitle(): string {
  const ts = new Date().toISOString().split("T")[0];
  return `Untitled ${ts}`;
}

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
  const siteDefaultRootfs = useTypedRedux(
    "customize",
    "project_rootfs_default_image",
  );
  const siteDefaultRootfsGpu = useTypedRedux(
    "customize",
    "project_rootfs_default_image_gpu",
  );
  const accountDefaultRootfs = useTypedRedux("account", "default_rootfs_image");
  const accountDefaultRootfsGpu = useTypedRedux(
    "account",
    "default_rootfs_image_gpu",
  );
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const {
    images: rootfsImages,
    loading: rootfsLoading,
    error: rootfsError,
  } = useRootfsImages([managedRootfsCatalogUrl()]);
  const [selectedHost, setSelectedHost] = useState<Host | undefined>();

  const preferredRegion = useMemo(
    () =>
      mapCountryRegionToR2Region(cloudflareCountry, cloudflareRegionCode) ??
      DEFAULT_R2_REGION,
    [cloudflareCountry, cloudflareRegionCode],
  );

  const defaultTitleValue = defaultValue || defaultTitle();
  const context = useMemo<ProjectCreateContext>(
    () => ({
      defaultTitle: defaultTitleValue,
      preferredRegion,
      rootfsImages,
      selectedHost,
      siteDefaultRootfs,
      siteDefaultRootfsGpu,
      accountDefaultRootfs,
      accountDefaultRootfsGpu,
    }),
    [
      accountDefaultRootfs,
      accountDefaultRootfsGpu,
      defaultTitleValue,
      preferredRegion,
      rootfsImages,
      selectedHost,
      siteDefaultRootfs,
      siteDefaultRootfsGpu,
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

  const setAdvancedOpen = useCallback((advancedOpen: boolean) => {
    setDraft((cur) => setProjectDraftAdvancedOpen(cur, advancedOpen));
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
    setAdvancedOpen,
    setRegion,
    setHost,
    setRootfs,
    setStart,
    applyPreset,
    reset,
  };
}
