/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";

import { MenuOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";

import { Button, Drawer, Flex, Grid, Menu, Space, theme } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  arePublicPoliciesVisible,
  COCALC_WORDMARK_BLACK_URL,
  getLogoSquare,
  getSiteName,
  type PublicConfig,
  usePublicConfig,
  usesDefaultCoCalcBranding,
} from "@cocalc/frontend/public/config";
import { FIELD_GUIDES_URL } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

type PublicInfoPageKey =
  | "home"
  | "features"
  | "products"
  | "pricing"
  | "news"
  | "about"
  | "policies"
  | "support";

export type PublicTopNavActiveKey = PublicInfoPageKey | "auth";

type PublicTopNavItemKey = PublicInfoPageKey | "field-guides" | "projects";

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function HomeLogoLink({
  active,
  config,
  isCompact,
  logoSquare,
  siteName,
}: {
  active?: PublicTopNavActiveKey;
  config?: PublicConfig;
  isCompact: boolean;
  logoSquare: string;
  siteName: string;
}) {
  const { token } = theme.useToken();
  const showWordmark = !isCompact && usesDefaultCoCalcBranding(config);

  return (
    <a
      aria-current={active === "home" ? "page" : undefined}
      aria-label={`${siteName} home`}
      href={appPath("")}
      style={{
        alignItems: "center",
        color: "inherit",
        display: "flex",
        flex: "0 0 auto",
        gap: token.marginXS,
        textDecoration: "none",
      }}
    >
      <img
        alt=""
        aria-hidden="true"
        src={logoSquare}
        style={{
          display: "block",
          height: 28,
          objectFit: "contain",
          width: 28,
        }}
      />
      {showWordmark ? (
        <img
          alt=""
          aria-hidden="true"
          src={COCALC_WORDMARK_BLACK_URL}
          style={{
            display: "block",
            height: 18,
            objectFit: "contain",
            width: "auto",
          }}
        />
      ) : null}
    </a>
  );
}

export default function PublicTopNav({
  active,
}: {
  active?: PublicTopNavActiveKey;
}) {
  const screens = Grid.useBreakpoint();
  const config = usePublicConfig();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isAuthenticated = !!config?.is_authenticated;
  const isCompact = !screens.sm;
  const logoSquare = getLogoSquare(config);
  const showPolicies = arePublicPoliciesVisible(config);
  const siteName = getSiteName(config);
  const publicInfoItems: Array<{
    href: string;
    key: PublicTopNavItemKey;
    label: string;
    rel?: string;
    target?: string;
  }> = [
    { href: appPath("features"), key: "features", label: "Features" },
    {
      href: FIELD_GUIDES_URL,
      key: "field-guides",
      label: "Field guides",
      rel: "noreferrer",
      target: "_blank",
    },
    { href: appPath("products"), key: "products", label: "Products" },
    { href: appPath("pricing"), key: "pricing", label: "Pricing" },
    { href: appPath("news"), key: "news", label: "News" },
    { href: appPath("about"), key: "about", label: "About" },
  ];
  if (showPolicies) {
    publicInfoItems.push({
      href: appPath("policies"),
      key: "policies",
      label: "Policies",
    });
  }
  publicInfoItems.push({
    href: appPath("support"),
    key: "support",
    label: "Support",
  });
  const signedInItems: typeof publicInfoItems = [
    { href: appPath("projects"), key: "projects", label: "Projects" },
    ...publicInfoItems,
  ];
  const items = isAuthenticated ? signedInItems : publicInfoItems;
  const visibleMenuItems =
    isCompact && isAuthenticated
      ? items.filter((item) => item.key !== "projects")
      : items;
  const menuItems: MenuProps["items"] = visibleMenuItems.map((item) => ({
    key: item.key,
    label: (
      <a href={item.href} rel={item.rel} target={item.target}>
        {item.label}
      </a>
    ),
  }));
  const selectedKeys =
    active != null && active !== "auth" && active !== "home" ? [active] : [];
  const authActions = isAuthenticated ? null : (
    <>
      <Button
        href={appPath("auth/sign-in")}
        size={isCompact ? "small" : "middle"}
      >
        Sign in
      </Button>
      <Button
        href={appPath("auth/sign-up")}
        size={isCompact ? "small" : "middle"}
        type="primary"
      >
        Sign up
      </Button>
    </>
  );

  if (isCompact) {
    return (
      <Flex align="center" justify="space-between">
        <HomeLogoLink
          active={active}
          config={config}
          isCompact={isCompact}
          logoSquare={logoSquare}
          siteName={siteName}
        />
        <Space>
          {isAuthenticated ? (
            <Button href={appPath("projects")} size="small">
              Projects
            </Button>
          ) : (
            authActions
          )}
        </Space>
        <Button
          aria-label="Open navigation menu"
          aria-haspopup="menu"
          icon={<MenuOutlined />}
          onClick={() => setMobileMenuOpen(true)}
        />
        <Drawer
          onClose={() => setMobileMenuOpen(false)}
          open={mobileMenuOpen}
          placement="right"
          size={280}
          title="Navigation"
        >
          <Menu
            aria-label="Public pages"
            items={menuItems}
            mode="vertical"
            onClick={() => setMobileMenuOpen(false)}
            selectedKeys={selectedKeys}
          />
        </Drawer>
      </Flex>
    );
  }

  return (
    <Flex>
      <HomeLogoLink
        active={active}
        config={config}
        isCompact={isCompact}
        logoSquare={logoSquare}
        siteName={siteName}
      />
      <Menu
        aria-label="Public pages"
        items={menuItems}
        mode="horizontal"
        selectedKeys={selectedKeys}
        style={{
          background: "transparent",
          borderBottom: 0,
          flex: "1 1 auto",
        }}
      />
      <Space>{authActions}</Space>
    </Flex>
  );
}
