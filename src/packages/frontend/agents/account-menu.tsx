/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MenuProps } from "antd";
import { Button, Dropdown, Modal, Tag } from "antd";

import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import {
  redux,
  useAsyncEffect,
  useEffect,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import api from "@cocalc/frontend/client/api";
import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";

export function AgentsAccountMenu() {
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const displayName = useTypedRedux("account", "display_name") as
    | string
    | undefined;
  const firstName = useTypedRedux("account", "first_name") as
    | string
    | undefined;
  const lastName = useTypedRedux("account", "last_name") as string | undefined;
  const email = useTypedRedux("account", "email_address") as string | undefined;
  const [membershipClass, setMembershipClass] = useState<string>();
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

  useAsyncEffect(
    async (isMounted) => {
      if (!accountId) return;
      try {
        const membership = (await api("purchases/get-membership")) as {
          class?: string;
        };
        if (isMounted()) setMembershipClass(membership.class);
      } catch {
        if (isMounted()) setMembershipClass(undefined);
      }
    },
    [accountId],
  );

  if (!accountId) return null;

  const name =
    displayNameFromAccount({
      display_name: displayName,
      first_name: firstName,
      last_name: lastName,
    }) ||
    email ||
    "Account";
  const secondary = email && email !== name ? email : "Account";
  const items: MenuProps["items"] = [
    { key: "account", icon: <Icon name="cog" />, label: "Account settings" },
    { key: "membership", icon: <Icon name="star" />, label: "Membership" },
    { key: "balance", icon: <Icon name="credit-card" />, label: "Balance" },
    { key: "appearance", icon: <Icon name="sun" />, label: "Appearance" },
    { type: "divider" },
    {
      key: "sign-out",
      icon: <Icon name="sign-out-alt" />,
      label: "Sign out",
      danger: true,
    },
  ];

  function onMenuClick({ key }: { key: string }) {
    if (key === "sign-out") {
      Modal.confirm({
        title: `Sign out ${email || "of this account"}?`,
        content: "You will be signed out on this browser.",
        okText: "Sign out",
        okButtonProps: { danger: true },
        onOk: async () => {
          await redux.getActions("account")?.sign_out(false);
        },
      });
      return;
    }
    switch (key) {
      case "account":
        openAccountSettings({ page: "index" });
        return;
      case "membership":
        openAccountSettings({ page: "membership" });
        return;
      case "balance":
        openAccountSettings({ page: "balance" });
        return;
      case "appearance":
        openAccountSettings({ page: "appearance" });
        return;
    }
  }

  return (
    <Dropdown
      menu={{ items, onClick: onMenuClick }}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      placement="topLeft"
      trigger={["click"]}
    >
      <span ref={menuTriggerRef} style={{ display: "block" }}>
        <Button
          type="text"
          aria-label={`Account menu for ${name}`}
          style={{
            alignItems: "center",
            display: "flex",
            gap: 10,
            height: "auto",
            justifyContent: "flex-start",
            padding: "8px 6px",
            textAlign: "left",
            width: "100%",
          }}
        >
          <Avatar account_id={accountId} no_loading no_tooltip size={32} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                color: UI_COLORS.text,
                display: "block",
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
            <span
              style={{
                color: UI_COLORS.muted,
                display: "block",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {secondary}
            </span>
          </span>
          {membershipClass === "free" && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              Upgrade
            </Tag>
          )}
          <Icon name="ellipsis-vertical" />
        </Button>
      </span>
    </Dropdown>
  );
}
