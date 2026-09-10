import type { EntityTheme } from "@cocalc/util/entity-theme";
export type { EntityTheme } from "@cocalc/util/entity-theme";

export function validateArtifactTheme(value: unknown): EntityTheme {
  const row = value as EntityTheme;
  if (!row || typeof row !== "object") throw Error("invalid artifact theme");
  const bounded = (s: unknown, max: number) => {
    if (typeof s !== "string" || s.length > max)
      throw Error("invalid artifact theme text");
    return s;
  };
  const color = (s: unknown) => {
    if (s == null || s === "") return null;
    if (
      typeof s !== "string" ||
      !/^#[a-f0-9]{3,8}$/i.test(s) ||
      ![4, 5, 7, 9].includes(s.length)
    )
      throw Error("invalid artifact theme color");
    return s;
  };
  const icon = row.icon ? bounded(row.icon, 80) : null;
  if (icon && !/^[a-zA-Z0-9_-]+$/.test(icon))
    throw Error("invalid artifact theme icon");
  const blob = row.image_blob || null;
  if (blob && (typeof blob !== "string" || !/^[a-f0-9-]{36}$/i.test(blob)))
    throw Error("invalid artifact theme image");
  return {
    title: bounded(row.title ?? "", 256),
    description: bounded(row.description ?? "", 4096),
    color: color(row.color),
    accent_color: color(row.accent_color),
    icon,
    image_blob: blob,
  };
}
