/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import BlockMarkdownEditor from "@cocalc/frontend/editors/slate/block-markdown-editor";
import { EditableMarkdown as PlainMarkdownEditor } from "@cocalc/frontend/editors/slate/editable-markdown";
import type { EditorComponentProps } from "@cocalc/frontend/frame-editors/frame-tree/types";

const ENABLE_PAGED_BLOCK_MARKDOWN_EDITOR = false;

function PlainMarkdownFrameEditor(props: EditorComponentProps) {
  return (
    <PlainMarkdownEditor
      {...(props as any)}
      height="100%"
      pageStyle={{
        ...((props as any).pageStyle ?? {}),
        padding: "70px",
      }}
      showEditBar
    />
  );
}

export const EditableMarkdown: typeof BlockMarkdownEditor =
  ENABLE_PAGED_BLOCK_MARKDOWN_EDITOR
    ? BlockMarkdownEditor
    : (PlainMarkdownFrameEditor as typeof BlockMarkdownEditor);
