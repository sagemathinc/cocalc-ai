/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Shared STYLE constant for hashtag components
 * Used by task-editor/hashtag-bar.tsx
 */

import { UI_COLORS } from "@cocalc/util/appearance-palette";

export const STYLE: React.CSSProperties = {
  // this is used externally for a consistent hashtag look; change carefully!
  maxHeight: "18ex",
  overflowY: "auto",
  overflowX: "hidden",
  border: `1px solid ${UI_COLORS.border}`,
  padding: "5px",
  background: UI_COLORS.inset,
  color: UI_COLORS.text,
  borderRadius: "5px",
  marginBottom: "15px",
} as const;
