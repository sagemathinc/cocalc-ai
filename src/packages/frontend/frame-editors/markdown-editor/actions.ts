/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Markdown Editor Actions
*/

import { delay } from "awaiting";
import { fromJS } from "immutable";
import $ from "jquery";
import { debounce } from "lodash";
import {
  TableOfContentsEntry,
  TableOfContentsEntryList,
} from "@cocalc/frontend/components";
import { scrollToHeading } from "@cocalc/frontend/editors/slate/control";
import { SlateEditor } from "@cocalc/frontend/editors/slate/editable-markdown";
import { formatAction as slateFormatAction } from "@cocalc/frontend/editors/slate/format";
import {
  findSlatePointNearMarkdownPosition,
  markdownPositionToSlatePoint,
  nearestMarkdownPositionForSlatePoint,
  scrollIntoView as scrollSlateIntoView,
} from "@cocalc/frontend/editors/slate/sync";
import { ReactEditor } from "@cocalc/frontend/editors/slate/slate-react";
import { Transforms } from "slate";
import type * as CodeMirror from "codemirror";
import { toggle_checkbox } from "@cocalc/frontend/editors/task-editor/desc-rendering";
import { parseTableOfContents } from "@cocalc/frontend/markdown";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import { ExecuteCodeOutputAsync } from "@cocalc/util/types/execute-code";
import {
  Actions as CodeEditorActions,
  CodeEditorState,
} from "../base-editor/actions-text";
import { print_html } from "../frame-tree/print";
import { FrameTree } from "../frame-tree/types";

interface MarkdownEditorState extends CodeEditorState {
  custom_pdf_error_message: string; // currently used only in rmd editor, but we could easily add pdf output to the markdown editor
  building: boolean; // for Rmd
  build_log: string; // for Rmd
  build_err: string; // for Rmd
  build_exit: number; // for Rmd
  job_info?: ExecuteCodeOutputAsync; // for Rmd streaming with stats
  contents?: TableOfContentsEntryList; // table of contents data.
  show_slate_help?: boolean;
}

export class Actions extends CodeEditorActions<MarkdownEditorState> {
  private slateEditors: { [id: string]: SlateEditor } = {};

  _init2(): void {
    this._init_syncstring_value();
    this._init_spellcheck();

    this.store.on("close-frame", ({ id, type }) => {
      if (type == "slate" && this.slateEditors[id]) {
        delete this.slateEditors[id];
      }
    });

    this._syncstring.on(
      "change",
      debounce(this.updateTableOfContents.bind(this), 1500),
    );
  }

  _raw_default_frame_tree(): FrameTree {
    return { type: "slate" };
  }

  toggle_markdown_checkbox(id: string, index: number, checked: boolean): void {
    // Ensure that an editor state is saved into the
    // (TODO: make more generic, since other editors will exist that are not just codemirror...)
    this.set_syncstring_to_codemirror(id);
    // Then do the checkbox toggle.
    const value = toggle_checkbox(this._syncstring.to_str(), index, checked);
    this._syncstring.from_str(value);
    this.set_codemirror_to_syncstring();
    this._syncstring.save();
    this.setState({ value });
  }

  print(id: string): void {
    const node = this._get_frame_node(id);
    if (!node) return;
    if (node.get("type") === "cm") {
      super.print(id);
      return;
    }

    try {
      print_html({
        html: $(`#frame-${id}`).html(),
        project_id: this.project_id,
        path: this.path,
      });
    } catch (err) {
      this.set_error(err);
    }
  }

  // Never delete trailing whitespace for markdown files.
  delete_trailing_whitespace(): void {}

  // per-session sync-aware undo; aware of more than one editor type
  undo(id: string): void {
    if (this._get_frame_type(id) != "slate") {
      super.undo(id);
      return;
    }
    const value = this._syncstring.undo().to_str();
    this._syncstring.set(value);
    this._syncstring.commit();
    // Important: also set codemirror editor state, if there is one (otherwise it will be out of sync!)
    this._get_cm()?.setValueNoJump(value, true);
  }

