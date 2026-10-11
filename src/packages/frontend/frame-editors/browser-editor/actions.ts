/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  BaseEditorActions,
  type CodeEditorState,
} from "@cocalc/frontend/frame-editors/base-editor/actions-base";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import type { FrameTree } from "@cocalc/frontend/frame-editors/frame-tree/types";

export class Actions extends BaseEditorActions<CodeEditorState> {
  // The file only names the browser; its state is the browser's profile.
  protected doctype = "none";

  _raw_default_frame_tree(): FrameTree {
    return { type: "browser" };
  }

  _init2(): void {}

  reload(_id: string): void {
    this.set_reload("browser", Date.now());
  }

  help(): void {
    openProjectDocs({
      projectId: this.project_id,
      slug: "projects/web-browser",
    });
  }
}
