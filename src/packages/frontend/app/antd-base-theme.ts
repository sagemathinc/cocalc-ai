/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ThemeConfig } from "antd";

import { COLORS } from "@cocalc/util/theme";
import type { ResolvedAppearance } from "@cocalc/util/appearance";
import { appearancePalette } from "@cocalc/util/appearance-palette";

export function getBaseAntdTheme(
  mode: ResolvedAppearance = "light",
): ThemeConfig {
  const palette = appearancePalette(mode);
  return {
    components: {
      ...(mode === "dark"
        ? {
            Menu: {
              itemSelectedColor: palette.link,
              itemSelectedBg: palette.selected,
            },
          }
        : {}),
      Button: {
        defaultColor: palette.buttonText,
        textTextColor: palette.buttonText,
        defaultHoverColor: palette.linkHover,
        defaultActiveColor: palette.link,
        defaultHoverBorderColor: palette.linkHover,
        defaultActiveBorderColor: palette.link,
      },
    },
    token: {
      colorPrimary: COLORS.COCALC_BLUE,
      colorLink: palette.link,
      colorLinkHover: palette.linkHover,
      colorTextLightSolid: palette.onPrimary,
      colorText: palette.text,
      colorTextSecondary: palette.secondary,
      colorTextDescription: palette.secondary,
      colorTextPlaceholder: palette.muted,
      colorTextDisabled: palette.muted,
      colorBgContainerDisabled: palette.inset,
      colorBgBase: palette.page,
      colorBgContainer: palette.surface,
      colorBgElevated: palette.elevated,
      colorBorder: palette.controlBorder,
      colorBorderSecondary: palette.border,
      colorSuccess: palette.success,
      ...(mode === "light" ? { colorSuccessBg: palette.successBg } : {}),
      colorWarning: palette.warning,
      colorError: palette.danger,
      colorInfo: palette.info,
    },
  };
}
