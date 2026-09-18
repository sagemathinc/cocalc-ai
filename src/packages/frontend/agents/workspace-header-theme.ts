/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { avatar_fontcolor } from "@cocalc/frontend/account/avatar/font-color";
import type { ThreadMetadataSnapshot } from "@cocalc/frontend/chat/actions";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export type AgentHeaderAppearance = Pick<
  ThreadMetadataSnapshot,
  | "name"
  | "thread_color"
  | "thread_accent_color"
  | "thread_icon"
  | "thread_image"
>;

export function sameAgentHeaderAppearance(
  left: AgentHeaderAppearance | undefined,
  right: AgentHeaderAppearance,
): boolean {
  return (
    left?.name === right.name &&
    left?.thread_color === right.thread_color &&
    left?.thread_accent_color === right.thread_accent_color &&
    left?.thread_icon === right.thread_icon &&
    left?.thread_image === right.thread_image
  );
}

export function resolveAgentHeaderTheme({
  appearance,
  fallbackTitle,
}: {
  appearance?: AgentHeaderAppearance;
  fallbackTitle: string;
}) {
  const accentColor = appearance?.thread_accent_color?.trim() || undefined;
  const primaryColor = appearance?.thread_color?.trim() || undefined;
  const backgroundColor =
    accentColor ??
    (primaryColor
      ? `color-mix(in srgb, ${primaryColor} 14%, ${UI_COLORS.surface})`
      : UI_COLORS.surface);
  return {
    accentColor,
    backgroundColor,
    primaryColor,
    textColor: accentColor ? avatar_fontcolor(accentColor) : UI_COLORS.text,
    title: appearance?.name?.trim() || fallbackTitle,
  };
}
