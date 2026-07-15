/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card } from "antd";
import type { CardProps } from "antd";

import { COLORS } from "@cocalc/util/theme";

type SettingsCardProps = Omit<CardProps, "size" | "styles" | "type">;

const SETTINGS_CARD_STYLES: CardProps["styles"] = {
  header: {
    alignItems: "center",
    backgroundColor: COLORS.GRAY_LLL,
  },
};

export function SettingsCard(props: SettingsCardProps): React.JSX.Element {
  return <Card {...props} size="middle" styles={SETTINGS_CARD_STYLES} />;
}
