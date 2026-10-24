/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
HTML Editor Actions
*/

import $ from "jquery";
import { TextEditorActions as CodeEditorActions } from "../base-editor/actions-text";
import { print_html } from "../frame-tree/print";
import { FrameTree } from "../frame-tree/types";
import { raw_url } from "../frame-tree/util";
import { contentViewURL } from "@cocalc/frontend/lib/cocalc-urls";

export class Actions extends CodeEditorActions {
  // The preview shows this file on the project's content origin, so printing
  // goes through /content-view (same origin as the app; see print()).
  private contentOriginReady = false;

  setContentOriginReady(ready: boolean): void {
    this.contentOriginReady = ready;
  }

  _init2(): void {
    this._init_syncstring_value();
    this._init_spellcheck();
    this._init_iframe_reload();
  }

  _init_iframe_reload(): void {
    this._syncstring.on("save-to-disk", () => {
      this.set_reload("iframe");
    });
  }

  _raw_default_frame_tree(): FrameTree {
    return {
      direction: "col",
      type: "node",
      first: {
        type: "cm",
      },
      second: {
        type: "iframe",
      },
    };
  }

  // https://github.com/sagemathinc/cocalc/issues/3984
  reload(id: string) {
    const node = this._get_frame_node(id);
    if (!node) return;

    if (node.get("type") !== "iframe") {
      super.reload(id);
      return;
    }

    this.set_reload("iframe", new Date().getTime());
  }

  print(id: string): void {
    const node = this._get_frame_node(id);
    if (!node) return;

    if (node.get("type") === "cm") {
      super.print(id);
      return;
    }

    try {
      switch (node.get("type")) {
        case "iframe":
          if (this.contentOriginReady) {
            // The raw URL ends on the host's domain, where the popup's
            // print never runs; the content view prints itself.
            print_html({
              src: contentViewURL({
                project_id: this.project_id,
                path: this.path,
                print: true,
              }),
              selfPrinting: true,
            });
          } else {
            print_html({ src: raw_url(this.project_id, this.path) });
          }
          break;
        case "preview":
          print_html({
            html: $(`#frame-${id}`).html(),
            project_id: this.project_id,
            path: this.path,
          });
          break;
        default:
          throw Error("Printing not implemented");
      }
    } catch (err) {
      this.set_error(err);
    }
  }
}
