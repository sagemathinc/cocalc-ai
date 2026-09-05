/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { theme, ThemeConfig } from "antd";
import { debounce } from "lodash";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import { useAccountOtherSetting } from "@cocalc/frontend/app-framework";
import { IntlMessage, isIntlMessage } from "@cocalc/frontend/i18n";
import { useActivityBarPreferences } from "@cocalc/frontend/project/page/activity-bar-storage";
import { useAnimationsEnabled } from "./animations";
import { getBaseAntdTheme } from "./antd-base-theme";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import { appearancePalette } from "@cocalc/util/appearance-palette";
import { NARROW_THRESHOLD_PX, PageStyle } from "./top-nav-consts";
import useAppContext, { AppContext, AppState, calcStyle } from "./use-context";

export { AppContext, useAppContext };

export function useAppContextProvider(): AppState {
  const intl = useIntl();
  const { labels: showActBarLabels } = useActivityBarPreferences();

  const [pageWidthPx, setPageWidthPx] = useState<number>(window.innerWidth);

  const [narrow, setNarrow] = useState<boolean>(isNarrow());

  function update() {
    setNarrow(isNarrow());
    if (window.innerWidth != pageWidthPx) {
      setPageWidthPx(window.innerWidth);
    }
  }

  useEffect(() => {
    const handleResize = debounce(update, 50, {
      leading: false,
      trailing: true,
    });

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // avoid updating the style on every resize event
  const pageStyle: PageStyle = useMemo(() => {
    return calcStyle(narrow);
  }, [narrow]);

  function formatIntl(
    msg: IntlMessage | ReactNode | string,
  ): ReactNode | string {
    if (isIntlMessage(msg)) {
      return intl.formatMessage(msg);
    } else {
      return msg;
    }
  }

  function displayI18N(
    label: string | IntlMessage | ReactNode,
  ): string | ReactNode {
    if (isIntlMessage(label)) {
      return intl.formatMessage(label);
    } else {
      return label;
    }
  }

  return {
    formatIntl,
    displayI18N,
    pageWidthPx,
    pageStyle,
    showActBarLabels,
  };
}

export function useAntdStyleProvider() {
  const { resolved } = useAppearance();
  const rounded = useAccountOtherSetting<boolean>("antd_rounded") ?? true;
  const animate = useAnimationsEnabled();
  const branded = useAccountOtherSetting<boolean>("antd_brandcolors") ?? false;
  const compact = useAccountOtherSetting<boolean>("antd_compact") ?? false;

  const antdTheme = useMemo<ThemeConfig>(() => {
    const baseTheme = getBaseAntdTheme(resolved);
    const borderStyle = rounded
      ? undefined
      : { borderRadius: 0, borderRadiusLG: 0, borderRadiusSM: 0 };

    const animationStyle = animate ? undefined : { motion: false };

    const primaryColor = branded
      ? undefined
      : { colorPrimary: appearancePalette(resolved).primary };

    const algorithm = {
      algorithm: [
        resolved === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        ...(compact ? [theme.compactAlgorithm] : []),
      ],
    };

    return {
      ...baseTheme,
      ...algorithm,
      token: {
        ...(baseTheme.token ?? {}),
        ...primaryColor,
        ...borderStyle,
        ...animationStyle,
      },
      components: {
        Button: {
          ...primaryColor,
        },
      },
    };
  }, [resolved, rounded, animate, branded, compact]);

  return {
    antdTheme,
  };
}

function isNarrow(): boolean {
  return window.innerWidth != null && window.innerWidth <= NARROW_THRESHOLD_PX;
}
