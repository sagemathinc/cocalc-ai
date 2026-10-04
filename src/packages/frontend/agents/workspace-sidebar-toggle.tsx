/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon, Tooltip } from "@cocalc/frontend/components";
import { APP_ICON } from "@cocalc/frontend/art";
import { redux } from "@cocalc/frontend/app-framework";
import {
  NOTIFICATION_BADGE_MAX,
  useNotificationCount,
} from "@cocalc/frontend/app/notifications";
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
  if (!hidden) {
    return (
      <Tooltip title={label}>
        <Button
          type="text"
          aria-controls={AGENT_SIDEBAR_ID}
          aria-expanded
          aria-label={label}
          icon={<Icon name="chevron-left" />}
          onClick={onToggle}
          style={{ color }}
        />
      </Tooltip>
    );
  }
  return <CollapsedSidebarLogo onToggle={onToggle} color={color} />;
}

// With the sidebar (and its notifications envelope) hidden, the logo that
// brings it back carries the unread count, so it is never out of sight.
function CollapsedSidebarLogo({
  onToggle,
  color,
}: {
  onToggle: () => void;
  color?: string;
}) {
  const count = useNotificationCount();
  const shown =
    count > NOTIFICATION_BADGE_MAX ? `${NOTIFICATION_BADGE_MAX}+` : `${count}`;
  return (
    <span
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
    >
      <Tooltip title="Show sidebar (Ctrl/Cmd+Shift+P)">
        {/* Content as children, not `icon`: an icon-only button gets a fixed
            square width that clipped the mark and chevron. */}
        <Button
          type="text"
          aria-controls={AGENT_SIDEBAR_ID}
          aria-expanded={false}
          aria-label="Show sidebar"
          onClick={onToggle}
          style={{
            color,
            height: 32,
            padding: "0 4px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
          }}
        >
          <img
            src={APP_ICON}
            alt=""
            width={24}
            height={24}
            style={{ display: "block" }}
          />
          <Icon name="chevron-right" style={{ fontSize: 12 }} />
        </Button>
      </Tooltip>
      {count > 0 && (
        <button
          type="button"
          aria-label={`${count} unread notification${count === 1 ? "" : "s"}`}
          title="Notifications"
          onClick={(event) => {
            event.stopPropagation();
            redux.getActions("page").set_active_tab("notifications");
          }}
          style={{
            position: "absolute",
            top: -4,
            left: 16,
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: 8,
            border: "none",
            background: "#52c41a",
            color: "white",
            fontSize: 10,
            fontWeight: 600,
            lineHeight: "16px",
            cursor: "pointer",
          }}
        >
          {shown}
        </button>
      )}
    </span>
  );
}
