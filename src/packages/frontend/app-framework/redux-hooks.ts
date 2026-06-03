/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*

**IMPORTANT:** TYPED REDUX HOOKS -- If you use

        useTypedRedux('name' | {project_id:'the project id'}, 'one field')

then you will get good guaranteed typing (unless, of course, the global store
hasn't been converted to typescript yet!). If you use plain useRedux, you
get a dangerous "any" type out!

---

Hook for getting anything from our global redux store, and this should
also work fine with computed properties.

Use it is as follows:

With a named store, such as "projects", "account", "page", etc.:

 useRedux(['name-of-store', 'path', 'in', 'store'])

With a specific project:

 useRedux(['path', 'in', 'project store'], 'project-id')

Or with an editor in a project:

 useRedux(['path', 'in', 'project store'], 'project-id', 'path')

If you don't know the name of the store initially, you can use a name of '',
and you'll always get back undefined.

 useRedux(['', 'other', 'stuff']) === undefined
*/

import { is_valid_uuid_string } from "@cocalc/util/misc";
import { redux, ProjectActions, ProjectStore } from "../app-framework";
import { ProjectStoreState } from "../project/redux/store";
import React, { useEffect, useRef } from "react";
import * as types from "./actions-and-stores";

export function useReduxNamedStore(path: string[]) {
  return useRedux(path);
}

function useReduxEditorStore(
  path: string[],
  project_id: string,
  filename: string,
) {
  const [value, set_value] = React.useState(() =>
    // the editor itself might not be defined hence the ?. below:
    redux
      .getEditorStore(project_id, filename)
      ?.getIn(path as [string, string, string, string, string]),
  );

  useEffect(() => {
    let store = redux.getEditorStore(project_id, filename);
    let last_value = value;
    const f = (obj) => {
      if (obj == null || !f.is_mounted) return; // see comment for useReduxNamedStore
      const new_value = obj.getIn(path);
      if (last_value !== new_value) {
        last_value = new_value;
        set_value(new_value);
      }
    };
    f.is_mounted = true;
    f(store);
    if (store != null) {
      store.on("change", f);
    } else {
      /* This code is extra complicated since we account for the case
         when getEditorStore is undefined then becomes defined.
         Very rarely there are components that useRedux and somehow
         manage to do so before the editor store gets created.
         NOTE: I might be able to solve this same problem with
         simpler code with useAsyncEffect...
      */
      const g = () => {
        if (!f.is_mounted) {
          unsubscribe();
          return;
        }
        store = redux.getEditorStore(project_id, filename);
        if (store != null) {
          unsubscribe();
          f(store); // may have missed an initial change
          store.on("change", f);
        }
      };
      const unsubscribe = redux.reduxStore.subscribe(g);
    }

    return () => {
      f.is_mounted = false;
      store?.removeListener("change", f);
    };
  }, [...path, project_id, filename]);

  return value;
}

export interface StoreStates {
  account: types.AccountState;
  "admin-users": types.AdminUsersState;
  billing: types.BillingState;
  customize: types.CustomizeState;
  mentions: types.MentionsState;
  page: types.PageState;
  projects: types.ProjectsState;
  users: types.UsersState;
  news: types.NewsState;
}

export function useTypedRedux<
  T extends keyof StoreStates,
  S extends keyof StoreStates[T],
>(store: T, field: S): StoreStates[T][S];

export function useTypedRedux<S extends keyof ProjectStoreState>(
  project_id: { project_id: string },
  field: S,
): ProjectStoreState[S];

export function useTypedRedux(
  a: keyof StoreStates | { project_id: string },
  field: string,
) {
  const path = typeof a == "string" ? [a, field] : [field];
  const projectId = typeof a == "string" ? undefined : a.project_id;
  return useRedux(path, projectId);
}

export function useAccountOtherSetting<T = any>(key: string): T | undefined {
  return useRedux(["account", "other_settings", key]) as T | undefined;
}

export function useProjectFromMap<T = any>(
  project_id: string | undefined,
): T | undefined {
  return useRedux(["projects", "project_map", project_id ?? ""]) as
    | T
    | undefined;
}

export function useProjectMapField<T = any>(
  project_id: string | undefined,
  path: string | string[],
): T | undefined {
  return useRedux([
    "projects",
    "project_map",
    project_id ?? "",
    ...(Array.isArray(path) ? path : [path]),
  ]) as T | undefined;
}

export function useEditorRedux<State>(editor: {
  project_id: string;
  path: string;
}) {
  function useField<S extends keyof State>(field: S): State[S] {
    return useReduxEditorStore(
      [field as string],
      editor.project_id,
      editor.path,
    ) as any;
  }
  return useField;
}

/*
export function useEditorRedux<State, S extends keyof State>(editor: {
  project_id: string;
  path: string;
}): State[S] {
  return useReduxEditorStore(
    [S as string],
    editor.project_id,
    editor.path
  ) as any;
}
*/
/*
export function useEditorRedux(
  editor: { project_id: string; path: string },
  field
): any {
  return useReduxEditorStore(
    [field as string],
    editor.project_id,
    editor.path
  ) as any;
}
*/

export function useRedux(
  path: string | string[],
  project_id?: string,
  filename?: string,
) {
  const resolved = resolveReduxPath(path, project_id, filename);
  const [value, set_value] = React.useState(() => getReduxValue(resolved));

  useEffect(() => {
    let last_value = getReduxValue(resolved);
    set_value(last_value);

    const update = (next_value) => {
      if (!update.is_mounted) return;
      if (last_value !== next_value) {
        last_value = next_value;
        set_value(next_value);
      }
    };
    update.is_mounted = true;
    const unsubscribe = subscribeReduxValue(resolved, update);
    return () => {
      update.is_mounted = false;
      unsubscribe();
    };
  }, getReduxDeps(resolved));

  return value;
}

type ResolvedReduxPath =
  | { kind: "named"; path: string[] }
  | { kind: "project"; path: string[]; projectId: string }
  | { kind: "editor"; path: string[]; projectId: string; filename: string };

function resolveReduxPath(
  path: string | string[],
  project_id?: string,
  filename?: string,
): ResolvedReduxPath {
  if (typeof path == "string") {
    // good typed version!! -- path specifies store
    if (typeof project_id != "string" || typeof filename != "undefined") {
      throw Error(
        "if first argument of useRedux is a string then second argument must also be and no other arguments can be specified",
      );
    }
    if (is_valid_uuid_string(path)) {
      return { kind: "project", path: [project_id], projectId: path };
    }
    return { kind: "named", path: [path, project_id] };
  }
  if (project_id == null) {
    return { kind: "named", path };
  }
  if (filename == null) {
    if (!is_valid_uuid_string(project_id)) {
      // this is used a lot by frame-tree editors right now.
      return { kind: "named", path: [project_id].concat(path) };
    }
    return { kind: "project", path, projectId: project_id };
  }
  return { kind: "editor", path, projectId: project_id, filename };
}

function getReduxValue(resolved: ResolvedReduxPath) {
  if (redux == null) return undefined;
  switch (resolved.kind) {
    case "named": {
      if ((redux as any).getStore == null) return undefined;
      const [name, ...subpath] = resolved.path;
      if (!name) return undefined;
      return redux.getStore(name)?.getIn(subpath as any) as any;
    }
    case "project":
      if ((redux as any).getProjectStore == null) return undefined;
      return redux
        .getProjectStore(resolved.projectId)
        ?.getIn(resolved.path as [string, string, string, string, string]);
    case "editor":
      if ((redux as any).getEditorStore == null) return undefined;
      return redux
        .getEditorStore(resolved.projectId, resolved.filename)
        ?.getIn(resolved.path as [string, string, string, string, string]);
  }
}

function getReduxDeps(resolved: ResolvedReduxPath): string[] {
  switch (resolved.kind) {
    case "named":
      return resolved.path;
    case "project":
      return [...resolved.path, resolved.projectId];
    case "editor":
      return [...resolved.path, resolved.projectId, resolved.filename];
  }
}

function subscribeReduxValue(
  resolved: ResolvedReduxPath,
  onValue: (value: any) => void,
) {
  return getSharedReduxSubscription(resolved).subscribe(onValue);
}

type ReduxValueSubscriber = (value: any) => void;

export interface ReduxHookSubscriptionDiagnostics {
  key: string;
  kind: ResolvedReduxPath["kind"];
  storeName?: string;
  projectId?: string;
  filename?: string;
  path: string[];
  subscriberCount: number;
  storeAttached: boolean;
  waitingForStore: boolean;
}

class SharedReduxSubscription {
  private subscribers = new Set<ReduxValueSubscriber>();
  private unsubscribeFromStore: () => void = () => {};
  private active = false;
  private storeAttached = false;
  private waitingForStore = false;
  private lastValue: any;

  constructor(
    private readonly key: string,
    private readonly resolved: ResolvedReduxPath,
  ) {
    this.lastValue = getReduxValue(resolved);
  }

  subscribe(onValue: ReduxValueSubscriber): () => void {
    this.subscribers.add(onValue);
    if (!this.active) {
      this.start();
    }
    onValue(this.lastValue);
    return () => {
      this.subscribers.delete(onValue);
      if (this.subscribers.size === 0) {
        this.stop();
        sharedReduxSubscriptions.delete(this.key);
      }
    };
  }

  diagnostics(): ReduxHookSubscriptionDiagnostics {
    return {
      key: this.key,
      kind: this.resolved.kind,
      storeName: storeNameFromResolvedReduxPath(this.resolved),
      projectId:
        this.resolved.kind === "project" || this.resolved.kind === "editor"
          ? this.resolved.projectId
          : undefined,
      filename:
        this.resolved.kind === "editor" ? this.resolved.filename : undefined,
      path: pathFromResolvedReduxPath(this.resolved),
      subscriberCount: this.subscribers.size,
      storeAttached: this.storeAttached,
      waitingForStore: this.waitingForStore,
    };
  }

  private start(): void {
    this.active = true;
    switch (this.resolved.kind) {
      case "named":
        this.startNamed();
        return;
      case "project":
        this.startProject();
        return;
      case "editor":
        this.startEditor();
        return;
    }
  }

  private stop(): void {
    this.active = false;
    this.storeAttached = false;
    this.waitingForStore = false;
    this.unsubscribeFromStore();
    this.unsubscribeFromStore = () => {};
  }

  private emit(value: any): void {
    if (this.lastValue === value) return;
    this.lastValue = value;
    for (const subscriber of Array.from(this.subscribers)) {
      subscriber(value);
    }
  }

  private startNamed(): void {
    if (redux == null) return;
    if ((redux as any).getStore == null) return;
    const [name, ...subpath] = this.resolved.path;
    if (!name) return;
    const store = redux.getStore(name);
    if (store == null) {
      console.warn(`store "${name}" must exist; path=`, this.resolved.path);
      return;
    }
    const handleChange = () => {
      this.emit(store.getIn(subpath as any));
    };
    store.on("change", handleChange);
    this.storeAttached = true;
    this.unsubscribeFromStore = () => {
      store.removeListener("change", handleChange);
    };
    handleChange();
  }

  private startProject(): void {
    if (redux == null) return;
    if ((redux as any).getProjectStore == null) return;
    if (this.resolved.kind !== "project") return;
    const resolved = this.resolved;
    const store = redux.getProjectStore(resolved.projectId);
    if (store == null) return;
    const handleChange = (obj) => {
      if (obj == null) return;
      this.emit(
        obj.getIn(resolved.path as [string, string, string, string, string]),
      );
    };
    store.on("change", handleChange);
    this.storeAttached = true;
    this.unsubscribeFromStore = () => {
      store.removeListener("change", handleChange);
    };
    handleChange(store);
  }

  private startEditor(): void {
    if (redux == null) return;
    if ((redux as any).getEditorStore == null) return;
    if (this.resolved.kind !== "editor") return;
    const resolved = this.resolved;
    let store = redux.getEditorStore(resolved.projectId, resolved.filename);
    let handleChange: ((obj) => void) | undefined;

    const attachStore = (nextStore) => {
      store = nextStore;
      handleChange = (obj) => {
        if (obj == null || !this.active) return;
        this.emit(
          obj.getIn(resolved.path as [string, string, string, string, string]),
        );
      };
      this.waitingForStore = false;
      this.storeAttached = true;
      store.on("change", handleChange);
      handleChange(store);
    };

    if (store != null) {
      attachStore(store);
      this.unsubscribeFromStore = () => {
        if (handleChange != null) {
          store?.removeListener("change", handleChange);
        }
      };
      return;
    }

    this.waitingForStore = true;
    if (redux.reduxStore?.subscribe == null) return;
    const unsubscribe = redux.reduxStore.subscribe(() => {
      if (!this.active) {
        unsubscribe();
        return;
      }
      const nextStore = redux.getEditorStore(
        resolved.projectId,
        resolved.filename,
      );
      if (nextStore != null) {
        unsubscribe();
        attachStore(nextStore);
      }
    });
    this.unsubscribeFromStore = () => {
      unsubscribe();
      if (handleChange != null) {
        store?.removeListener("change", handleChange);
      }
    };
  }
}

const sharedReduxSubscriptions = new Map<string, SharedReduxSubscription>();

function getSharedReduxSubscription(
  resolved: ResolvedReduxPath,
): SharedReduxSubscription {
  const key = resolvedReduxPathKey(resolved);
  let subscription = sharedReduxSubscriptions.get(key);
  if (subscription == null) {
    subscription = new SharedReduxSubscription(key, resolved);
    sharedReduxSubscriptions.set(key, subscription);
  }
  return subscription;
}

function resolvedReduxPathKey(resolved: ResolvedReduxPath): string {
  switch (resolved.kind) {
    case "named":
      return JSON.stringify(["named", resolved.path]);
    case "project":
      return JSON.stringify(["project", resolved.projectId, resolved.path]);
    case "editor":
      return JSON.stringify([
        "editor",
        resolved.projectId,
        resolved.filename,
        resolved.path,
      ]);
  }
}

function storeNameFromResolvedReduxPath(
  resolved: ResolvedReduxPath,
): string | undefined {
  switch (resolved.kind) {
    case "named":
      return resolved.path[0];
    case "project":
      return `project-${resolved.projectId}`;
    case "editor":
      return `editor-${resolved.projectId}-${resolved.filename}`;
  }
}

function pathFromResolvedReduxPath(resolved: ResolvedReduxPath): string[] {
  switch (resolved.kind) {
    case "named":
      return resolved.path.slice(1);
    case "project":
    case "editor":
      return resolved.path;
  }
}

export function collectReduxHookSubscriptionDiagnostics() {
  const subscriptions = Array.from(sharedReduxSubscriptions.values()).map(
    (subscription) => subscription.diagnostics(),
  );
  subscriptions.sort((a, b) => b.subscriberCount - a.subscriberCount);
  return {
    subscriptionCount: subscriptions.length,
    totalSubscribers: subscriptions.reduce(
      (sum, subscription) => sum + subscription.subscriberCount,
      0,
    ),
    topSubscriptions: subscriptions.slice(0, 50),
  };
}

/*
Hook to get the actions associated to a named actions/store,
a project, or an editor.  If the first argument is a uuid,
then it's the project actions or editor actions; otherwise,
it's one of the other named actions or undefined.
*/

export function useActions(name: "account"): types.AccountActions;
export function useActions(name: "admin-users"): types.AdminUsersActions;
export function useActions(name: "billing"): types.BillingActions;
export function useActions(name: "document_activity"): types.FileUseActions;
export function useActions(name: "mentions"): types.MentionsActions;
export function useActions(name: "page"): types.PageActions;
export function useActions(name: "projects"): types.ProjectsActions;
export function useActions(name: "users"): types.UsersActions;
export function useActions(name: "news"): types.NewsActions;
export function useActions(name: "customize"): types.CustomizeActions;

// If it is none of the explicitly named ones... it's a project or just some general actions.
// That said *always* use {project_id} as below to get the actions for a project, so you
// get proper typing.
export function useActions(x: string): any;

export function useActions<T>(x: { name: string }): T;

// Return type includes undefined because the actions for a project *do* get
// destroyed when closing a project, and rendering can still happen during this
// time, so client code must account for this.
export function useActions(x: {
  project_id: string;
}): ProjectActions | undefined;

// Or an editor actions (any for now)
export function useActions(x: string, path: string): any;

export function useActions(x, path?: string) {
  return React.useMemo(() => {
    let actions;
    if (path != null) {
      actions = redux.getEditorActions(x, path);
    } else {
      if (x?.name != null) {
        actions = redux.getActions(x.name);
      } else if (x?.project_id != null) {
        // return here to avoid null check below; it can be null
        return redux.getProjectActions(x.project_id);
      } else if (is_valid_uuid_string(x)) {
        // return here to avoid null check below; it can be null
        return redux.getProjectActions(x);
      } else {
        actions = redux.getActions(x);
      }
    }
    if (actions == null) {
      throw Error(`BUG: actions for "${path}" must be defined but is not`);
    }
    return actions;
  }, [x, path]);
}

// WARNING: I tried to define this Stores interface
// in actions-and-stores.ts but it did NOT work. All
// the types just became any or didn't match.  Don't
// move this unless you also fully test it!!
import { Store } from "@cocalc/util/redux/Store";
import { isEqual } from "lodash";
export interface Stores {
  account: types.AccountStore;
  "admin-users": types.AdminUsersStore;
  billing: types.BillingStore;
  customize: types.CustomizeStore;
  mentions: types.MentionsStore;
  page: types.PageStore;
  projects: types.ProjectsStore;
  users: types.UsersStore;
  news: types.NewsStore;
}

// If it is none of the explicitly named ones... it's a project.
//export function useStore(name: "projects"): types.ProjectsStore;
export function useStore<T extends keyof Stores>(name: T): Stores[T];
export function useStore(x: { project_id: string }): ProjectStore;
export function useStore<T>(x: { name: string }): T;
// Or an editor store (any for now):
//export function useStore(project_id: string, path: string): Store<any>;
export function useStore(x): any {
  return React.useMemo(() => {
    let store;
    if (x?.project_id != null) {
      store = redux.getProjectStore(x.project_id);
    } else if (x?.name != null) {
      store = redux.getStore(x.name);
    } else if (is_valid_uuid_string(x)) {
      store = redux.getProjectStore(x);
    } else {
      store = redux.getStore(x);
    }
    if (store == null) {
      throw Error("store must be defined");
    }
    return store;
  }, [x]) as Store<any>;
}

// Debug which props changed in a component
export function useTraceUpdate(props) {
  const prev = useRef(props);
  useEffect(() => {
    const changedProps = Object.entries(props).reduce((ps, [k, v]) => {
      if (!isEqual(prev.current[k], v)) {
        ps[k] = [prev.current[k], v];
      }
      return ps;
    }, {});
    if (Object.keys(changedProps).length > 0) {
      console.log("Changed props:", changedProps);
    }
    prev.current = props;
  });
}
