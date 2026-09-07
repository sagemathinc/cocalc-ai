/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
StructuralCommand — single widget covering zero-arg structural and
spacing commands:

  \newpage   \clearpage  \pagebreak  \linebreak
  \bigskip   \medskip    \smallskip

The parser emits these all as `WidgetType` "structural-command" with
`payload.cmdName` set to the literal command (e.g. `"\\bigskip"`).
We branch on that here to pick the chip's appearance.

`\\` (line break) and `\noindent` are deliberately NOT widgeted —
see the parser's ZERO_ARG_COMMANDS comment for rationale.

Visual treatment
----------------
We don't try to render the actual semantic effect (e.g., a real page
break that pushes content down). The CM source is what drives the
layout; widgets are just inline hints. So each command becomes a
small badge — vertical-skip commands get a `⇕` glyph and a width,
break commands get a `↵` glyph, and `\noindent` is plain text.

The wrapper around the badge contributes a thin vertical border so
the chip reads as "metadata, not content".
*/

import { UI_COLORS } from "@cocalc/util/appearance-palette";

import { WidgetProps } from "../types";
import { Widget } from "./common";

interface ChipDef {
  /** Glyph rendered before the label (optional). */
  glyph?: string;
  /** Human-readable label. */
  label: string;
  /** Override color (defaults to grey). */
  accent?: string;
}

const CHIP_DEFS: Record<string, ChipDef> = {
  "\\newpage": { glyph: "↵", label: "new page", accent: UI_COLORS.link },
  "\\clearpage": {
    glyph: "↵",
    label: "clear page",
    accent: UI_COLORS.link,
  },
  "\\pagebreak": { glyph: "↵", label: "page break" },
  "\\linebreak": { glyph: "↵", label: "line break" },
  "\\bigskip": { glyph: "⇕", label: "big skip" },
  "\\medskip": { glyph: "⇕", label: "med skip" },
  "\\smallskip": { glyph: "⇕", label: "small skip" },
};

const CHIP_STYLE = {
  display: "inline-block",
  padding: "0 6px",
  borderRadius: 3,
  background: UI_COLORS.inset,
  color: UI_COLORS.text,
  fontSize: "0.78em",
  fontFamily: "sans-serif",
  fontWeight: 500,
  border: `1px solid ${UI_COLORS.border}`,
  letterSpacing: "0.02em",
  verticalAlign: "baseline",
} as const;

export function StructuralCommand(props: WidgetProps) {
  const cmdName =
    (props.descriptor.payload?.cmdName as string | undefined) ?? "";
  const def = CHIP_DEFS[cmdName];
  // Fail-open: any unknown cmdName (shouldn't happen — parser only
  // emits structural-command for entries we registered) renders as
  // the raw source so the user can still see / edit it.
  if (def == null) {
    return (
      <Widget {...props}>
        <span style={{ ...CHIP_STYLE, color: UI_COLORS.secondary }}>
          {cmdName}
        </span>
      </Widget>
    );
  }
  const accent = def.accent;
  return (
    <Widget {...props}>
      <span
        style={accent != null ? { ...CHIP_STYLE, color: accent } : CHIP_STYLE}
      >
        {def.glyph != null && (
          <span style={{ marginRight: def.label !== "" ? 4 : 0 }}>
            {def.glyph}
          </span>
        )}
        {def.label}
      </span>
    </Widget>
  );
}
