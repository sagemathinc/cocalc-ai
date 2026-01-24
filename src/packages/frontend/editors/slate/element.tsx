/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { Editor } from "slate";
import { RenderElementProps, ReactEditor, useSlateStatic } from "./slate-react";
import { getRender } from "./elements";
import { gapCursorMatches } from "./gap-cursor";

const GapCursorMarker: React.FC<{ position: "before" | "after" }> = ({
  position,
}) => (
  <div
    contentEditable={false}
    data-slate-gap-cursor={position}
    style={{
      height: 0,
      borderTop: "2px solid rgba(24, 144, 255, 0.65)",
      margin: position === "before" ? "6px 0 0" : "0 0 6px",
      pointerEvents: "none",
    }}
  />
);

export const Element: React.FC<RenderElementProps> = (props) => {
  const editor = useSlateStatic() as ReactEditor;
  const Component = getRender(props.element["type"]);
  if (editor == null || Editor.isInline(editor, props.element)) {
    return React.createElement(Component, props);
  }
  let markerBefore: React.ReactNode = null;
  let markerAfter: React.ReactNode = null;
  try {
    const path = ReactEditor.findPath(editor, props.element);
    if (gapCursorMatches(editor as any, path, "before")) {
      markerBefore = <GapCursorMarker position="before" />;
    }
    if (gapCursorMatches(editor as any, path, "after")) {
      markerAfter = <GapCursorMarker position="after" />;
    }
  } catch {
    // ignore path resolution errors
  }
  return (
    <>
      {markerBefore}
      {React.createElement(Component, props)}
      {markerAfter}
    </>
  );
};
