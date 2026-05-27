/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Task Editor Actions
*/

import {
  StructuredEditorActions as CodeEditorActions,
  CodeEditorState,
} from "../base-editor/actions-structured";
import { FrameTree } from "../frame-tree/types";
import { TaskActions } from "@cocalc/frontend/editors/task-editor/actions";
import { redux_name } from "@cocalc/frontend/app-framework";
import type { Store as BaseStore } from "@cocalc/frontend/app-framework";
import { aux_file, cmp } from "@cocalc/util/misc";
import { Map } from "immutable";
import { delay } from "awaiting";
import type { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import type { Tasks } from "@cocalc/frontend/editors/task-editor/types";
import { DONE } from "./search";
import {
  log_opened_time,
  mark_open_phase,
} from "@cocalc/frontend/project/open-file";
import { from_str } from "@cocalc/sync/editor/db/doc";

interface TaskEditorState extends CodeEditorState {
  tasks?: Tasks;
}

const FRAME_TYPE = "tasks";
const FAST_OPEN_TASKS_STATUS = "Loading live collaboration...";
export const MAX_FAST_OPEN_TASKS_BYTES = 1024 * 1024;

export type Store = BaseStore<TaskEditorState>;

export class Actions extends CodeEditorActions<TaskEditorState> {
  protected syncDocOptions = {
    ignoreInitialChanges: true,
  };
  taskActions: { [frameId: string]: TaskActions } = {};
  auxPath: string;
  private taskFastOpenToken = 0;
  private taskFastOpenApplied = false;
  private taskLiveReady = false;

  _init2(): void {
    this.auxPath = aux_file(this.path, "tasks");
    const syncdb = this._syncstring;
    syncdb.on("change", this.syncdbChange);
    this.startOptimisticTaskFastOpen(syncdb);
    syncdb.once("ready", () => {
      this.taskLiveReady = true;
      this.setTasks(tasksFromSyncdb(syncdb));
      this.ensurePositionsAreUnique();
      const hadFastOpen = this.taskFastOpenApplied;
      this.taskFastOpenApplied = false;
      if (!hadFastOpen) return;
      if (this.store?.get("status") === FAST_OPEN_TASKS_STATUS) {
        this.setState({ status: "" });
      }
      this.setState({ rtc_status: "live" });
      mark_open_phase(this.project_id, this.path, "handoff_done");
    });
  }

  private startOptimisticTaskFastOpen(syncdb: any): void {
    const fs = this._get_project_actions()?.fs?.();
    if (typeof fs?.readFile !== "function") return;
    const token = ++this.taskFastOpenToken;
    void (async () => {
      try {
        const raw = await fs.readFile(this.path, "utf8");
        if (this.isClosed() || token !== this.taskFastOpenToken) return;
        if (syncdb?.get_state?.() === "ready") return;
        const rawLength = getRawContentLength(raw);
        if (rawLength != null && rawLength > MAX_FAST_OPEN_TASKS_BYTES) {
          return;
        }
        const content =
          typeof raw === "string"
            ? raw
            : ((raw as any)?.toString?.("utf8") ?? `${raw ?? ""}`);
        if (content.length > MAX_FAST_OPEN_TASKS_BYTES) {
          return;
        }
        const tasks = parseTasksPreviewContent(content);
        if (this.isClosed() || token !== this.taskFastOpenToken) return;
        if (syncdb?.get_state?.() === "ready") return;
        this.setTasks(tasks);
        this.taskFastOpenApplied = true;
        this.setState({
          is_loaded: true,
          read_only: true,
          status: FAST_OPEN_TASKS_STATUS,
          rtc_status: "loading",
        });
        mark_open_phase(this.project_id, this.path, "optimistic_ready", {
          bytes: content.length,
          tasks: tasks.size,
        });
        log_opened_time(this.project_id, this.path);
      } catch {
        // Fall back to normal syncdb initialization.
      }
    })();
  }

  private setTasks(tasks: Tasks): void {
    this.store.setState({ tasks });
    for (const id in this.taskActions) {
      this.taskActions[id]._update_visible();
    }
  }

  private syncdbChange(changes) {
    const syncdb = this._syncstring;
    const store = this.store;
    if (syncdb == null || store == null) {
      // may happen during close
      return;
    }
    if (this.taskFastOpenApplied && !this.taskLiveReady) {
      // Ignore pre-ready incremental changes while the optimistic preview is
      // visible. On ready we atomically replace preview state from syncdb.
      return;
    }
    let tasks = store.get("tasks") ?? Map();
    changes.forEach((x) => {
      const task_id = x.get("task_id");
      const t = syncdb.get_one(x);
      if (t == null) {
        // deleted
        tasks = tasks.delete(task_id);
      } else {
        // changed
        tasks = tasks.set(task_id, t as any);
      }
    });

    this.setTasks(tasks);
  }

  private ensurePositionsAreUnique() {
    let tasks = this.store.get("tasks");
    if (tasks == null) {
      return;
    }
    // iterate through tasks adding their (string) positions to a
    // "set" (using a map)
    const s = {};
    let unique = true;
    tasks.forEach((task, id) => {
      if (tasks == null) return; // won't happpen, but TS doesn't know that.
      let pos = task.get("position");
      if (pos == null) {
        // no position set at all -- just arbitrarily set it to 0; it'll get
        // fixed below, if this conflicts.
        pos = 0;
        tasks = tasks.set(id, task.set("position", 0));
      }
      if (s[pos]) {
        // already got this position -- so they can't be unique
        unique = false;
        return false;
      }
      s[pos] = true;
    });
    if (unique) {
      // positions turned out to all be unique - done
      return;
    }
    // positions are NOT unique - this could happen, e.g., due to merging
    // offline changes.  We fix this by simply spreading them all out to be
    // 0 to n, arbitrarily breaking ties.
    const v: [number, string][] = [];
    tasks.forEach((task, id) => {
      v.push([task.get("position") ?? 0, id]);
    });
    v.sort((a, b) => cmp(a[0], b[0]));
    let position = 0;
    const actions = this.getTaskActions();
    if (actions == null) return;
    for (let x of v) {
      actions.set_task(x[1], { position });
      position += 1;
    }
  }

  getTaskActions(frameId?): TaskActions | undefined {
    if (frameId == null) {
      for (const actions of Object.values(this.taskActions)) {
        return actions;
      }
      return undefined;
    }
    if (this.taskActions[frameId] != null) {
      return this.taskActions[frameId];
    }
    const auxPath = this.auxPath + frameId;
    const reduxName = redux_name(this.project_id, auxPath);
    const actions = this.redux.createActions(reduxName, TaskActions);
    actions._init(
      this.project_id,
      this.auxPath,
      this._syncstring,
      this.store,
      this.path,
    );
    actions._init_frame(frameId, this);
    this.taskActions[frameId] = actions;
    actions.store = this.store;
    // this makes sure nothing is initially in edit mode, mainly because our keyboard handling SUCKS.
    actions.edit_desc(null);
    return actions;
  }

  undo() {
    this.getTaskActions()?.undo();
  }
  redo() {
    this.getTaskActions()?.redo();
  }

  help() {
    this.getTaskActions()?.help();
  }

  close_frame(frameId: string): void {
    super.close_frame(frameId); // actually closes the frame itself
    // now clean up if it is a task frame:

    if (this.taskActions[frameId] != null) {
      this.closeTaskFrame(frameId);
    }
  }

  closeTaskFrame(frameId: string): void {
    const actions = this.taskActions[frameId];
    if (actions == null) {
      return;
    }
    delete this.taskActions[frameId];
    const name = actions.name;
    this.redux.removeActions(name);
    actions.close();
  }

  close(): void {
    if (this._state == "closed") {
      return;
    }
    for (const frameId in this.taskActions) {
      this.closeTaskFrame(frameId);
    }
    this.redux.removeStore(this.store.name);
    super.close();
  }

  _raw_default_frame_tree(): FrameTree {
    return { type: FRAME_TYPE };
  }

  async export_to_markdown(): Promise<void> {
    try {
      await this.getTaskActions()?.export_to_markdown();
    } catch (error) {
      this.set_error(`${error}`);
    }
  }

  private hideAllTaskActionsExcept = (id) => {
    for (const id0 in this.taskActions) {
      if (id0 != id) {
        this.taskActions[id0].hide();
      }
    }
  };

  public focus(id?: string): void {
    if (id === undefined) {
      id = this._get_active_id();
    }
    this.hideAllTaskActionsExcept(id);
    //     if (this._get_frame_type(id) == FRAME_TYPE) {
    //       this.getTaskActions(id)?.show();
    //       return;
    //     }
    super.focus(id);
  }

  public blur(id?: string): void {
    if (id === undefined) {
      id = this._get_active_id();
    }
    if (this._get_frame_type(id) == FRAME_TYPE) {
      this.getTaskActions(id)?.hide();
    }
  }

  protected languageModelGetText(frameId: string, scope): string {
    if (this._get_frame_type(frameId) == FRAME_TYPE) {
      const node = this._get_frame_node(frameId);
      return (
        this.getTaskActions(frameId)?.codexGetText(
          scope,
          node?.get("data-current_task_id"),
        ) ?? ""
      );
    }
    return super.languageModelGetText(frameId, scope);
  }

  languageModelGetScopes() {
    return new Set<"cell">(["cell"]);
  }

  languageModelGetLanguage() {
    return "md";
  }

  async gotoFragment(fragmentId: FragmentId) {
    const { id } = fragmentId as any;
    if (!id) {
      return;
    }
    const frameId = await this.waitUntilFrameReady({
      type: FRAME_TYPE,
    });
    if (!frameId) {
      return;
    }
    for (const d of [1, 10, 50, 500, 1000]) {
      const actions = this.getTaskActions(frameId);
      actions?.set_current_task(id);
      actions?.scrollIntoView("start");
      await delay(d);
    }
  }

  getSearchIndexData = () => {
    const tasks = this.store?.get("tasks");
    if (tasks == null) {
      return {};
    }
    const data: { [id: string]: string } = {};
    for (const [id, task] of tasks) {
      if (task.get("deleted")) {
        continue;
      }
      let content = task.get("desc")?.trim();
      if (!content) {
        continue;
      }
      if (task.get("done")) {
        content = DONE + content;
      }
      data[id] = content;
    }
    return { data, fragmentKey: "id" };
  };
}

function getRawContentLength(raw: unknown): number | undefined {
  if (typeof raw === "string") return raw.length;
  if (raw != null && typeof (raw as any).byteLength === "number") {
    return (raw as any).byteLength;
  }
  if (raw != null && typeof (raw as any).length === "number") {
    return (raw as any).length;
  }
  return undefined;
}

export function parseTasksPreviewContent(content: string): Tasks {
  const doc = from_str(content, ["task_id"], ["desc"]);
  return tasksFromSyncdb(doc);
}

function tasksFromSyncdb(syncdb): Tasks {
  let tasks: Tasks = Map();
  syncdb.get().forEach((task) => {
    const task_id = task.get("task_id");
    if (task_id == null) return;
    tasks = tasks.set(task_id, task as any);
  });
  return tasks;
}
