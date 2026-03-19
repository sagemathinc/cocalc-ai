/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { COLORS } from "@cocalc/util/theme";
import {
  SLATE_CODE_BLOCK_PALETTES,
  type SlateCodeBlockPalette,
} from "./theme-palettes.generated";

export type SlateCodeBlockThemeVars = CSSProperties & {
  [key: `--${string}`]: string;
};

// Keep markdown theming constrained to inline/block code unless we
// explicitly opt back into broader surface theming.
const SLATE_RENDER_THEME_CODE_ONLY = true;

function parseColor(
  color: string,
): { r: number; g: number; b: number } | undefined {
  const normalized = color.trim().toLowerCase();
  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);
    if (hex.length === 3) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length >= 6) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
    return;
  }
  const rgb = normalized.match(/rgba?\(([^)]+)\)/);
  if (!rgb) return;
  const parts = rgb[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));
  if (parts.some((value) => !Number.isFinite(value))) return;
  return { r: parts[0], g: parts[1], b: parts[2] };
}

function mix(colorA: string, colorB: string, amount: number): string {
  const a = parseColor(colorA);
  const b = parseColor(colorB);
  if (!a || !b) return colorA;
  const blend = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return `rgb(${blend(a.r, b.r)}, ${blend(a.g, b.g)}, ${blend(a.b, b.b)})`;
}

export function slateCodeBlockPalette(
  editorTheme?: string | null,
): SlateCodeBlockPalette {
  const theme = `${editorTheme ?? ""}`.trim();
  return (
    (theme ? SLATE_CODE_BLOCK_PALETTES[theme] : undefined) ??
    SLATE_CODE_BLOCK_PALETTES.default
  );
}

export function slateCodeBlockThemeVars(
  editorTheme?: string | null,
): SlateCodeBlockThemeVars {
  const theme = `${editorTheme ?? ""}`.trim();
  const palette = slateCodeBlockPalette(editorTheme);
  const borderMix = palette.mode === "dark" ? 0.24 : 0.12;
  const inlineCodeMix = palette.mode === "dark" ? 0.2 : 0.07;
  const codeVars: SlateCodeBlockThemeVars = {
    "--cocalc-slate-link": COLORS.ANTD_LINK_BLUE,
    "--cocalc-slate-inline-code-bg": mix(
      palette.background,
      palette.foreground,
      inlineCodeMix,
    ),
    "--cocalc-slate-inline-code-fg": palette.foreground,
    "--cocalc-slate-inline-code-border": mix(
      palette.background,
      palette.foreground,
      borderMix,
    ),
    "--cocalc-slate-code-bg": palette.background,
    "--cocalc-slate-code-fg": palette.foreground,
    "--cocalc-slate-code-border": palette.border,
    "--cocalc-slate-code-comment": palette.comment,
    "--cocalc-slate-code-keyword": palette.keyword,
    "--cocalc-slate-code-string": palette.string,
    "--cocalc-slate-code-number": palette.number,
    "--cocalc-slate-code-definition": palette.definition,
  };

  if (SLATE_RENDER_THEME_CODE_ONLY) {
    return codeVars;
  }

  const surfaceMix = palette.mode === "dark" ? 0.14 : 0.05;
  const subtleMix = palette.mode === "dark" ? 0.1 : 0.025;
  const neutralLinkChipMix = palette.mode === "dark" ? 0.09 : 0.035;
  const neutralLinkChipBorderMix = palette.mode === "dark" ? 0.2 : 0.12;
  const linkColor =
    theme === "" || theme === "default"
      ? COLORS.ANTD_LINK_BLUE
      : palette.keyword || palette.definition;
  return {
    ...codeVars,
    "--cocalc-slate-link": linkColor,
    "--cocalc-slate-link-chip-bg": mix(
      palette.background,
      palette.foreground,
      neutralLinkChipMix,
    ),
    "--cocalc-slate-link-chip-border": mix(
      palette.background,
      palette.foreground,
      neutralLinkChipBorderMix,
    ),
    "--cocalc-slate-inline-code-bg": mix(
      palette.background,
      palette.foreground,
      inlineCodeMix,
    ),
    "--cocalc-slate-inline-code-fg": palette.foreground,
    "--cocalc-slate-inline-code-border": mix(
      palette.background,
      palette.foreground,
      borderMix,
    ),
    "--cocalc-slate-blockquote-bg": mix(
      palette.background,
      palette.comment,
      subtleMix,
    ),
    "--cocalc-slate-blockquote-fg": palette.foreground,
    "--cocalc-slate-blockquote-border": mix(
      palette.background,
      linkColor,
      borderMix,
    ),
    "--cocalc-slate-table-border": mix(
      palette.background,
      palette.foreground,
      borderMix,
    ),
    "--cocalc-slate-table-header-bg": mix(
      palette.background,
      palette.foreground,
      surfaceMix,
    ),
    "--cocalc-slate-table-header-fg": palette.foreground,
  };
}
