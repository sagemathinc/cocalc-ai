/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import BlockMarkdownEditor from "@cocalc/frontend/editors/slate/block-markdown-editor";
import { EditableMarkdown as PlainMarkdownEditor } from "@cocalc/frontend/editors/slate/editable-markdown";

const ENABLE_PAGED_BLOCK_MARKDOWN_EDITOR = false;

export const EditableMarkdown: typeof BlockMarkdownEditor =
  ENABLE_PAGED_BLOCK_MARKDOWN_EDITOR
    ? BlockMarkdownEditor
    : (PlainMarkdownEditor as typeof BlockMarkdownEditor);
