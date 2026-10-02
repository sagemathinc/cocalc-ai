/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon, Tooltip } from "@cocalc/frontend/components";
import { APP_ICON } from "@cocalc/frontend/art";
import { Button } from "antd";

export const AGENT_SIDEBAR_ID = "agents-workspace-sidebar";

export function AgentsSidebarToggle({
  hidden,
  onToggle,
  color,
}: {
  hidden: boolean;
  onToggle: () => void;
  color?: string;
}) {
  const label = hidden ? "Show sidebar" : "Hide sidebar";
  return (
    <Tooltip title={hidden ? "Show sidebar (Ctrl/Cmd+Shift+P)" : label}>
      <Button
        type="text"
        aria-controls={AGENT_SIDEBAR_ID}
        aria-expanded={!hidden}
        aria-label={label}
        // Hidden, the CoCalc mark makes the way back to the sidebar easy to
        // recognize (a bare chevron is easy to miss).
        icon={
          hidden ? (
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              <img src={APP_ICON} alt="" width={18} height={18} />
              <Icon name="chevron-right" style={{ fontSize: 10 }} />
            </span>
          ) : (
            <Icon name="chevron-left" />
          )
        }
        onClick={onToggle}
        style={{ color, ...(hidden ? { marginTop: 3, paddingInline: 4 } : {}) }}
      />
    </Tooltip>
  );
}
