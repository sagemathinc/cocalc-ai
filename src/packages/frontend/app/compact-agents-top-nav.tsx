/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MenuProps } from "antd";
import { Button, Dropdown } from "antd";

import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import {
  useActions,
  useEffect,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { AIUsageWarning } from "@cocalc/frontend/purchases/ai-usage-warning";
import { AccountCpuWarning } from "@cocalc/frontend/purchases/account-cpu-warning";
import { AccountStorageWarning } from "@cocalc/frontend/purchases/account-storage-warning";
import { ManagedEgressWarning } from "@cocalc/frontend/purchases/managed-egress-warning";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

import { ConnectionIndicator } from "./connection-indicator";
import { Notification } from "./notifications";
import openSupportTab from "@cocalc/frontend/support/open";
import type { PageStyle } from "./top-nav-consts";

export function CompactAgentsTopNav({
  isLoggedIn,
  pageStyle,
  onOpenInProject,
  foregroundColor,
  workspaceItems = [],
  onOpenDocs,
}: {
  isLoggedIn: boolean;
  pageStyle: PageStyle;
  onOpenInProject?: () => void;
  foregroundColor?: string;
  workspaceItems?: MenuProps["items"];
  onOpenDocs?: () => void;
}) {
  const pageActions = useActions("page");
  const groups = useTypedRedux("account", "groups");
  const fullscreen = useTypedRedux("page", "fullscreen");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      requestAnimationFrame(() =>
        menuTriggerRef.current?.querySelector("button")?.focus(),
      );
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [menuOpen]);

  const items: MenuProps["items"] = [
    ...workspaceItems,
    ...(onOpenInProject
      ? [
          {
            key: "open-in-project",
            icon: <Icon name="external-link" />,
            label: "Open in project",
          },
          { type: "divider" as const },
        ]
      : []),
    { key: "projects", icon: <Icon name="edit" />, label: "Projects" },
    { key: "hosts", icon: <Icon name="server" />, label: "Compute" },
    {
      key: "notifications",
      icon: <Icon name="mail" />,
      label: "Notifications",
    },
    { type: "divider" },
    {
      key: "agents-settings",
      icon: <Icon name="users" />,
      label: "Manage agents and connections",
    },
    ...(groups?.includes("admin")
      ? [{ key: "admin", icon: <Icon name="users" />, label: "Admin" }]
      : []),
    { type: "divider" },
    { key: "docs", icon: <Icon name="book" />, label: "Documentation" },
    { key: "support", icon: <Icon name="support" />, label: "Contact us" },
    { key: "connection", icon: <Icon name="wifi" />, label: "Connection" },
    {
      key: "fullscreen",
      icon: <Icon name={fullscreen ? "compress" : "expand"} />,
      label: fullscreen ? "Exit fullscreen" : "Fullscreen",
    },
  ];

  function onMenuClick({ key }: { key: string }) {
    setMenuOpen(false);
    switch (key) {
      case "docs":
        if (onOpenDocs) onOpenDocs();
        else pageActions.set_active_tab("docs");
        return;
      case "open-in-project":
        onOpenInProject?.();
        return;
      case "agents-settings":
        openAccountSettings({ page: "my-agents" });
        return;
      case "support":
        openSupportTab();
        return;
      case "connection":
        pageActions.show_connection(true);
        return;
      case "fullscreen":
        pageActions.toggle_fullscreen();
        return;
      default:
        if (key.startsWith("workspace-")) return;
        pageActions.set_active_tab(key);
    }
  }

  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flex: "0 0 auto",
        height: pageStyle.height,
      }}
    >
      <AIUsageWarning pageStyle={pageStyle} />
      <AccountCpuWarning pageStyle={pageStyle} />
      <AccountStorageWarning pageStyle={pageStyle} />
      <ManagedEgressWarning pageStyle={pageStyle} />
      {isLoggedIn ? (
        <Notification
          active={false}
          hideWhenEmpty
          pageStyle={pageStyle}
          type="notifications"
        />
      ) : null}
      <ConnectionIndicator
        height={pageStyle.height}
        hideWhenConnected
        pageStyle={pageStyle}
      />
      <Dropdown
        menu={{ items, onClick: onMenuClick }}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        placement="bottomRight"
        trigger={["click"]}
      >
        <span ref={menuTriggerRef}>
          <Button
            aria-label="More navigation"
            type="text"
            style={{
              color: foregroundColor ?? UI_COLORS.text,
              height: pageStyle.height,
              width: pageStyle.height,
            }}
            icon={<Icon name="ellipsis-vertical" />}
          />
        </span>
      </Dropdown>
    </div>
  );
}
