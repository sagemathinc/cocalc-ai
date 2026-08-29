/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { createEditor, Editor, Operation, Point } from "slate";
import { cloneDeep, isEqual } from "lodash";
import type { SlateEditor } from "./editable-markdown";
import { getScrollState, setScrollState } from "./scroll";

export function applyOperations(
  editor: SlateEditor,
  operations: Operation[],
): boolean {
  if (operations.length == 0) return true;

  // window.operations = operations;

  // const t0 = Date.now();

  // This cursor gets mutated during the for loop below!
  const cursor: { focus: Point | null } = {
    focus: editor.selection?.focus ?? null,
  };

  let applicableOperations: Operation[];
  try {
    applicableOperations = operations.filter((op) => !skipCursor(cursor, op));
  } catch (err) {
    warnUnableToApply(err, operations);
    return false;
  }

  // Heterogeneous merge_node operations are the observed source of invalid
  // partial batches. Validate those batches transactionally, but keep common
  // text-only synchronization on the fast path without cloning the document.
  if (applicableOperations.some(({ type }) => type === "merge_node")) {
    const probe = createEditor();
    probe.children = cloneDeep(editor.children);
    probe.selection = cloneDeep(editor.selection);
    try {
      Editor.withoutNormalizing(probe, () => {
        for (const op of applicableOperations) {
          probe.apply(op);
        }
      });
    } catch (err) {
      warnUnableToApply(err, applicableOperations);
      return false;
    }
  }

  try {
    editor.applyingOperations = true; // TODO: not sure if this is at all necessary...
    try {
      Editor.withoutNormalizing(editor, () => {
        for (const op of applicableOperations) {
          editor.apply(op);
        }
      });
    } catch (err) {
      warnUnableToApply(err, applicableOperations);
      return false;
    }

    /* console.log(
      `time: apply ${operations.length} operations`,
      Date.now() - t0,
      "ms"
    );*/
  } finally {
    editor.applyingOperations = false;
  }
  return true;
}

function warnUnableToApply(err: unknown, operations: Operation[]): void {
  console.warn(
    "WARNING: Slate issue -- unable to apply operations; falling back to a direct value reset",
    { err, operations },
  );
}

/*
There is a special case that is unavoidable without making the
plain text file really ugly.     If you type "foo " in slate (with the space),
this converts to "foo " in Markdown (*with* the space).  But
markdown-it converts this back to [...{text:"foo"}]
without the space at the end of the line!  Without modifying
how we apply diffs, the only solution to this problem would
be to emit "foo&#32;" which technically works, but is REALLY ugly.
So if we do not do the following operation in some cases
when the path is to the focused cursor.

  {type: "remove_text", text:"[whitespace]", path, offset}

NOTE: not doing this transform doesn't mess up paths of
subsequent ops since all this did was change some whitespace
in a single text node, hence doesn't mutate any paths.

Similarly we do not delete empty paragraphs if the cursor
is in it.  This comes up when moving the cursor next to voids,
where we have to make an empty paragraph to make it possible to
type something there (e.g., between two code blocks).
*/
function skipCursor(cursor: { focus: Point | null }, op): boolean {
  const { focus } = cursor;
  if (focus == null) return false;
  if (
    op.type == "remove_text" &&
    isEqual(focus.path, op.path) &&
    op.text.trim() == "" &&
    op.text.length + op.offset == focus.offset
  ) {
    return true;
  }
  if (
    op.type == "remove_node" &&
    isEqual(op.node, { type: "paragraph", children: [{ text: "" }] }) &&
    isEqual(op.path, focus.path.slice(0, op.path.length))
  ) {
    return true;
  }

  cursor.focus = Point.transform(focus, op);
  return false;
}

// This only has an impact with windowing enabled, which is the only situation where
// scrolling should be happening anyways.
export function preserveScrollPosition(
  editor: SlateEditor,
  operations: Operation[],
): void {
  const scroll = getScrollState(editor);
  if (scroll == null) return;
  const { index, offset } = scroll;

  let point: Point | null = { path: [index], offset: 0 };
  // transform point via the operations.
  for (const op of operations) {
    point = Point.transform(point, op);
    if (point == null) break;
  }

  const newStartIndex = point?.path[0];
  if (newStartIndex == null) return;

  setScrollState(editor, { index: newStartIndex, offset });
}
