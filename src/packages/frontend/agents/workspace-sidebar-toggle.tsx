/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon, Tooltip } from "@cocalc/frontend/components";
import { APP_ICON } from "@cocalc/frontend/art";
import { Button } from "antd";

export const AGENT_SIDEBAR_ID = "agents-workspace-sidebar";
export { AGENT_SIDEBAR_HIDDEN_STORAGE_KEY } from "./sidebar-storage";

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
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
            >
              <img src={APP_ICON} alt="" width={26} height={26} />
              <Icon name="chevron-right" style={{ fontSize: 14 }} />
            </span>
          ) : (
            <Icon name="chevron-left" />
          )
        }
        onClick={onToggle}
        style={{
          color,
          // Sized like the top bar's icons, centered in its 36px row.
          ...(hidden
            ? {
                height: 36,
                paddingInline: 6,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }
            : {}),
        }}
      />
    </Tooltip>
  );
}
