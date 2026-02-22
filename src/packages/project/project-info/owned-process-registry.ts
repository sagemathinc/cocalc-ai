/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

export interface OwnedRootProcessMeta {
  kind: string;
  path?: string;
  thread_id?: string;
  session_id?: string;
}

export interface OwnedRootProcess extends OwnedRootProcessMeta {
  root_id: string;
  spawned_at: number;
  pid?: number;
  start_time?: number;
  exited_at?: number;
}

export class OwnedProcessRegistry {
  private readonly roots = new Map<string, OwnedRootProcess>();
  private readonly pidToRoot = new Map<number, string>();

  registerRoot(
    meta: OwnedRootProcessMeta & {
      root_id?: string;
      pid?: number;
      start_time?: number;
      spawned_at?: number;
    },
  ): OwnedRootProcess {
    const root_id = meta.root_id ?? randomUUID();
    const root: OwnedRootProcess = {
      root_id,
      kind: meta.kind,
      path: meta.path,
      thread_id: meta.thread_id,
      session_id: meta.session_id,
      pid: meta.pid,
      start_time: meta.start_time,
      spawned_at: meta.spawned_at ?? Date.now(),
    };
    this.roots.set(root_id, root);
    if (meta.pid != null) {
      this.pidToRoot.set(meta.pid, root_id);
    }
    return root;
  }

  attachPid(root_id: string, pid: number, start_time?: number): OwnedRootProcess {
    const root = this.roots.get(root_id);
    if (root == null) {
      throw Error(`no such root_id '${root_id}'`);
    }
    if (root.pid != null && root.pid !== pid) {
      this.pidToRoot.delete(root.pid);
    }
    root.pid = pid;
    root.start_time = start_time;
    root.exited_at = undefined;
    this.pidToRoot.set(pid, root_id);
    return root;
  }

  markExited(root_id: string, opts?: { pid?: number; exited_at?: number }): void {
    const root = this.roots.get(root_id);
    if (root == null) {
      return;
    }
    root.exited_at = opts?.exited_at ?? Date.now();
    const pid = opts?.pid ?? root.pid;
    if (pid != null) {
      this.pidToRoot.delete(pid);
    }
  }

  removeRoot(root_id: string): void {
    const root = this.roots.get(root_id);
    if (root?.pid != null) {
      this.pidToRoot.delete(root.pid);
    }
    this.roots.delete(root_id);
  }

  getRoot(root_id: string): OwnedRootProcess | undefined {
    return this.roots.get(root_id);
  }

  getRootForPid(pid: number): OwnedRootProcess | undefined {
    const root_id = this.pidToRoot.get(pid);
    if (root_id == null) return;
    return this.roots.get(root_id);
  }

  listRoots(): OwnedRootProcess[] {
    return Array.from(this.roots.values());
  }

  listActiveRoots(): OwnedRootProcess[] {
    return this.listRoots().filter((root) => root.exited_at == null);
  }

  clear() {
    this.roots.clear();
    this.pidToRoot.clear();
  }
}

let singleton: OwnedProcessRegistry | undefined;

export function getOwnedProcessRegistry(): OwnedProcessRegistry {
  singleton ??= new OwnedProcessRegistry();
  return singleton;
}

export function closeOwnedProcessRegistry() {
  singleton?.clear();
  singleton = undefined;
}
