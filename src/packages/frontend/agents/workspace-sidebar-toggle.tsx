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
      {hidden ? (
        // Content as children, not `icon`: an icon-only button gets a fixed
        // square width that clipped the mark and chevron.
        <Button
          type="text"
          aria-controls={AGENT_SIDEBAR_ID}
          aria-expanded={false}
          aria-label={label}
          onClick={onToggle}
          style={{
            color,
            height: 36,
            padding: "0 6px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
            flex: "0 0 auto",
          }}
        >
          <img
            src={APP_ICON}
            alt=""
            width={26}
            height={26}
            style={{ display: "block" }}
          />
          <Icon name="chevron-right" style={{ fontSize: 14 }} />
        </Button>
      ) : (
        <Button
          type="text"
          aria-controls={AGENT_SIDEBAR_ID}
          aria-expanded
          aria-label={label}
          icon={<Icon name="chevron-left" />}
          onClick={onToggle}
          style={{ color }}
        />
      )}
    </Tooltip>
  );
}
