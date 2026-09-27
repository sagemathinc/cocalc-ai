/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

// Controls and launch receipts remain siblings, outside this body disclosure.
export function ActivityMessageBody({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!compact) return <>{children}</>;
  return (
    <>
      <div
        style={{
          width: "100%",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          color: UI_COLORS.secondary,
        }}
      >
        <span>Message shown in activity</span>
        <Button
          size="small"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide full message" : "Show full message"}
        </Button>
      </div>
      {expanded ? children : null}
    </>
  );
}
