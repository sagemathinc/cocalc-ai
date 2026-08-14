/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import CopyButton from "@cocalc/frontend/components/copy-button";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { COLORS } from "@cocalc/util/theme";

export function CodexFinalResponseCopy({ value }: { value: string }) {
  return (
    <Tooltip title="Copy final response">
      <CopyButton
        markdown
        value={value}
        size="small"
        noText
        ariaLabel="Copy final response"
        style={{ color: COLORS.GRAY_M, margin: -4 }}
      />
    </Tooltip>
  );
}
