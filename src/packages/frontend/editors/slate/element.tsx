/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { Editor } from "slate";
import { RenderElementProps, useSlateStatic } from "./slate-react";
import { getRender } from "./elements";

export const Element: React.FC<RenderElementProps> = (props) => {
  const editor = useSlateStatic();
  const Component = getRender(props.element["type"]);
  if (editor == null || Editor.isInline(editor, props.element)) {
    return React.createElement(Component, props);
  }
  return React.createElement(Component, props);
};
