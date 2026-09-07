/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Document-level widgets: \title \author \date \maketitle \tableofcontents

We don't try to wire \maketitle to the actual \title/\author/\date
values — that would need cross-line document state. Each widget
renders independently:
  \title{X}    → big bold inline preview
  \author{X}   → italic
  \date{X}     → small-gray
  \maketitle   → neutral chip "Title block"
  \tableofcontents → neutral chip "Table of contents"
*/

import { UI_COLORS } from "@cocalc/util/appearance-palette";

import { WidgetProps } from "../types";
import { EmptyPlaceholder, Widget } from "./common";

function contentOf(props: WidgetProps): string {
  return (props.descriptor.payload?.content as string | undefined) ?? "";
}

const NEUTRAL_CHIP_STYLE = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  background: UI_COLORS.inset,
  color: UI_COLORS.text,
  fontFamily: "sans-serif",
  fontSize: "0.85em",
  fontWeight: 500,
  border: `1px dashed ${UI_COLORS.border}`,
  letterSpacing: "0.02em",
} as const;

export function Title(props: WidgetProps) {
  const text = contentOf(props);
  return (
    <Widget {...props}>
      {text === "" ? (
        <EmptyPlaceholder label="empty title" />
      ) : (
        <span
          style={{
            fontSize: "1.6em",
            fontWeight: 700,
            color: UI_COLORS.text,
          }}
        >
          {text}
        </span>
      )}
    </Widget>
  );
}

export function Author(props: WidgetProps) {
  const text = contentOf(props);
  return (
    <Widget {...props}>
      {text === "" ? (
        <EmptyPlaceholder label="empty author" />
      ) : (
        <span
          style={{
            fontStyle: "italic",
            color: UI_COLORS.text,
          }}
        >
          {text}
        </span>
      )}
    </Widget>
  );
}

export function DateWidget(props: WidgetProps) {
  const text = contentOf(props);
  return (
    <Widget {...props}>
      {text === "" ? (
        <EmptyPlaceholder label="empty date" />
      ) : (
        <span style={{ color: UI_COLORS.secondary, fontSize: "0.95em" }}>
          {text}
        </span>
      )}
    </Widget>
  );
}

export function Maketitle(props: WidgetProps) {
  return (
    <Widget {...props}>
      <span style={NEUTRAL_CHIP_STYLE}>Title block</span>
    </Widget>
  );
}

export function Tableofcontents(props: WidgetProps) {
  return (
    <Widget {...props}>
      <span style={NEUTRAL_CHIP_STYLE}>Table of contents</span>
    </Widget>
  );
}
