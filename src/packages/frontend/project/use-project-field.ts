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
  redux,
  useAsyncEffect,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  accountFeedStreamName,
  type AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export interface ProjectFieldState<T> {
  field: string;
  cache: Map<string, T | null>;
  listeners: Map<string, Set<(value: T | null) => void>>;
  refreshers: Map<string, Set<() => void>>;
}

const projectFieldStates = new Map<string, ProjectFieldState<any>>();
const projectDetailInvalidationListeners = new Map<
  string,
  Set<(fields: string[]) => void>
>();
const pendingProjectDetailInvalidations = new Map<string, Set<string>>();
const projectDetailInvalidationTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const PROJECT_DETAIL_INVALIDATION_DEBOUNCE_MS = 300;

function normalizeProjectDetailFields(fields: string[]): string[] {
  return [...new Set(fields.map((field) => `${field}`.trim()).filter(Boolean))];
}

function getProjectCollaboratorAccountIds(project_id: string): string[] {
  const users = redux
    .getStore("projects")
    ?.getIn(["project_map", project_id, "users"]);
  if (users == null) {
    return [];
  }
  if (typeof users.keySeq === "function") {
    return normalizeProjectDetailFields(users.keySeq().toArray());
  }
  if (typeof users === "object") {
    return normalizeProjectDetailFields(Object.keys(users));
  }
  return [];
}

export function createProjectFieldState<T>(
  field: string,
): ProjectFieldState<T> {
  const existing = projectFieldStates.get(field);
  if (existing != null) {
    return existing as ProjectFieldState<T>;
  }
  const state = {
    field,
    cache: new Map<string, T | null>(),
    listeners: new Map<string, Set<(value: T | null) => void>>(),
    refreshers: new Map<string, Set<() => void>>(),
  };
  projectFieldStates.set(field, state);
  return state;
}

export function subscribeProjectDetailInvalidation(
  project_id: string,
  listener: (fields: string[]) => void,
): () => void {
  let listeners = projectDetailInvalidationListeners.get(project_id);
  if (!listeners) {
    listeners = new Set();
    projectDetailInvalidationListeners.set(project_id, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = projectDetailInvalidationListeners.get(project_id);
    current?.delete(listener);
    if (current?.size === 0) {
      projectDetailInvalidationListeners.delete(project_id);
    }
  };
}

export function invalidateProjectFields({
  project_id,
  fields,
}: {
  project_id: string;
  fields: string[];
}): void {
  const normalizedFields = normalizeProjectDetailFields(fields);
  if (!project_id || normalizedFields.length === 0) {
    return;
  }

  for (const field of normalizedFields) {
    const state = projectFieldStates.get(field);
    if (!state) continue;
    state.cache.delete(project_id);
    for (const refresh of state.refreshers.get(project_id) ?? []) {
      refresh();
    }
  }

  for (const listener of projectDetailInvalidationListeners.get(project_id) ??
    []) {
    listener(normalizedFields);
  }
}

async function flushProjectDetailInvalidation(
  project_id: string,
): Promise<void> {
  const fields = normalizeProjectDetailFields([
    ...(pendingProjectDetailInvalidations.get(project_id) ?? []),
  ]);
  pendingProjectDetailInvalidations.delete(project_id);
  projectDetailInvalidationTimers.delete(project_id);
  if (!project_id || fields.length === 0) {
    return;
  }
  const account_ids = getProjectCollaboratorAccountIds(project_id);
  await Promise.all(
    account_ids.map(async (account_id) => {
      const stream = webapp_client.conat_client.astream<AccountFeedEvent>({
        account_id,
        name: accountFeedStreamName(),
        ephemeral: true,
      });
      try {
        await stream.publish({
          type: "project.detail.invalidate",
          ts: Date.now(),
          account_id,
          project_id,
          fields,
        });
      } catch (err) {
        console.warn("unable to publish project detail invalidation", {
          project_id,
          account_id,
          fields,
          err,
        });
      } finally {
        stream.close();
      }
    }),
  );
}

export function publishProjectDetailInvalidation({
  project_id,
  fields,
}: {
  project_id: string;
  fields: string[];
}): void {
  const normalizedFields = normalizeProjectDetailFields(fields);
  if (!project_id || normalizedFields.length === 0) {
    return;
  }
  invalidateProjectFields({ project_id, fields: normalizedFields });
  let pending = pendingProjectDetailInvalidations.get(project_id);
  if (!pending) {
    pending = new Set();
    pendingProjectDetailInvalidations.set(project_id, pending);
  }
  for (const field of normalizedFields) {
    pending.add(field);
  }
  if (projectDetailInvalidationTimers.has(project_id)) {
    return;
  }
  projectDetailInvalidationTimers.set(
    project_id,
    setTimeout(() => {
      void flushProjectDetailInvalidation(project_id);
    }, PROJECT_DETAIL_INVALIDATION_DEBOUNCE_MS),
  );
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
  const refresh = useCallback(() => setCounter((prev) => prev + 1), []);

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
    let refreshers = state.refreshers.get(project_id);
    if (!refreshers) {
      refreshers = new Set();
      state.refreshers.set(project_id, refreshers);
    }
    refreshers.add(refresh);
    return () => {
      const current = state.refreshers.get(project_id);
      current?.delete(refresh);
      if (current?.size === 0) {
        state.refreshers.delete(project_id);
      }
    };
  }, [project_id, refresh, state]);

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
    refresh,
    setValue,
  };
}