  // per-session sync-aware redo ; aware of more than one editor type
  redo(id: string): void {
    if (this._get_frame_type(id) != "slate") {
      super.redo(id);
      return;
    }
    if (!this._syncstring.in_undo_mode()) {
      return;
    }
    const doc = this._syncstring.redo();
    if (doc == null) {
      // can't redo if version not defined/not available.
      return;
    }
    const value = doc.to_str();
    this._syncstring.set(value);
    this._syncstring.commit();
    // Important: also set codemirror editor state, as for undo above.
    this._get_cm()?.setValueNoJump(value, true);
  }

  async format_action(cmd, args, force_main: boolean = false): Promise<void> {
    const id = this._get_active_id();
    if (this._get_frame_type(id) != "slate" || this.slateEditors[id] == null) {
      super.format_action(cmd, args, force_main);
      return;
    }
    slateFormatAction(this.slateEditors[id], cmd, args);
  }

  public getSlateEditor(id?: string): SlateEditor | undefined {
    if (id == null) {
      // mainly for interactive use and debugging.
      for (const id0 in this.slateEditors) {
        return this.slateEditors[id0];
      }
      throw Error("no slate editors");
    }
    return this.slateEditors?.[id];
  }

  public registerSlateEditor(id: string, editor: SlateEditor): void {
    this.slateEditors[id] = editor;
  }

  public focus(id?: string): void {
    const targetId = id ?? this._get_active_id();
    if (targetId == null) {
      super.focus(id);
      return;
    }
    if (this._get_frame_type(targetId) !== "slate") {
      super.focus(targetId);
      return;
    }
    const editor = this.getSlateEditor(targetId);
    if (editor != null) {
      ReactEditor.focus(editor);
      return;
    }
    super.focus(targetId);
  }

  private getSlateMarkdown(id: string): string | undefined {
    const editor = this.getSlateEditor(id);
    if (typeof editor?.getMarkdownValue === "function") {
      return editor.getMarkdownValue();
    }
    return undefined;
  }

  set_syncstring_to_codemirror(
    id?: string,
    do_not_exit_undo_mode?: boolean,
  ): void {
    const activeId = id ?? this._get_active_id?.();
    if (activeId != null && this._get_frame_type(activeId) == "slate") {
      const markdown = this.getSlateMarkdown(activeId);
      if (markdown != null) {
        this.set_value(markdown, do_not_exit_undo_mode, "slate");
        return;
      }
    }
    super.set_syncstring_to_codemirror(id, do_not_exit_undo_mode);
  }

  public async show_table_of_contents(
    _id: string | undefined = undefined,
  ): Promise<void> {
    const id = this.show_focused_frame_of_type(
      "markdown_table_of_contents",
      "col",
      true,
      1 / 3,
    );
    // the click to select TOC focuses the active id back on the notebook
    await delay(0);
    if (this._state === "closed") return;
    this.set_active_id(id, true);
  }

  updateTableOfContents = (force: boolean = false): void => {
    if (
      this._state == "closed" ||
      this._syncstring == null ||
      this._syncstring.get_state?.() != "ready"
    ) {
      // no need since not initialized yet or already closed.
      return;
    }
    if (
      !force &&
      !this.get_matching_frame({ type: "markdown_table_of_contents" })
    ) {
      // There is no table of contents frame so don't update that info.
      return;
    }
    let value: string;
    try {
      value = this._syncstring.to_str();
    } catch {
      // sync doc can race during startup/refresh.
      return;
    }
    const contents = fromJS(parseTableOfContents(value)) as any;
    this.setState({ contents });
  };

  public async scrollToHeading(entry: TableOfContentsEntry): Promise<void> {
    const id = this.show_focused_frame_of_type("slate");
    if (id == null) return;
    let editor = this.getSlateEditor(id);
    if (editor == null) {
      // if slate frame just created, have to wait until after it gets
      // rendered for the actual editor to get registered.
      await delay(1);
      editor = this.getSlateEditor(id);
    }
    if (editor == null) {
      return;
    }
    const n = parseInt(entry.id);
    scrollToHeading(editor, n);
    // this is definitely necessary in case the editor wasn't opened, and doesn't
    // hurt if it is.
    await delay(1);
    scrollToHeading(editor, n);
  }

  // for rendered markdown, switch frame type so that this rendered view
  // is instead editable.
  public edit(id: string): void {
    this.set_frame_type(id, "slate");
  }

