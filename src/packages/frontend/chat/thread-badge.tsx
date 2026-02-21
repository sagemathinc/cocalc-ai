/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { avatar_fontcolor } from "@cocalc/frontend/account/avatar/font-color";
import { Icon } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { COLORS } from "@cocalc/util/theme";

interface ThreadBadgeProps {
  icon?: string;
  color?: string;
  image?: string;
  size?: number;
  fallbackIcon?: IconName;
  style?: CSSProperties;
}

export function ThreadBadge({
  icon,
  color,
  image,
  size = 22,
  fallbackIcon,
  style,
}: ThreadBadgeProps) {
  const hasImage = typeof image === "string" && image.trim().length > 0;
  if (hasImage) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: `1px solid ${COLORS.GRAY_L}`,
          overflow: "hidden",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
          background: COLORS.GRAY_L0,
          ...style,
        }}
      >
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img
          src={image.trim()}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </span>
    );
  }
  const hasCustom = Boolean(icon || color);
  const resolvedIcon = (icon as IconName) ?? fallbackIcon ?? (hasCustom ? ("dot-circle" as IconName) : undefined);
  if (!resolvedIcon) return null;
  const background = color ?? (hasCustom ? COLORS.GRAY_L0 : "transparent");
  const border = color ? "none" : `1px solid ${COLORS.GRAY_L}`;
  const iconColor = color ? avatar_fontcolor(background) : COLORS.GRAY_M;
  const fontSize = Math.round(size * 0.6);

  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background,
        border,
        color: iconColor,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
        ...style,
      }}
    >
      <Icon name={resolvedIcon} style={{ fontSize, color: iconColor }} />
    </span>
  );
}
