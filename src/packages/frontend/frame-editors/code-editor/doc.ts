/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Manage codemirror documents.  For each path, there's one of these.
*/

import * as CodeMirror from "codemirror";

const cache: any = {};

function key(project_id: string, path: string): string {
  return `${project_id}-${path}`;
}

export function get_linked_doc(
  project_id: string,
  path: string,
): CodeMirror.Doc {
  const doc = cache[key(project_id, path)];
  if (doc != undefined) {
    return doc.linkedDoc();
  } else {
    throw Error(`no such doc -- ${project_id}/${path}`);
  }
}

export function has_doc(project_id: string, path: string): boolean {
  return cache[key(project_id, path)] !== undefined;
}

export function set_doc(
  project_id: string,
  path: string,
  cm: CodeMirror.Editor,
): void {
  cache[key(project_id, path)] = cm.getDoc();
}

export function get_doc(project_id: string, path: string): CodeMirror.Doc {
  const doc = cache[key(project_id, path)];
  if (doc != undefined) {
    return doc;
  } else {
    throw Error(`no such doc -- ${project_id}/${path}`);
  }
}

// Forget about given doc
export function close(project_id: string, path: string): void {
  delete cache[key(project_id, path)];
}

// Connect a newly created cm editor to the document for (project_id, path).
//
// - Function-valued value marks a static external view (e.g., TimeTravel):
//   it owns its content and must not join the shared live document.
// - Otherwise all frames of the same file share one underlying document via
//   linked docs, so local and remote edits appear in every frame.  A
//   string-valued value only seeds initial content for the first frame
//   (e.g., optimistic fast open before the syncstring is ready); the
//   syncstring remains authoritative.
export function connect_editor_doc(
  cm: CodeMirror.Editor,
  project_id: string,
  path: string,
  value?: string | (() => string),
): void {
  if (typeof value === "function") {
    cm.setValue(value() ?? "");
    return;
  }
  if (has_doc(project_id, path)) {
    cm.swapDoc(get_linked_doc(project_id, path));
    return;
  }
  if (value != null) {
    cm.setValue(value);
  }
  set_doc(project_id, path, cm);
}
