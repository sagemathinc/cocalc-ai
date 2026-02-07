/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useRef } from "react";
import { Editor, Element, Transforms } from "slate";
import { ReactEditor } from "../slate-react";
import { rangeAll } from "../slate-util";

export function setElement(
  editor: Editor,
  element: Element,
  obj: object
): Element | undefined {
  const setAtPath = (path: number[]): Element | undefined => {
    try {
      Transforms.setNodes(editor, obj, { at: path });
      return Editor.node(editor, path)[0] as Element;
    } catch {
      return undefined;
    }
  };

  // Fast path: use the ReactEditor map to locate this element directly.
  try {
    const path = ReactEditor.findPath(editor as ReactEditor, element);
    const updated = setAtPath(path as number[]);
    if (updated) return updated;
  } catch {
    // ignore; fall back to node searches below
  }

  // Usually when setElement is called, the element we are searching for is right
  // near the selection, so this first search finds it.
  try {
    for (const [, path] of Editor.nodes(editor, {
      match: (node) => node === element,
    })) {
      const updated = setAtPath(path);
      if (updated) return updated;
    }
  } catch {
    // ignore search failures
  }

  // Fallback: try the element that contains the current selection (common for inline elements).
  if (editor.selection) {
    try {
      const entry = Editor.above(editor, {
        at: editor.selection,
        match: (node) => Element.isElement(node) && node.type === element.type,
      });
      if (entry) {
        const [, path] = entry as [Element, number[]];
        const updated = setAtPath(path);
        if (updated) return updated;
      }
    } catch {
      // ignore fallback failures
    }
  }

  // Searching at the selection failed, so we try searching the entire document instead.
  // This has to work.
  try {
    for (const [, path] of Editor.nodes(editor, {
      match: (node) => node === element,
      at: rangeAll(editor),
    })) {
      const updated = setAtPath(path);
      if (updated) return updated;
    }
  } catch {
    // ignore search failures
  }

  // Last resort: match by type across the document.
  try {
    for (const [, path] of Editor.nodes(editor, {
      match: (node) => Element.isElement(node) && node.type === element.type,
      at: rangeAll(editor),
    })) {
      const updated = setAtPath(path);
      if (updated) return updated;
    }
  } catch {
    // ignore search failures
  }

  // This situation should never ever happen anymore (see big comment below):
  console.warn(
    "WARNING: setElement unable to find element in document",
    element,
    obj
  );
}

export function useSetElement(editor: Editor, element: Element): (obj) => void {
  // This is a trick to get around the fact that
  // the onChange callback below can't directly reference
  // the element, since it gets the version of element
  // from when that closure was created.
  const elementRef = useRef<Element>(element);
  elementRef.current = element;
  return (obj) => {
    const newElement = setElement(editor, elementRef.current, obj);
    if (newElement !== undefined) {
      // Here's why we do this: if we call the function returned by useSetElement twice in the same
      // render loop, then the above "elementRef.current = element;" doesn't have a chance
      // to happen (it happens at most once per render loop), and the second call to setElement
      // then fails.  Data loss ensues.  A way to cause this is when editing code in codemirror,
      // then hitting return and getting an indented line (e.g. "def f():    #" then hit return);
      // CodeMirror triggers two onChange events with the same content, and the second one causes
      // the warning about "setElement unable to find element in document".  I'm sure onChange could
      // fire in other NOT harmless ways in CodeMirror as well triggering this, and that I've seen
      // it, with the result being that something you just typed is undone.
      // That's why we imediately set the elementRef here:
      elementRef.current = newElement;
    }
  };
}
