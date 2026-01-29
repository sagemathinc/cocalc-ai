/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/* Automatic formatting

The idea is you type some markdown in a text cell, then space, and
if the markdown processor does something nontrivial given that text,
then the text gets replaced by the result.

The actual implementation of this is **much deeper** than what is done
in the "shortcuts" slatejs demo here

    https://www.slatejs.org/examples/markdown-shortcuts

in two ways:

1. This automatically supports everything the markdown-to-slate
implementation supports.  Instead of having to reimplement bits
and pieces of markdown that we think of, we automatically get
absolutely everything the processor supports with 100% correct
results.  If at any point we ever add a new plugin to markdown-it,
or change options, they just automatically work.

2. We use our slate-diff implementation to make the transformation
rather than coding it up for different special cases.  This slate-diff
is itself  deep, being based on diff-match-patch, and using numerous
heuristics.
*/

import { Editor, Element, Path, Point, Range, Transforms } from "slate";
import { ReactEditor } from "../slate-react";
import { markdownAutoformat } from "./auto-format";
import { ensureRange } from "../slate-util";

export const withInsertText = (editor) => {
  const { insertText: insertText0 } = editor;

  const insertText = (text) => {
    try {
      if (editor.marks) {
        // This case is to work around a strange bug that I don't know how to fix.
        // If you type in a blank document:
        //   command+b then "foo"
        // you will see "oof" in bold.  This happens in many other situations, where
        // initially when you insert a character in a blank paragraph with a mark, the
        // cursor doesn't move.  I don't know why.  We thus check after inserting
        // text that the focus moves, and if not, we move it.
        const { selection } = editor;
        insertText0(text);
        if (
          editor.selection != null &&
          editor.selection.focus.offset == selection?.focus.offset
        ) {
          Transforms.move(editor, { distance: 1 });
        }
      } else {
        insertText0(text);
      }
    } catch (err) {
      // I once saw trying to insert text when some state is invalid causing
      // a crash in production to me.  It's better for the text to not get
      // inserted and get a console warning, than for everything to crash
      // in your face, hence this.
      console.warn(`WARNING -- problem inserting text "${text}" -- ${err}`);
    }
  };

  editor.insertText = (text, autoFormat?) => {
    if (!text) return;
    if (
      editor.selection == null &&
      (editor as any).__autoformatSelection != null
    ) {
      const selection = (editor as any).__autoformatSelection;
      (editor as any).__autoformatSelection = null;
      try {
        Transforms.setSelection(editor, selection);
        if (!ReactEditor.isFocused(editor)) {
          ReactEditor.focus(editor);
        }
        if ((editor as any).__autoformatIgnoreSelection) {
          (editor as any).setIgnoreSelection?.(false);
          (editor as any).__autoformatIgnoreSelection = false;
        }
      } catch {
        // ignore invalid selection, we'll fall back to default behavior
      }
    }
    if (!autoFormat) {
      insertText(text);
      return;
    }
    const { selection } = editor;
    const selectionBlockPath =
      selection && selection.focus ? Path.parent(selection.focus.path) : null;

    if (selection && Range.isCollapsed(selection)) {
      if (text === " ") {
        const isSingleParagraph =
          editor.children.length === 1 &&
          Element.isElement(editor.children[0]) &&
          editor.children[0].type === "paragraph";
        const canIgnore =
          typeof (editor as any).setIgnoreSelection === "function";
        if (canIgnore) {
          (editor as any).setIgnoreSelection(true);
          (editor as any).__autoformatIgnoreSelection = true;
        }
        if (!markdownAutoformat(editor)) {
          if (canIgnore) {
            (editor as any).setIgnoreSelection(false);
            (editor as any).__autoformatIgnoreSelection = false;
          }
          insertText(text);
        } else {
          if ((editor as any).__autoformatDidBlock) {
            if (canIgnore) {
              (editor as any).setIgnoreSelection(false);
              (editor as any).__autoformatIgnoreSelection = false;
            }
            return;
          }
          // Autoformat in a *fully empty* editor is surprisingly tricky:
          // Slate often reuses the same value reference, so React skips a render,
          // and the DOM selection/focus never updates. We must:
          //   1) force a render (bumpChange),
          //   2) compute a safe selection after the transform,
          //   3) apply DOM selection + focus on the next frame.
          // This avoids the “caret disappears / focus lost” bug.
          const bump =
            (editor as any).__bumpChangeOnAutoformat ?? editor.bumpChange;
          if (typeof bump === "function") bump();
          let pendingSelection =
            (editor as any).__autoformatSelection ?? editor.selection;
          if (pendingSelection) {
            try {
              const safe = ensureRange(editor, pendingSelection);
              let isDocStart = false;
              try {
                const docStart = Editor.start(editor, []);
                isDocStart =
                  Range.isCollapsed(safe) &&
                  Point.equals(safe.anchor, docStart) &&
                  Point.equals(safe.focus, docStart);
              } catch {
                // ignore doc start check failures
              }
              let hasContent = false;
              try {
                hasContent = Editor.string(editor, []).length > 0;
              } catch {
                // ignore content check failures
              }
              if (isDocStart && selectionBlockPath && !hasContent) {
                pendingSelection = null;
              } else {
                pendingSelection = safe;
              }
            } catch {
              pendingSelection = null;
            }
          }
          if (!pendingSelection && selectionBlockPath) {
            try {
              const end = Editor.end(editor, selectionBlockPath);
              pendingSelection = { anchor: end, focus: end };
            } catch {
              // ignore fallback selection failure
            }
          }
          if (!pendingSelection && isSingleParagraph) {
            try {
              const end = Editor.end(editor, [0]);
              pendingSelection = { anchor: end, focus: end };
            } catch {
              // ignore fallback selection failure
            }
          }
          (editor as any).__autoformatSelection = pendingSelection ?? null;
          if (pendingSelection) {
            const safeSelection = ensureRange(editor, pendingSelection);
            pendingSelection = safeSelection;
            editor.selection = safeSelection;
            try {
              editor.onChange();
            } catch {
              // ignore onChange errors; we'll still attempt focus below
            }
          }
          const applyDomSelection = (selection) => {
            if (!selection) return;
            try {
              const domRange = ReactEditor.toDOMRange(editor, selection);
              const domSelection = window.getSelection();
              if (domSelection) {
                domSelection.removeAllRanges();
                domSelection.addRange(domRange);
              }
            } catch {
              // ignore DOM selection failures
            }
          };
          // Use rAF to apply selection/focus after Slate/React commit.
          window.requestAnimationFrame(() => {
            const selection = pendingSelection ?? editor.selection;
            if (selection) {
              try {
                Transforms.setSelection(editor, selection);
              } catch {
                // ignore selection failures
              }
              applyDomSelection(selection);
            }
            try {
              if (!ReactEditor.isFocused(editor)) {
                ReactEditor.focus(editor);
              }
            } catch {
              // ignore focus failures
            }
            (editor as any).__autoformatSelection = null;
            if (
              (editor as any).__autoformatIgnoreSelection &&
              (editor as any).__autoformatSelection == null
            ) {
              (editor as any).setIgnoreSelection?.(false);
              (editor as any).__autoformatIgnoreSelection = false;
            }
          });
        }
        return;
      }
    }

    insertText(text);
  };

  return editor;
};
