/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Regression test for duplicated frames of the same file not syncing:
all live cm frames of one file must share the same underlying document
via linked docs, so edits in any frame appear in all frames.  See
connect_editor_doc in ../doc.ts.
*/

import * as CodeMirror from "codemirror";

import { close, connect_editor_doc, has_doc } from "../doc";

const PROJECT_ID = "6efc57fc-bc4d-4dcd-b0b3-eba299dd6c7c";
const PATH = "a.md";

// Minimal stand-in for a CodeMirror.Editor: connect_editor_doc only uses
// getDoc/swapDoc/setValue, all of which just delegate to the current Doc.
function fakeEditor(initial: string = ""): CodeMirror.Editor {
  let doc = new (CodeMirror as any).Doc(initial);
  return {
    getDoc: () => doc,
    swapDoc: (next: CodeMirror.Doc) => {
      const old = doc;
      doc = next;
      return old;
    },
    setValue: (value: string) => doc.setValue(value),
    getValue: () => doc.getValue(),
  } as unknown as CodeMirror.Editor;
}

afterEach(() => {
  close(PROJECT_ID, PATH);
});

describe("connect_editor_doc", () => {
  it("shares one underlying document between two frames of the same file", () => {
    const cm1 = fakeEditor();
    const cm2 = fakeEditor();
    connect_editor_doc(cm1, PROJECT_ID, PATH, "hello");
    connect_editor_doc(cm2, PROJECT_ID, PATH, "hello");

    // second frame picked up content via the linked doc
    expect(cm2.getValue()).toBe("hello");

    // local edit in frame 1 appears in frame 2
    cm1.getDoc().replaceRange(" world", { line: 0, ch: 5 });
    expect(cm2.getValue()).toBe("hello world");

    // and edits in frame 2 appear in frame 1
    cm2.getDoc().replaceRange("!", { line: 0, ch: 11 });
    expect(cm1.getValue()).toBe("hello world!");
  });

  it("propagates a remote-style whole-buffer update applied to one frame", () => {
    const cm1 = fakeEditor();
    const cm2 = fakeEditor();
    connect_editor_doc(cm1, PROJECT_ID, PATH);
    connect_editor_doc(cm2, PROJECT_ID, PATH);

    // simulate applying a remote merge to the "recent" cm only
    cm1.setValue("remote content");
    expect(cm2.getValue()).toBe("remote content");
  });

  it("seeds initial content only for the first frame", () => {
    const cm1 = fakeEditor();
    connect_editor_doc(cm1, PROJECT_ID, PATH, "seed");
    expect(cm1.getValue()).toBe("seed");

    cm1.setValue("live");
    const cm2 = fakeEditor();
    // a stale store value must not clobber the shared live doc
    connect_editor_doc(cm2, PROJECT_ID, PATH, "seed");
    expect(cm2.getValue()).toBe("live");
    expect(cm1.getValue()).toBe("live");
  });

  it("keeps static views (function-valued value) isolated", () => {
    const live = fakeEditor();
    connect_editor_doc(live, PROJECT_ID, PATH, "live");

    const staticView = fakeEditor();
    connect_editor_doc(staticView, PROJECT_ID, PATH, () => "static snapshot");
    expect(staticView.getValue()).toBe("static snapshot");

    // static view did not join (or alter) the shared document
    live.getDoc().replaceRange("!", { line: 0, ch: 4 });
    expect(staticView.getValue()).toBe("static snapshot");
    expect(live.getValue()).toBe("live!");
  });

  it("does not register static views in the doc cache", () => {
    const staticView = fakeEditor();
    connect_editor_doc(staticView, PROJECT_ID, PATH, () => "static");
    expect(has_doc(PROJECT_ID, PATH)).toBe(false);
  });
});
