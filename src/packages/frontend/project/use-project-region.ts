/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  useAsyncEffect,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectRegion } from "@cocalc/conat/hub/api/projects";

const regionCache = new Map<string, ProjectRegion>();
const regionListeners = new Map<string, Set<(value: ProjectRegion) => void>>();

function currentRegionValue({
  project_id,
  projectMapRegion,
}: {
  project_id: string;
  projectMapRegion?: unknown;
}): ProjectRegion {
  if (projectMapRegion !== undefined) {
    return (projectMapRegion as ProjectRegion) ?? null;
  }
  return regionCache.has(project_id) ? regionCache.get(project_id)! : null;
}

function publishRegion(project_id: string, value: ProjectRegion): void {
  regionCache.set(project_id, value ?? null);
  for (const listener of regionListeners.get(project_id) ?? []) {
    listener(value ?? null);
  }
}

export function useProjectRegion(project_id: string) {
  const projectMapRegion = useTypedRedux("projects", "project_map")?.getIn([
    project_id,
    "region",
  ]);
  const [counter, setCounter] = useState<number>(0);
  const [region, setRegionState] = useState<ProjectRegion>(() =>
    currentRegionValue({ project_id, projectMapRegion }),
  );
  const requestSeq = useRef<number>(0);

  const setRegion = useCallback(
    (value: ProjectRegion) => {
      publishRegion(project_id, value ?? null);
    },
    [project_id],
  );

  useEffect(() => {
    setRegionState(currentRegionValue({ project_id, projectMapRegion }));
  }, [project_id, projectMapRegion]);

  useEffect(() => {
    let listeners = regionListeners.get(project_id);
    if (!listeners) {
      listeners = new Set();
      regionListeners.set(project_id, listeners);
    }
    listeners.add(setRegionState);
    return () => {
      const next = regionListeners.get(project_id);
      next?.delete(setRegionState);
      if (next?.size === 0) {
        regionListeners.delete(project_id);
      }
    };
  }, [project_id]);

  useEffect(() => {
    if (projectMapRegion !== undefined) {
      setRegion(projectMapRegion as ProjectRegion);
    }
  }, [projectMapRegion, setRegion]);

  useAsyncEffect(
    async (isMounted) => {
      if (!project_id) {
        return;
      }
      if (
        counter === 0 &&
        (projectMapRegion !== undefined || regionCache.has(project_id))
      ) {
        return;
      }
      const requestId = ++requestSeq.current;
      const value =
        await webapp_client.conat_client.hub.projects.getProjectRegion({
          project_id,
        });
      if (!isMounted() || requestId !== requestSeq.current) {
        return;
      }
      setRegion(value ?? null);
    },
    [counter, project_id, projectMapRegion, setRegion],
  );

  return {
    region,
    refresh: () => setCounter((prev) => prev + 1),
    setRegion,
  };
}
