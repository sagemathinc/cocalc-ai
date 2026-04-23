/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MenuProps } from "antd";

import { Button, Flex, Layout, Menu, theme } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

type PublicInfoPageKey =
  | "home"
  | "features"
  | "pricing"
  | "news"
  | "about"
  | "policies";

type PublicTopNavActiveKey = PublicInfoPageKey | "support" | "auth";

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

export default function PublicTopNav({
  active,
  isAuthenticated = false,
  showPolicies = true,
}: {
  active?: PublicTopNavActiveKey;
  isAuthenticated?: boolean;
  showPolicies?: boolean;
  siteName?: string;
}) {
  const { token } = theme.useToken();
  const items: Array<{ href: string; key: PublicInfoPageKey; label: string }> =
    [
      { href: appPath(""), key: "home", label: "Home" },
      { href: appPath("features"), key: "features", label: "Features" },
      { href: appPath("pricing"), key: "pricing", label: "Pricing" },
      { href: appPath("news"), key: "news", label: "News" },
      { href: appPath("about"), key: "about", label: "About" },
    ];
  if (showPolicies) {
    items.push({
      href: appPath("policies"),
      key: "policies",
      label: "Policies",
    });
  }
  const menuItems: MenuProps["items"] = items.map((item) => ({
    key: item.key,
    label: <a href={item.href}>{item.label}</a>,
  }));
  const selectedKeys =
    active != null && active !== "auth" && active !== "support" ? [active] : [];

  return (
    <Layout.Header
      style={{
        background: "transparent",
        height: "auto",
        lineHeight: "normal",
        marginBottom: token.marginLG,
        padding: 0,
      }}
    >
      <Flex align="center" gap="middle" justify="space-between" wrap>
        <Flex gap="small" wrap>
          {isAuthenticated ? (
            <Button href={appPath("projects")} type="primary">
              Projects
            </Button>
          ) : (
            <>
              <Button href={appPath("auth/sign-in")}>Sign in</Button>
              <Button href={appPath("auth/sign-up")} type="primary">
                Sign up
              </Button>
            </>
          )}
        </Flex>
        <Flex
          style={{
            flex: "1 1 520px",
            justifyContent: "center",
            minWidth: 280,
          }}
        >
          <Menu
            aria-label="Public pages"
            disabledOverflow
            items={menuItems}
            mode="horizontal"
            selectedKeys={selectedKeys}
            style={{
              background: "transparent",
              borderBottom: 0,
              flex: "0 1 auto",
            }}
          />
        </Flex>
        <Flex gap="small" wrap>
          <Button
            aria-current={active === "support" ? "page" : undefined}
            href={appPath("support")}
          >
            Support
          </Button>
        </Flex>
      </Flex>
    </Layout.Header>
  );
}
