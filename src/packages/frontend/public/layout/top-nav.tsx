/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";

import { CloseOutlined, MenuOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";

import { Button, Flex, Grid, Menu, theme } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
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
  | "features"
  | "products"
  | "pricing"
  | "news"
  | "about"
  | "policies"
  | "support";

export type PublicTopNavActiveKey = PublicInfoPageKey | "auth";

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
  const isCompact = !screens.md;
  const logoSquare = getLogoSquare(config);
  const showPolicies = !!config?.show_policies;
  const siteName = getSiteName(config);
  const items: Array<{ href: string; key: PublicInfoPageKey; label: string }> =
    [
      { href: appPath("features"), key: "features", label: "Features" },
      { href: appPath("products"), key: "products", label: "Products" },
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
  items.push({
    href: appPath("support"),
    key: "support",
    label: "Support",
  });
  const menuItems: MenuProps["items"] = items.map((item) => ({
    key: item.key,
    label: <a href={item.href}>{item.label}</a>,
  }));
  const selectedKeys =
    active != null && active !== "auth" && active !== "home" ? [active] : [];
  const authActions = isAuthenticated ? (
    <Button
      href={appPath("projects")}
      size={isCompact ? "small" : "middle"}
      type="primary"
    >
      Projects
    </Button>
  ) : (
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
      <Flex vertical gap="small">
        <Flex align="center" justify="space-between">
          <HomeLogoLink
            active={active}
            config={config}
            isCompact={isCompact}
            logoSquare={logoSquare}
            siteName={siteName}
          />
          <Flex align="center" gap="small">
            {authActions}
            <Button
              aria-label={
                mobileMenuOpen
                  ? "Close navigation menu"
                  : "Open navigation menu"
              }
              aria-expanded={mobileMenuOpen}
              aria-haspopup="menu"
              icon={mobileMenuOpen ? <CloseOutlined /> : <MenuOutlined />}
              onClick={() => setMobileMenuOpen((open) => !open)}
            />
          </Flex>
        </Flex>
        {mobileMenuOpen ? (
          <Menu
            aria-label="Public pages"
            items={menuItems}
            mode="vertical"
            onClick={() => setMobileMenuOpen(false)}
            selectedKeys={selectedKeys}
            style={{
              background: "transparent",
              border: 0,
            }}
          />
        ) : null}
      </Flex>
    );
  }

  return (
    <Flex align="center" gap="middle" justify="space-between" wrap>
      <Flex
        align="center"
        gap="middle"
        style={{
          flex: "1 1 640px",
          minWidth: 280,
        }}
        wrap
      >
        <HomeLogoLink
          active={active}
          config={config}
          isCompact={isCompact}
          logoSquare={logoSquare}
          siteName={siteName}
        />
        <Menu
          aria-label="Public pages"
          disabledOverflow
          items={menuItems}
          mode="horizontal"
          selectedKeys={selectedKeys}
          style={{
            background: "transparent",
            borderBottom: 0,
            flex: "1 1 auto",
            minWidth: 0,
          }}
        />
      </Flex>
      <Flex gap="small" wrap>
        {authActions}
      </Flex>
    </Flex>
  );
}
