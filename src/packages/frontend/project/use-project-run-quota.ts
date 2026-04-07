/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectRunQuota } from "@cocalc/conat/hub/api/projects";
import {
  createProjectFieldState,
  ensureProjectFieldValue,
  getCachedProjectFieldValue,
  subscribeProjectFieldValue,
  useProjectField,
} from "./use-project-field";

const runQuotaFieldState =
  createProjectFieldState<ProjectRunQuota>("run_quota");

async function fetchProjectRunQuota(
  project_id: string,
): Promise<ProjectRunQuota> {
  return await webapp_client.conat_client.hub.projects.getProjectRunQuota({
    project_id,
  });
}

export function getCachedProjectRunQuota(
  project_id: string,
): ProjectRunQuota | null | undefined {
  return getCachedProjectFieldValue({
    state: runQuotaFieldState,
    project_id,
  });
}

export async function ensureProjectRunQuota(
  project_id: string,
): Promise<ProjectRunQuota | null> {
  return await ensureProjectFieldValue({
    state: runQuotaFieldState,
    project_id,
    fetch: fetchProjectRunQuota,
  });
}

export function subscribeProjectRunQuota(
  project_id: string,
  listener: (runQuota: ProjectRunQuota | null) => void,
): () => void {
  return subscribeProjectFieldValue({
    state: runQuotaFieldState,
    project_id,
    listener,
  });
}

export function useProjectRunQuotaPrefetch(
  project_ids: ReadonlyArray<string | undefined | null>,
): number {
  const requestedProjectIdsKey = project_ids
    .map((id) => `${id ?? ""}`.trim())
    .join("\0");
  const normalizedProjectIds = useMemo(
    () =>
      [
        ...new Set(
          project_ids.map((id) => `${id ?? ""}`.trim()).filter(Boolean),
        ),
      ].sort(),
    [requestedProjectIdsKey],
  );
  const projectIdsKey = normalizedProjectIds.join(",");
  const [version, setVersion] = useState<number>(0);

  useEffect(() => {
    if (normalizedProjectIds.length === 0) {
      return;
    }
    const unsubscribers = normalizedProjectIds.map((project_id) =>
      subscribeProjectRunQuota(project_id, () =>
        setVersion((prev) => prev + 1),
      ),
    );
    void Promise.all(
      normalizedProjectIds.map((project_id) =>
        ensureProjectRunQuota(project_id).catch(() => null),
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [projectIdsKey, normalizedProjectIds]);

  return version;
}

export function useProjectRunQuota(project_id: string) {
  const projectStatus = useTypedRedux({ project_id }, "status");
  const projectState = `${projectStatus?.get("state") ?? ""}`.trim();
  const {
    value: runQuota,
    refresh,
    setValue: setRunQuota,
  } = useProjectField({
    state: runQuotaFieldState,
    project_id,
    projectMapField: "run_quota",
    fetch: fetchProjectRunQuota,
  });

  useEffect(() => {
    if (!project_id) {
      return;
    }
    refresh();
  }, [project_id, projectState, refresh]);

  return {
    runQuota,
    refresh,
    setRunQuota,
  };
}
