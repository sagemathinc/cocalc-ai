/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The one header row of a page showing a single thing (an agent thread, an
// artifact, a conversation): 40px, identity on the left, actions on the
// right, and a 3px strip in the thing's identity color so it is recognizable
// at a glance when switching between many of them.

import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export const PAGE_HEADER_HEIGHT = 40;

export function pageHeaderStyle({
  identityColor,
  background,
  color,
}: {
  identityColor?: string;
  background?: string;
  color?: string;
} = {}): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 8px",
    height: PAGE_HEADER_HEIGHT,
    boxSizing: "border-box",
    flexShrink: 0,
    minWidth: 0,
    borderBottom: `1px solid ${UI_COLORS.border}`,
    ...(identityColor
      ? { boxShadow: `inset 0 3px 0 ${identityColor}` }
      : undefined),
    ...(background ? { background } : undefined),
    ...(color ? { color } : undefined),
  };
}

type Props = HTMLAttributes<HTMLElement> & {
  identityColor?: string;
  background?: string;
  color?: string;
};

export const PageHeader = forwardRef<HTMLElement, Props>(function PageHeader(
  { identityColor, background, color, style, children, ...rest },
  ref,
) {
  return (
    <header
      ref={ref}
      {...rest}
      style={{
        ...pageHeaderStyle({ identityColor, background, color }),
        ...style,
      }}
    >
      {children}
    </header>
  );
});

// Muted context after a title (project, path, ...): it gives way first.
export const PAGE_HEADER_CONTEXT_STYLE: CSSProperties = {
  fontSize: 12,
  opacity: 0.75,
  minWidth: 0,
  flex: "1 1 0",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const PAGE_HEADER_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  margin: 0,
  minWidth: 0,
  flex: "0 1 auto",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
