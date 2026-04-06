/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "../app-framework";

import { FileUseStore } from "./store";
import { FileUseActions } from "./actions";

export function init() {
  redux.createStore("file_use", FileUseStore, { notify_count: 0 });
  const actions = redux.createActions("file_use", FileUseActions);
  actions._init(); // must be after making store
}
