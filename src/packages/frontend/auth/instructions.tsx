/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { UI_COLORS } from "@cocalc/util/appearance-palette";

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
        background: UI_COLORS.infoBg,
        border: `1px solid ${UI_COLORS.info}`,
        borderRadius: "8px",
        color: UI_COLORS.text,
        fontSize: "14px",
        lineHeight: "20px",
        padding: "10px 12px",
      }}
    >
      {message}
    </div>
  );
}
