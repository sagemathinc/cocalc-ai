/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Avatar } from "antd";
import type { CSSProperties, JSX } from "react";
import type { IconName } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components";
import type { ProjectTheme } from "@cocalc/util/db-schema/projects";
import { COLORS } from "@cocalc/util/theme";
import { projectImageUrl } from "./image";

const DEFAULT_PROJECT_THEME_ICON: IconName = "folder-open";

type ThemeSource =
  | ProjectTheme
  | {
      get?: (key: string) => unknown;
      [key: string]: unknown;
    }
  | null
  | undefined;

function readSourceValue(source: ThemeSource, key: string): unknown {
  if (source == null) {
    return undefined;
  }
  if ("get" in source && typeof source.get === "function") {
    return source.get(key);
  }
  return source[key];
}

function normalizeThemeString(
  source: ThemeSource,
  key: keyof ProjectTheme,
): string | null {
  const value = `${readSourceValue(source, key) ?? ""}`.trim();
  return value.length > 0 ? value : null;
}

export function normalizeProjectTheme(
  source: ThemeSource,
): ProjectTheme | null {
  const theme: ProjectTheme = {
    color: normalizeThemeString(source, "color"),
    accent_color: normalizeThemeString(source, "accent_color"),
    icon: normalizeThemeString(source, "icon"),
    image_blob: normalizeThemeString(source, "image_blob"),
  };
  return Object.values(theme).some((value) => value != null) ? theme : null;
}

export function projectThemeFromProject(
  project?: ThemeSource,
): ProjectTheme | null {
  if (project == null) {
    return null;
  }
  return normalizeProjectTheme(
    readSourceValue(project, "theme") as ThemeSource,
  );
}

export function projectThemeColor(project?: ThemeSource): string | undefined {
  return projectThemeFromProject(project)?.color ?? undefined;
}

export function projectThemeIcon(
  project?: ThemeSource,
  fallback: IconName = DEFAULT_PROJECT_THEME_ICON,
): IconName {
  return (projectThemeFromProject(project)?.icon?.trim() ||
    fallback) as IconName;
}

export function projectThemeImageBlob(
  project?: ThemeSource,
): string | undefined {
  return projectThemeFromProject(project)?.image_blob ?? undefined;
}

export function projectThemeImage(project?: ThemeSource): string | undefined {
  return projectImageUrl(projectThemeImageBlob(project));
}

export function ProjectThemeAvatar({
  project,
  theme,
  size = 40,
  shape = "circle",
  style,
  border = false,
}: {
  project?: ThemeSource;
  theme?: ThemeSource;
  size?: number;
  shape?: "circle" | "square";
  style?: CSSProperties;
  border?: boolean;
}): JSX.Element {
  const resolvedTheme: ProjectTheme =
    normalizeProjectTheme(theme) ?? projectThemeFromProject(project) ?? {};
  const image = projectImageUrl(resolvedTheme.image_blob);
  const color = resolvedTheme.color?.trim() || undefined;
  const accent = resolvedTheme.accent_color?.trim() || undefined;
  const icon = (resolvedTheme.icon?.trim() ||
    DEFAULT_PROJECT_THEME_ICON) as IconName;
  if (image) {
    return (
      <Avatar
        src={image}
        size={size}
        shape={shape}
        style={{
          ...(border && color ? { border: `2px solid ${color}` } : undefined),
          ...style,
        }}
      />
    );
  }
  return (
    <Avatar
      size={size}
      shape={shape}
      style={{
        backgroundColor: accent ?? color ?? COLORS.GRAY_L,
        color: color ?? (accent ? "white" : COLORS.GRAY_D),
        ...(border && color ? { border: `2px solid ${color}` } : undefined),
        ...style,
      }}
      icon={<Icon name={icon} />}
    />
  );
}
