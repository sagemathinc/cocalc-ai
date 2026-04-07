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
import type { ProjectLauncherSettings } from "@cocalc/conat/hub/api/projects";

const launcherCache = new Map<string, ProjectLauncherSettings>();
const launcherListeners = new Map<
  string,
  Set<(value: ProjectLauncherSettings) => void>
>();

function currentLauncherValue({
  project_id,
  projectMapLauncher,
  initialLauncher,
}: {
  project_id: string;
  projectMapLauncher?: unknown;
  initialLauncher?: unknown;
}): ProjectLauncherSettings {
  if (projectMapLauncher !== undefined) {
    return (projectMapLauncher as ProjectLauncherSettings) ?? null;
  }
  if (initialLauncher !== undefined) {
    return (initialLauncher as ProjectLauncherSettings) ?? null;
  }
  return launcherCache.has(project_id) ? launcherCache.get(project_id)! : null;
}

function publishLauncher(
  project_id: string,
  value: ProjectLauncherSettings,
): void {
  launcherCache.set(project_id, value ?? null);
  for (const listener of launcherListeners.get(project_id) ?? []) {
    listener(value ?? null);
  }
}

export function useProjectLauncher(
  project_id: string,
  initialLauncher?: unknown,
) {
  const projectMapLauncher = useTypedRedux("projects", "project_map")?.getIn([
    project_id,
    "launcher",
  ]);
  const [counter, setCounter] = useState<number>(0);
  const [launcher, setLauncherState] = useState<ProjectLauncherSettings>(() =>
    currentLauncherValue({ project_id, projectMapLauncher, initialLauncher }),
  );
  const requestSeq = useRef<number>(0);

  const setLauncher = useCallback(
    (value: ProjectLauncherSettings) => {
      publishLauncher(project_id, value ?? null);
    },
    [project_id],
  );

  useEffect(() => {
    setLauncherState(
      currentLauncherValue({ project_id, projectMapLauncher, initialLauncher }),
    );
  }, [project_id, projectMapLauncher, initialLauncher]);

  useEffect(() => {
    let listeners = launcherListeners.get(project_id);
    if (!listeners) {
      listeners = new Set();
      launcherListeners.set(project_id, listeners);
    }
    listeners.add(setLauncherState);
    return () => {
      const next = launcherListeners.get(project_id);
      next?.delete(setLauncherState);
      if (next?.size === 0) {
        launcherListeners.delete(project_id);
      }
    };
  }, [project_id]);

  useEffect(() => {
    if (projectMapLauncher !== undefined) {
      setLauncher(projectMapLauncher as ProjectLauncherSettings);
    }
  }, [projectMapLauncher, setLauncher]);

  useEffect(() => {
    if (initialLauncher !== undefined) {
      setLauncher(initialLauncher as ProjectLauncherSettings);
    }
  }, [initialLauncher, setLauncher]);

  useAsyncEffect(
    async (isMounted) => {
      if (!project_id) {
        return;
      }
      if (
        counter === 0 &&
        (projectMapLauncher !== undefined ||
          initialLauncher !== undefined ||
          launcherCache.has(project_id))
      ) {
        return;
      }
      const requestId = ++requestSeq.current;
      const value =
        await webapp_client.conat_client.hub.projects.getProjectLauncher({
          project_id,
        });
      if (!isMounted() || requestId !== requestSeq.current) {
        return;
      }
      setLauncher(value ?? null);
    },
    [counter, initialLauncher, project_id, projectMapLauncher, setLauncher],
  );

  return {
    launcher,
    refresh: () => setCounter((prev) => prev + 1),
    setLauncher,
  };
}
