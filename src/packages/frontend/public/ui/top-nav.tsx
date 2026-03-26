/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { COLORS, SITE_NAME } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Text } = Typography;

type PublicNavKey =
  | "home"
  | "features"
  | "support"
  | "news"
  | "about"
  | "policies"
  | "auth";

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

export default function PublicTopNav({
  active,
  isAuthenticated = false,
  showPolicies = true,
  siteName = SITE_NAME,
}: {
  active?: PublicNavKey;
  isAuthenticated?: boolean;
  showPolicies?: boolean;
  siteName?: string;
}) {
  const items: Array<{ href: string; key: PublicNavKey; label: string }> = [
    { href: appPath(""), key: "home", label: "Home" },
    { href: appPath("features"), key: "features", label: "Features" },
    { href: appPath("support"), key: "support", label: "Support" },
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

  return (
    <Flex
      align="center"
      justify="space-between"
      gap={16}
      wrap
      style={{
        marginBottom: 24,
        padding: "12px 16px",
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 16,
        background: "white",
        boxShadow: "0 12px 30px rgba(0, 0, 0, 0.05)",
      }}
    >
      <Flex align="center" gap={10} wrap>
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            background: COLORS.BLUE_D,
          }}
        />
        <a
          href={appPath("")}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          <Text strong style={{ color: COLORS.GRAY_D, fontSize: 16 }}>
            {siteName}
          </Text>
        </a>
      </Flex>
      <Flex wrap gap={8}>
        {items.map((item) => (
          <Button
            key={item.key}
            href={item.href}
            type={active === item.key ? "primary" : "default"}
          >
            {item.label}
          </Button>
        ))}
      </Flex>
      <Flex wrap gap={8}>
        {isAuthenticated ? (
          <>
            <Button href={appPath("projects")}>Projects</Button>
            <Button href={appPath("settings")} type="primary">
              Settings
            </Button>
          </>
        ) : (
          <>
            <Button href={appPath("auth/sign-in")}>Sign in</Button>
            <Button href={appPath("auth/sign-up")} type="primary">
              Sign up
            </Button>
          </>
        )}
      </Flex>
    </Flex>
  );
}
