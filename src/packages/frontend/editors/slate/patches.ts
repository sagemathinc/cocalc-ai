/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Node, Path, Point, Range } from "slate";
import { ensurePoint, ensureRange, pointAtPath } from "./slate-util";

// The version of isNodeList in slate is **insanely** slow, and this hack
// is likely to be sufficient for our use.
// This makes a MASSIVE different for larger documents!
Node.isNodeList = (value: any): value is Node[] => {
  return Array.isArray(value) && (value?.length == 0 || Node.isNode(value[0]));
};

// I have seen cocalc.com crash in production randomly when editing markdown
// when calling range.  I think this happens when computing decorators, so
// it is way better to make it non-fatal for now.
export const withNonfatalRange = (editor) => {
  const { range } = editor;

  editor.range = (at, to?) => {
    try {
      const safeAt = normalizeLocation(editor, at);
      if (safeAt == null) {
        const selection =
          editor.selection == null ? null : ensureRange(editor, editor.selection);
        if (selection) {
          return selection;
        }
        const anchor = pointAtPath(editor, []);
        return { anchor, focus: anchor };
      }
      if (Range.isRange(safeAt)) {
        return safeAt;
      }
      const safeTo = to == null ? safeAt : normalizeLocation(editor, to);
      return range.call(editor, safeAt, safeTo);
    } catch (err) {
      console.log(`WARNING: range error ${err}`);
      const anchor = pointAtPath(editor, []);
      return { anchor, focus: anchor };
    }
  };

  return editor;
};

// Normalize selection updates so they always point at a leaf node.
// This prevents Slate from crashing when a selection lands on a non-leaf
// element (e.g., code_line), which can happen after DOM → Slate mapping.
export const withSelectionSafety = (editor) => {
  const { apply } = editor;

  editor.apply = (op) => {
    if (op.type === "set_selection" && op.newProperties != null) {
      try {
        const next = op.newProperties as Range | null;
        if (next == null) {
          op = { ...op, newProperties: null };
        } else {
          const base = editor.selection ?? ensureRange(editor, null);
          const merged = { ...base, ...next } as Range;
          const safe = ensureRange(editor, merged);
          if (!Range.equals(merged, safe)) {
            op = { ...op, newProperties: safe };
          }
        }
      } catch {
        // fall back to original op
      }
    }
    const out = apply(op);
    // Selection can become stale after non-selection operations that change the
    // tree (e.g., remote merges, normalization). Keep it leaf-safe at all times.
    try {
      if (editor.selection != null) {
        const safe = ensureRange(editor, editor.selection);
        if (!Range.equals(editor.selection, safe)) {
          editor.selection = safe;
        }
      }
    } catch {
      const anchor = pointAtPath(editor, []);
      editor.selection = { anchor, focus: anchor };
      editor.marks = null;
    }
    return out;
  };

  return editor;
};

function normalizeLocation(editor: Editor, location) {
  if (location == null) return location;
  const unwrapped = unwrapLocationRef(location);
  if (unwrapped !== location) {
    return normalizeLocation(editor, unwrapped);
  }
  if (Range.isRange(location)) {
    return ensureRange(editor, location);
  }
  if (Point.isPoint(location)) {
    return ensurePoint(editor, location);
  }
  if (Path.isPath(location)) {
    return pointAtPath(editor, location);
  }
  return location;
}

function unwrapLocationRef(location: any) {
  if (location == null) return location;
  if (typeof location !== "object") return location;
  if (!("current" in location)) return location;
  return location.current ?? location;
}

// We patch the Editor.string command so that if the input
// location is invalid, it returns "" instead of crashing.
// This is useful, since Editor.string is mainly used
// for heuristic selection adjustment, copy, etc.
// In theory it should never get invalid input, but due to
// the loose nature of Slate, it's difficult to ensure this.
const unpatchedEditorString = Editor.string;
Editor.string = function (...args): string {
  try {
    return unpatchedEditorString(...args);
  } catch (err) {
    console.warn("WARNING: slate Editor.string -- invalid range", err);
    return "";
  }
};
