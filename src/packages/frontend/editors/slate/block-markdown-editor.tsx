/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { Path } from "@cocalc/frontend/frame-editors/frame-tree/path";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
import BlockMarkdownEditorCore from "./block-markdown-editor-core";
import LeafWithCursor from "./leaf-with-cursor";

export default function BlockMarkdownEditor(
  props: React.ComponentProps<typeof BlockMarkdownEditorCore>,
) {
  const { project_id, path, desc } = useFrameContext();
  const font_size =
    props.font_size ?? desc?.get("font_size") ?? DEFAULT_FONT_SIZE;

  const renderPath =
    props.hidePath === true ? null : (
      <Path is_current={props.is_current} path={path} project_id={project_id} />
    );

  return (
    <BlockMarkdownEditorCore
      {...props}
      font_size={font_size}
      renderPath={renderPath}
      leafComponent={LeafWithCursor}
    />
  );
}
