/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EditableMarkdown as PlainMarkdownEditor } from "@cocalc/frontend/editors/slate/editable-markdown";
import type { EditorComponentProps } from "@cocalc/frontend/frame-editors/frame-tree/types";

export function EditableMarkdown(props: EditorComponentProps) {
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
