/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";

interface AuthInstructionsProps {
  children?: string | null;
}

export default function AuthInstructions({ children }: AuthInstructionsProps) {
  const message = `${children ?? ""}`.trim();
  if (!message) {
    return null;
  }
  return (
    <div
      role="note"
      style={{
        background: COLORS.BLUE_LLLL,
        border: `1px solid ${COLORS.BLUE_LLL}`,
        borderRadius: "8px",
        color: COLORS.GRAY_DD,
        fontSize: "14px",
        lineHeight: "20px",
        padding: "10px 12px",
      }}
    >
      {message}
    </div>
  );
}
