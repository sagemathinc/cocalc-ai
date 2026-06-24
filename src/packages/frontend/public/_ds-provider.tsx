/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Provider wrapper for /design-sync previews. Replicates PublicPage's antd
// ConfigProvider theme + App context + the public-site page CSS (shell.tsx),
// WITHOUT the page chrome (header/nav/footer) — so each public-site primitive
// renders standalone in a Claude Design preview card with the correct tokens,
// colors, and fonts. Exported through the public barrel and referenced by the
// converter as cfg.provider.component = "DSProvider" (excluded from the
// component card list via cfg.componentSrcMap).

import type { ReactNode } from "react";

import { App as AntdApp, ConfigProvider } from "antd";

import { PUBLIC_PAGE_CSS } from "./layout/shell";
import { PUBLIC_COLORS } from "./theme";

export function DSProvider({ children }: { children?: ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        token: {
          borderRadius: 8,
          colorBgLayout: PUBLIC_COLORS.pageBackground,
          colorBorder: PUBLIC_COLORS.border,
          colorBorderSecondary: PUBLIC_COLORS.border,
          colorInfo: PUBLIC_COLORS.brand,
          colorLink: PUBLIC_COLORS.link,
          colorLinkActive: PUBLIC_COLORS.brandActive,
          colorLinkHover: PUBLIC_COLORS.linkHover,
          colorPrimary: PUBLIC_COLORS.brand,
          colorPrimaryActive: PUBLIC_COLORS.brandActive,
          colorPrimaryHover: PUBLIC_COLORS.linkHover,
          colorText: PUBLIC_COLORS.text,
          colorTextHeading: PUBLIC_COLORS.heading,
          colorTextSecondary: PUBLIC_COLORS.mutedText,
        },
      }}
    >
      <AntdApp>
        <style>{PUBLIC_PAGE_CSS}</style>
        {children}
      </AntdApp>
    </ConfigProvider>
  );
}
