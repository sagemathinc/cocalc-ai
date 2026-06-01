/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ComponentType, ReactNode } from "react";
import type { MessageDescriptor } from "react-intl";

import { Icon } from "@cocalc/frontend/components/icon";
import type { IconName } from "@cocalc/frontend/components/icon";
import type { SettingsPageType } from "@cocalc/util/types/settings";

export type SettingsPageIconContext = "menu" | "overview";

export type SettingsPageIcon =
  | IconName
  | ((options: { context: SettingsPageIconContext }) => ReactNode);

export type SettingsPageDefinition = {
  component: ComponentType;
  description: MessageDescriptor;
  icon: SettingsPageIcon;
  key: SettingsPageType;
  label: MessageDescriptor;
};

export function renderSettingsPageIcon(
  icon: SettingsPageIcon,
  context: SettingsPageIconContext,
): ReactNode {
  return typeof icon === "string" ? <Icon name={icon} /> : icon({ context });
}
