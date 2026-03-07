/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map, Set } from "immutable";
import { TypedMap } from "@cocalc/frontend/app-framework";
import type {
  HashtagState,
  TaskRecord,
  TaskSortColumn,
  TaskSortDirection,
} from "@cocalc/app-tasks";

export type Task = TaskRecord;

export type Align = "start" | "center" | "end" | "view" | false;

export type Headings = TaskSortColumn;
export type HeadingsDir = TaskSortDirection;
export type { HashtagState };

export type TaskMap = TypedMap<Task>;
export type Sort = TypedMap<{ column: Headings; dir: HeadingsDir }>;

// 1=selected, -1=negated  (-1 is NOT implemented in the UI; it seems annoying; use -#foo in the search box though)
export type SelectedHashtags = Map<string, HashtagState>;

export interface LocalViewState {
  show_deleted?: boolean;
  show_done?: boolean;
  show_max?: number;
  sort?: Sort;
  selected_hashtags?: SelectedHashtags;
  search?: string;
  scroll?: number;
}

export type LocalViewStateMap = TypedMap<LocalViewState>;
export type LocalTaskStateMap = Map<string, any>;
export type Counts = TypedMap<{ done: number; deleted: number }>;

// Tasks is an immutable map from task_id (uuidv4) to {desc:?, position:?, last_edited:?, due_date:?, task_id:?}
export type Tasks = Map<string, TaskMap>;

// Hashtags.has('foo') if there is a *visible* (with current search/filters) task with hashtag #foo
export type HashtagsOfVisibleTasks = Set<string>;

// State of the Store
export interface TaskState {
  tasks?: Tasks;
}
