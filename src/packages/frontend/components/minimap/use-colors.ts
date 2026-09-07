import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import { darkAppearance as p } from "@cocalc/util/appearance-palette";
import { MINIMAP_COLORS, MINIMAP_SYNTAX, MINIMAP_CELL_THEME } from "./colors";

const darkSyntax = {
  text: p.text,
  keyword: p.keyword,
  number: p.number,
  string: p.string,
  comment: p.comment,
};
const darkColors = {
  ...MINIMAP_COLORS,
  railBackground: p.inset,
  railBorder: p.border,
  viewportBorder: p.link,
  viewportFill: "rgba(156,197,255,0.15)",
  stylizedViewportBorder: p.secondary,
  stylizedViewportFill: "rgba(255,255,255,0.08)",
  canvasBackground: p.inset,
  canvasCurrentRow: p.selected,
  canvasCurrentRowStroke: p.link,
  canvasCurrentLine: p.selected,
  current: p.link,
  block: p.muted,
  blockQuiet: p.controlBorder,
};
const darkCells = Object.fromEntries(
  Object.keys(MINIMAP_CELL_THEME).map((kind) => [
    kind,
    {
      cellBackground:
        kind === "markdown"
          ? p.successBg
          : kind === "raw"
            ? p.infoBg
            : p.surface,
      textColor: p.text,
      keywordColor: p.keyword,
      numberColor: p.number,
      stringColor: p.string,
      commentColor: p.comment,
    },
  ]),
) as typeof MINIMAP_CELL_THEME;
const light = {
  colors: MINIMAP_COLORS,
  syntax: MINIMAP_SYNTAX,
  cells: MINIMAP_CELL_THEME,
};
const dark = { colors: darkColors, syntax: darkSyntax, cells: darkCells };

// Canvas needs resolved colors, not CSS variables; consumers redraw on changes.
export function useMinimapColors() {
  return useAppearance().resolved === "dark" ? dark : light;
}
