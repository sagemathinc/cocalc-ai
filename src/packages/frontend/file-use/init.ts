/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "../app-framework";
import { FileUseActions } from "./actions";

export function init() {
  const actions = redux.createActions("file_use", FileUseActions);
  actions._init();
}
