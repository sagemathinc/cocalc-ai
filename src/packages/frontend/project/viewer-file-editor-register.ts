/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register_file_editor } from "@cocalc/frontend/project-file";
import ViewerFileEditor from "./viewer-file-editor";
import { VIEWER_FILE_EDITOR_EXTENSION } from "./viewer-file-editor-consts";

register_file_editor({
  ext: VIEWER_FILE_EDITOR_EXTENSION,
  icon: "eye",
  component: ViewerFileEditor,
});