  public readonly_view(id: string): void {
    this.set_frame_type(id, "markdown");
  }

  private async sync_cm_to_slate(
    id: string,
    editor_actions: Actions,
    liveCm?: CodeMirror.Editor,
  ): Promise<void> {
    const registeredCm = editor_actions._cm[id];
    const cm = liveCm ?? registeredCm;
    if (cm == null) return;
    // important to get markdown from cm and not syncstring to get latest version.
    const markdown = cm.getValue();
    this.set_value(markdown, true, "cm");
    const slate_id = this.show_focused_frame_of_type("slate");
    if (slate_id == null) return;
    const pos = cm.getDoc().getCursor();
    const editor = await this.waitForSlateEditor(slate_id);
    if (editor == null) return;
    if (editor.getMarkdownValue?.() !== markdown) {
      this._syncstring.emit("change", { local: true, source: "cm" });
      await delay(0);
    }
    let point =
      markdownPositionToSlatePoint({
        markdown,
        pos,
        editor,
      }) ??
      findSlatePointNearMarkdownPosition({
        markdown,
        pos,
        editor,
      });
    if (point == null) return;
    try {
      Transforms.setSelection(editor, { anchor: point, focus: point });
      ReactEditor.focus(editor);
      scrollSlateIntoView(editor, point);
      this.set_active_id(slate_id, true);
    } catch (err) {
      console.log("point not found", point);
    }
  }

  private async waitForSlateEditor(
    id: string,
  ): Promise<SlateEditor | undefined> {
    for (const wait of [0, 16, 32, 64, 128, 250, 500]) {
      if (wait) {
        await delay(wait);
      }
      const editor = this.getSlateEditor(id);
      if (editor != null) {
        return editor;
      }
    }
    return undefined;
  }

  private sync_slate_to_cm(id: string) {
    const markdown = this.getSlateMarkdown(id);
    if (markdown != null) {
      this.set_value(markdown, true, "slate");
    }
    const editor = this.getSlateEditor(id);
    if (editor == null) return;
    const point = editor.selection?.focus;
    if (point == null) {
      return;
    }
    const pos = nearestMarkdownPositionForSlatePoint(editor, point);
    if (pos == null) return;
    this.programmatically_goto_line(
      pos.line + 1, // 1 based (TODO: could use codemirror option)
      true,
      true,
      undefined,
      pos.ch,
    );
  }

  altEnter(_value: string, id?: string): void {
    const activeId = id ?? this._get_active_id();
    if (!activeId) return;
    void this.sync(activeId, this);
  }

  public async sync(
    id: string,
    editor_actions: Actions,
    liveCm?: CodeMirror.Editor,
  ): Promise<void> {
    const node = this._get_frame_node(id);
    if (!node) return;
    switch (node.get("type")) {
      case "slate":
        this.sync_slate_to_cm(id);
        return;
      case "cm":
        this.sync_cm_to_slate(id, editor_actions, liveCm);
        return;
    }
  }

  help(): void {
    openProjectDocs({ projectId: this.project_id, slug: "files/markdown" });
  }

  slate_help(): void {
    this.setState({ show_slate_help: true });
  }

  languageModelGetText(
    frameId: string,
    scope: "selection" | "cell" | "all" = "all",
  ): string {
    const node = this._get_frame_node(frameId);
    if (node?.get("type") == "cm") {
      return super.languageModelGetText(frameId, scope);
    } else if (node?.get("type") == "slate") {
      if (scope == "selection") {
        const ed = this.getSlateEditor(frameId);
        if (!ed) {
          return this._syncstring.to_str();
        }
        const fragment = ed.getFragment() ?? [];
        if (ed.selectionIsCollapsed()) {
          // if collapsed it could still be a void element, in which case we grab it.
          for (const x of fragment) {
            if (x?.["isVoid"]) {
              return ed.getSourceValue(fragment);
            }
          }
          // normal text -- return nothing, so can get all via next call
          return "";
        }
        return ed.getSourceValue(fragment) ?? "";
      } else {
        return this._syncstring.to_str();
      }
    } else {
      // shouldn't happen but it's an ok fallback.
      return this._syncstring.to_str();
    }
  }
}
