/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
This is the shared pattern for getting realtime-ish access to a single field
for a particular project without putting that field into the global
`projects.project_map` payload.

The direction of the frontend projects transition is that `project_map` should
stabilize as a small control-plane snapshot with a minimal, explicit set of
fields. Project-specific detail fields such as launcher defaults, region,
environment, rootfs configuration, etc., should instead be loaded through a
small per-field hook built on top of this helper.

The helper gives each field:

- a per-project in-memory cache,
- local fanout so multiple components share one value,
- optional bootstrap from `project_map` while a field is still being migrated,
- explicit refresh/fetch behavior, and
- local `setValue(...)` updates so the UI stays responsive after writes.
*/

import {
  useAsyncEffect,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";

export interface ProjectFieldState<T> {
  cache: Map<string, T | null>;
  listeners: Map<string, Set<(value: T | null) => void>>;
}

export function createProjectFieldState<T>(): ProjectFieldState<T> {
  return {
    cache: new Map<string, T | null>(),
    listeners: new Map<string, Set<(value: T | null) => void>>(),
  };
}

function currentProjectFieldValue<T>({
  state,
  project_id,
  projectMapValue,
  initialValue,
}: {
  state: ProjectFieldState<T>;
  project_id: string;
  projectMapValue?: unknown;
  initialValue?: unknown;
}): T | null {
  if (projectMapValue !== undefined) {
    return (projectMapValue as T | null) ?? null;
  }
  if (initialValue !== undefined) {
    return (initialValue as T | null) ?? null;
  }
  return state.cache.has(project_id) ? state.cache.get(project_id)! : null;
}

function publishProjectFieldValue<T>({
  state,
  project_id,
  value,
}: {
  state: ProjectFieldState<T>;
  project_id: string;
  value: T | null;
}): void {
  state.cache.set(project_id, value ?? null);
  for (const listener of state.listeners.get(project_id) ?? []) {
    listener(value ?? null);
  }
}

export function useProjectField<T>({
  state,
  project_id,
  projectMapField,
  fetch,
  initialValue,
}: {
  state: ProjectFieldState<T>;
  project_id: string;
  projectMapField: string;
  fetch: (project_id: string) => Promise<T | null>;
  initialValue?: unknown;
}) {
  const projectMapValue = useTypedRedux("projects", "project_map")?.getIn([
    project_id,
    projectMapField,
  ]);
  const [counter, setCounter] = useState<number>(0);
  const [value, setValueState] = useState<T | null>(() =>
    currentProjectFieldValue({
      state,
      project_id,
      projectMapValue,
      initialValue,
    }),
  );
  const requestSeq = useRef<number>(0);

  const setValue = useCallback(
    (nextValue: T | null) => {
      publishProjectFieldValue({
        state,
        project_id,
        value: nextValue ?? null,
      });
    },
    [project_id, state],
  );

  useEffect(() => {
    setValueState(
      currentProjectFieldValue({
        state,
        project_id,
        projectMapValue,
        initialValue,
      }),
    );
  }, [initialValue, projectMapValue, project_id, state]);

  useEffect(() => {
    let listeners = state.listeners.get(project_id);
    if (!listeners) {
      listeners = new Set();
      state.listeners.set(project_id, listeners);
    }
    listeners.add(setValueState);
    return () => {
      const next = state.listeners.get(project_id);
      next?.delete(setValueState);
      if (next?.size === 0) {
        state.listeners.delete(project_id);
      }
    };
  }, [project_id, state]);

  useEffect(() => {
    if (projectMapValue !== undefined) {
      setValue((projectMapValue as T | null) ?? null);
    }
  }, [projectMapValue, setValue]);

  useEffect(() => {
    if (initialValue !== undefined) {
      setValue((initialValue as T | null) ?? null);
    }
  }, [initialValue, setValue]);

  useAsyncEffect(
    async (isMounted) => {
      if (!project_id) {
        return;
      }
      if (
        counter === 0 &&
        (projectMapValue !== undefined ||
          initialValue !== undefined ||
          state.cache.has(project_id))
      ) {
        return;
      }
      const requestId = ++requestSeq.current;
      const nextValue = await fetch(project_id);
      if (!isMounted() || requestId !== requestSeq.current) {
        return;
      }
      setValue(nextValue ?? null);
    },
    [
      counter,
      fetch,
      initialValue,
      project_id,
      projectMapValue,
      setValue,
      state,
    ],
  );

  return {
    value,
    refresh: () => setCounter((prev) => prev + 1),
    setValue,
  };
}
