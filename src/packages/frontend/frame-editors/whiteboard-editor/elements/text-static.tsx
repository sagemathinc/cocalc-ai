import { CSSProperties } from "react";
import { Element } from "../types";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import { DEFAULT_FONT_SIZE, DEFAULT_FONT_FAMILY } from "../tools/defaults";
import { lightAppearance } from "@cocalc/util/appearance-palette";

// Whiteboard text is authored on paper or colored notes, not app surfaces.
const PAPER_APPEARANCE = Object.fromEntries(
  Object.entries(lightAppearance).map(([name, value]) => [
    `--cocalc-ui-${name}`,
    value,
  ]),
);

interface Props {
  element: Element;
}

export const PADDING: number = 5;
export const PLACEHOLDER = "Type text...";

export default function Text({ element }: Props) {
  const isEmpty = !element.str?.trim();
  return (
    <StaticMarkdown
      value={
        isEmpty
          ? (element.data?.placeholder ?? PLACEHOLDER)
          : (element.str ?? "")
      }
      style={getFullStyle(element, isEmpty)}
    />
  );
}

export function getStyle(
  element,
  defaults?: {
    color?: string;
    fontSize?: number;
    fontFamily?: string;
    background?: string;
  },
) {
  let fontFamily =
    element.data?.fontFamily ?? defaults?.fontFamily ?? DEFAULT_FONT_FAMILY;
  if (fontFamily == "Sans") {
    // for historical reasons, mainly -- see packages/frontend/editors/editor-button-bar.ts too
    fontFamily = "sans-serif";
  }
  const color = element.data?.color ?? defaults?.color ?? lightAppearance.text;
  return {
    ...PAPER_APPEARANCE,
    "--cocalc-ui-text": color,
    colorScheme: "light" as const,
    color,
    fontSize: element.data?.fontSize ?? defaults?.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily,
    background: element.data?.background ?? defaults?.background,
  };
}

export function getFullStyle(
  element: Element,
  isEmpty: boolean,
): CSSProperties {
  return {
    opacity: isEmpty ? 0.5 : undefined, // similar to what antd input does: https://stackoverflow.com/questions/56095371/how-can-i-change-the-placeholder-color-in-ant-designs-select-component; they use 0.4 which is really too light.
    ...getStyle(element),
    // border-box so PADDING sits inside the element's width rather than
    // widening it: as content-box this div rendered 2*PADDING wider than the
    // element, pushing text past the right edge in the rendered view while
    // the editor inset it -- a 2*PADDING jump between the two modes.
    boxSizing: "border-box",
    padding: `${PADDING}px`,
    height: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  };
}
