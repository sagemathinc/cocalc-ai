/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Keyboard event handler
*/

import json from "json-stable-stringify";

import { JupyterEditorActions } from "@cocalc/frontend/frame-editors/jupyter-editor/actions";
import { NotebookFrameActions } from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/actions";
import { shouldSuppressGlobalShortcuts } from "@cocalc/frontend/keyboard/boundary";
import {
  handoffProjectNavigationFromLocalOwner,
  matchProjectNavigationCommand,
} from "@cocalc/frontend/project/page/keyboard-navigation";
import { copy_without, merge } from "@cocalc/util/misc";
import { JupyterActions } from "./browser-actions";
import { commands, KeyboardCommand } from "./commands";
import { NotebookMode } from "@cocalc/jupyter/types";

export function keyCode_to_chr(keyCode: number): string {
  const chrCode = keyCode - 48 * Math.floor(keyCode / 48);
  return String.fromCharCode(96 <= keyCode ? chrCode : keyCode);
}

function is_equal(e1: KeyboardCommand, e2: KeyboardCommand): boolean {
  for (const field of ["which", "ctrl", "shift", "alt", "meta"]) {
    if (e1[field] !== e2[field]) {
      return false;
    }
  }
  return true;
}

let last_evt: any = undefined;

export function evt_to_obj(evt: any, mode: NotebookMode): KeyboardCommand {
  let which = evt.which;
  if (which === 173) {
    // Firefox reports "-" as 173 instead of the conventional 189.
    which = 189;
  } else if (which === 59) {
    // Firefox reports ";" as 59 instead of the conventional 186.
    which = 186;
  }
  const obj: any = { which };
  for (const k of ["ctrl", "shift", "alt", "meta"]) {
    if (evt[k + "Key"]) {
      obj[k] = true;
    }
  }
  if (last_evt != null && is_equal(last_evt, obj)) {
    obj.twice = true;
    last_evt = undefined;
  } else {
    last_evt = obj;
  }
  if (mode != null) {
    obj.mode = mode;
  }
  return obj;
}

function evt_to_shortcut(evt: any, mode: NotebookMode): string {
  return json(evt_to_obj(evt, mode))!;
}

export function create_key_handler(
  jupyter_actions: JupyterActions,
  frame_actions: NotebookFrameActions,
  editor_actions: JupyterEditorActions,
): (e: any) => void {
  if (
    jupyter_actions == null ||
    frame_actions == null ||
    editor_actions == null
  ) {
    // just in case typescript misses something...
    throw Error("bug in create_key_handler");
  }
  let val: any;
  const shortcut_to_command: any = {};

  function add_shortcut(s: any, name: any, val: any) {
    if (s.mode == null) {
      for (const mode of ["escape", "edit"]) {
        add_shortcut(merge(s, { mode }), name, val);
      }
      return;
    }
    if (s.key != null) {
      // TODO: remove this when we switch from using event.which to event.key!
      s = copy_without(s, ["key"]);
    }
    shortcut_to_command[json(s)!] = { name, val };
    if (s.alt) {
      s = copy_without(s, "alt");
      s.meta = true;
      return add_shortcut(s, name, val);
    }
  }

  const object = commands({
    jupyter_actions,
    frame_actions,
    editor_actions,
  });

  for (const name in object) {
    val = object[name];
    if ((val != null ? val.k : undefined) == null) {
      continue;
    }
    for (const s of val.k) {
      add_shortcut(s, name, val);
    }
  }

  return (evt: any) => {
    if (jupyter_actions.store == null || frame_actions.store == null) {
      // Could happen after everything has been closed, but key handler isn't
      // quite removed.  https://github.com/sagemathinc/cocalc/issues/4462
      return;
    }
    const navigationCommand = matchProjectNavigationCommand(evt);
    if (navigationCommand != null) {
      evt.preventDefault?.();
      evt.stopPropagation?.();
      handoffProjectNavigationFromLocalOwner(
        navigationCommand,
        editor_actions.project_id,
        {
          blurActiveElement: document.activeElement,
          currentFrameId: frame_actions.frame_id,
          editorActions: editor_actions as any,
          projectActions: editor_actions._get_project_actions() as any,
        },
      );
      return false;
    }
    if (jupyter_actions.store.get("complete") != null) {
      return;
    }
    const mode = frame_actions.store.get("mode");
    if (mode === "escape") {
      if (shouldSuppressGlobalShortcuts(evt)) {
        // Never use keyboard shortcuts when a real editable surface or explicit
        // keyboard boundary owns focus. Plain notebook DIV focus remains allowed
        // so command mode continues to work normally.
        return;
      }
    }
    const shortcut = evt_to_shortcut(evt, mode);
    const cmd = shortcut_to_command[shortcut];

    if (cmd != null) {
      last_evt = undefined;
      cmd.val.f();
      return false;
    }
  };
}
