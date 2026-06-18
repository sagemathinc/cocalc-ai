/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { MenuOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";

import { Button, Drawer, Flex, Menu, Space, Typography, theme } from "antd";
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
import { joinUrlPath } from "@cocalc/util/url-path";

type PublicInfoPageKey =
  | "home"
  | "docs"
  | "features"
  | "guides"
  | "products"
  | "pricing"
  | "news"
  | "about"
  | "policies"
  | "support";

export type PublicTopNavActiveKey = PublicInfoPageKey | "auth";

type PublicTopNavItemKey = PublicInfoPageKey;

const COMPACT_NAV_MEDIA_QUERY = "(max-width: 875px)";
const DESKTOP_LOGO_MENU_GAP_PX = 32;
const { Text } = Typography;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function matchesCompactNav(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COMPACT_NAV_MEDIA_QUERY).matches;
}

function useCompactNav(): boolean {
  const [isCompact, setIsCompact] = useState(matchesCompactNav);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(COMPACT_NAV_MEDIA_QUERY);
    const update = () => setIsCompact(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isCompact;
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
  const config = usePublicConfig();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isAuthenticated = !!config?.is_authenticated;
  const accountDisplayName = config?.account_display_name?.trim();
  const isCompact = useCompactNav();
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
    { href: appPath("guides"), key: "guides", label: "Guides" },
    { href: appPath("docs"), key: "docs", label: "Docs" },
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
  const menuItems: MenuProps["items"] = publicInfoItems.map((item) => ({
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
  const appActions = isAuthenticated ? (
    <>
      {accountDisplayName ? (
        <span
          style={{
            alignItems: "center",
            display: "inline-flex",
            maxWidth: isCompact ? 110 : 180,
          }}
        >
          <Text
            title={accountDisplayName}
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {accountDisplayName}
          </Text>
        </span>
      ) : null}
      <Button
        href={appPath("projects")}
        size={isCompact ? "small" : "middle"}
        type="primary"
      >
        Projects
      </Button>
      <Button href={appPath("settings")} size={isCompact ? "small" : "middle"}>
        Settings
      </Button>
    </>
  ) : null;

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
        <Space>{isAuthenticated ? appActions : authActions}</Space>
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
    <Flex align="center">
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
          marginInlineStart: DESKTOP_LOGO_MENU_GAP_PX,
        }}
      />
      <Space>{isAuthenticated ? appActions : authActions}</Space>
    </Flex>
  );
}
