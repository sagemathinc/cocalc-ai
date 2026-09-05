/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { DownOutlined, MenuOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";

import { Button, Drawer, Flex, Menu, Space, Typography, theme } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  arePublicPoliciesVisible,
  COCALC_WORDMARK_BLACK_URL,
  COCALC_WORDMARK_WHITE_URL,
  getLogoSquare,
  getSiteName,
  type PublicConfig,
  usePublicConfig,
  usesDefaultCoCalcBranding,
} from "@cocalc/frontend/public/config";
import { Icon } from "@cocalc/frontend/components/icon";
import { featureMeta } from "@cocalc/frontend/public/features/nav-meta";
import {
  getPublicFeaturePage,
  PUBLIC_FEATURE_NAV_ITEMS,
} from "@cocalc/util/public-feature-pages";
import { joinUrlPath } from "@cocalc/util/url-path";
import { AppearanceControl } from "@cocalc/frontend/appearance/control";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";

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

export type PublicTopNavActiveKey =
  | PublicInfoPageKey
  | "auth"
  | "auth-sign-in"
  | "auth-sign-up";

type PublicTopNavItemKey = PublicInfoPageKey;

const COMPACT_NAV_MEDIA_QUERY = "(max-width: 875px)";
const DESKTOP_LOGO_MENU_GAP_PX = 32;
const { Text } = Typography;

// Compact styling for the Features dropdown popup (16 entries): smaller
// rows than antd's default menu size, scrollable if the viewport is low.
const FEATURES_POPUP_CSS = `
  /* Menu overflow placeholders still contain links. Keep their measured width
     without leaving invisible links in the keyboard tab order. */
  .cocalc-public-navigation > .ant-menu-overflow-item[aria-hidden="true"] {
    visibility: hidden;
  }

  .cocalc-features-nav-popup .ant-menu {
    max-height: min(560px, 75vh);
    overflow-y: auto;
  }

  .cocalc-features-nav-popup .ant-menu-item {
    font-size: 13px;
    height: 30px !important;
    line-height: 30px !important;
  }
`;

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

const HOVER_CAPABLE_MEDIA_QUERY = "(hover: hover)";

function matchesHoverCapable(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia(HOVER_CAPABLE_MEDIA_QUERY).matches;
}

// Touch-only devices (no hover) need the features submenu to open on tap;
// a single tap must not hover-open and then click-close it again, so the
// submenu trigger follows the device's hover capability instead of using
// both triggers at once.
function useHoverCapable(): boolean {
  const [hoverCapable, setHoverCapable] = useState(matchesHoverCapable);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(HOVER_CAPABLE_MEDIA_QUERY);
    const update = () => setHoverCapable(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return hoverCapable;
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
  const { resolved } = useAppearance();

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
          src={
            resolved === "dark"
              ? COCALC_WORDMARK_WHITE_URL
              : COCALC_WORDMARK_BLACK_URL
          }
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
  const { token } = theme.useToken();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isAuthenticated = !!config?.is_authenticated;
  const accountDisplayName = config?.account_display_name?.trim();
  const isCompact = useCompactNav();
  const hoverCapable = useHoverCapable();
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
  // On a features page the "Features" entry becomes a dropdown over all
  // feature pages (with a caret); everywhere else it is a plain link.
  const featuresDropdownItems: MenuProps["items"] | undefined =
    active === "features"
      ? [
          {
            icon: <Icon name="star" style={{ color: token.colorPrimary }} />,
            key: "features-all",
            label: <a href={appPath("features")}>All features</a>,
          },
          ...PUBLIC_FEATURE_NAV_ITEMS.filter(({ slug }) =>
            getPublicFeaturePage(slug),
          ).map(({ label, slug }) => {
            const meta = featureMeta(slug);
            return {
              icon: <Icon name={meta.icon} style={{ color: meta.accent }} />,
              key: `features-${slug}`,
              label: <a href={appPath(`features/${slug}`)}>{label}</a>,
            };
          }),
        ]
      : undefined;
  const menuItems: MenuProps["items"] = publicInfoItems.map((item) => {
    if (item.key === "features" && featuresDropdownItems != null) {
      return {
        children: featuresDropdownItems,
        key: item.key,
        popupClassName: "cocalc-features-nav-popup",
        label: (
          <span style={{ color: token.colorLink }}>
            {item.label}
            {/* the drawer's inline menu brings its own expand caret */}
            {!isCompact && (
              <DownOutlined style={{ fontSize: 10, marginInlineStart: 6 }} />
            )}
          </span>
        ),
      };
    }
    return {
      key: item.key,
      label: (
        <a
          href={item.href}
          rel={item.rel}
          style={{
            color: active === item.key ? token.colorLink : undefined,
          }}
          target={item.target}
        >
          {item.label}
        </a>
      ),
    };
  });
  const selectedKeys =
    active != null && !active.startsWith("auth") && active !== "home"
      ? [active]
      : [];
  const primaryAuthAction =
    active === "auth" || active === "auth-sign-in" ? "sign-in" : "sign-up";
  const authActions = isAuthenticated ? null : (
    <>
      <Button
        href={appPath("auth/sign-in")}
        size={isCompact ? "small" : "middle"}
        type={primaryAuthAction === "sign-in" ? "primary" : "default"}
      >
        Sign in
      </Button>
      <Button
        href={appPath("auth/sign-up")}
        size={isCompact ? "small" : "middle"}
        type={primaryAuthAction === "sign-up" ? "primary" : "default"}
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
          <div style={{ marginBottom: 16 }}>
            <AppearanceControl />
          </div>
          <Menu
            aria-label="Public pages"
            items={menuItems}
            mode="inline"
            onClick={() => setMobileMenuOpen(false)}
            selectedKeys={selectedKeys}
          />
        </Drawer>
      </Flex>
    );
  }

  return (
    <Flex align="center">
      <style>{FEATURES_POPUP_CSS}</style>
      <HomeLogoLink
        active={active}
        config={config}
        isCompact={isCompact}
        logoSquare={logoSquare}
        siteName={siteName}
      />
      <Menu
        aria-label="Public pages"
        className="cocalc-public-navigation"
        items={menuItems}
        mode="horizontal"
        selectedKeys={selectedKeys}
        triggerSubMenuAction={hoverCapable ? "hover" : "click"}
        style={{
          background: "transparent",
          borderBottom: 0,
          flex: "1 1 auto",
          minWidth: 0,
          marginInlineStart: DESKTOP_LOGO_MENU_GAP_PX,
        }}
      />
      <Space>
        <AppearanceControl />
        {isAuthenticated ? appActions : authActions}
      </Space>
    </Flex>
  );
}
