/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card } from "antd";
import type { CardProps } from "antd";

import { UI_COLORS } from "@cocalc/util/appearance-palette";

type SettingsCardProps = Omit<CardProps, "size" | "styles" | "type">;

const SETTINGS_CARD_STYLES: CardProps["styles"] = {
  header: {
    alignItems: "center",
    backgroundColor: UI_COLORS.inset,
    color: UI_COLORS.text,
  },
};

export function SettingsCard(props: SettingsCardProps): React.JSX.Element {
  return (
    <Card
      {...props}
      title={
        props.title == null ? undefined : (
          <span style={{ color: UI_COLORS.text }}>{props.title}</span>
        )
      }
      size="middle"
      styles={SETTINGS_CARD_STYLES}
    />
  );
}
