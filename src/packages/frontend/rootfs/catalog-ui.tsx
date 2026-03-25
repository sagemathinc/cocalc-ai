/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tag } from "antd";

import { Icon } from "@cocalc/frontend/components";
import { blobImageUrl } from "@cocalc/frontend/components/theme-image-input";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { COLORS } from "@cocalc/util/theme";

export function sectionLabel(section: RootfsImageEntry["section"]): string {
  switch (section) {
    case "official":
      return "Official";
    case "mine":
      return "My image";
    case "collaborators":
      return "Collaborator image";
    case "public":
      return "Public image";
    default:
      return "Catalog";
  }
}

export function sectionTagColor(section: RootfsImageEntry["section"]): string {
  switch (section) {
    case "official":
      return "blue";
    case "mine":
      return "green";
    case "collaborators":
      return "gold";
    case "public":
      return "red";
    default:
      return "default";
  }
}

export function groupedRootfsOptions(images: RootfsImageEntry[]) {
  const sections: Array<{
    key: NonNullable<RootfsImageEntry["section"]>;
    label: string;
  }> = [
    { key: "official", label: "Official images" },
    { key: "mine", label: "My images" },
    { key: "collaborators", label: "Collaborator images" },
    { key: "public", label: "Public images" },
  ];
  return sections.reduce<
    Array<{
      label: string;
      options: Array<{
        value: string;
        label: string;
        searchText: string;
        entry: RootfsImageEntry;
      }>;
    }>
  >((acc, { key, label }) => {
    const options = images
      .filter((entry) => entry.section === key)
      .map((entry) => ({
        value: entry.id,
        label: entry.label || entry.image,
        entry,
        searchText: [
          entry.label,
          entry.image,
          entry.description,
          entry.owner_name,
          ...(entry.tags ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      }));
    if (options.length > 0) {
      acc.push({ label, options });
    }
    return acc;
  }, []);
}

export function rootfsOptionSearchText(option?: any): string {
  return `${option?.searchText ?? option?.data?.searchText ?? ""}`.toLowerCase();
}

export function rootfsThemeImageUrl(
  theme?: RootfsImageEntry["theme"],
): string | undefined {
  return blobImageUrl(theme?.image_blob, "rootfs-theme.png");
}

function scanTagColor(entry: RootfsImageEntry): string | undefined {
  if (!entry.scan?.status || entry.scan.status === "unknown") return undefined;
  return entry.scan.status === "clean"
    ? "green"
    : entry.scan.status === "findings"
      ? "orange"
      : entry.scan.status === "error"
        ? "red"
        : "blue";
}

export function renderRootfsCatalogOption(entry: RootfsImageEntry) {
  const imageUrl = rootfsThemeImageUrl(entry.theme);
  const themeColor = entry.theme?.color?.trim() || COLORS.GRAY_L;
  const accentColor =
    entry.theme?.accent_color?.trim() || entry.theme?.color?.trim();
  const themeTitle = entry.theme?.title?.trim() || entry.label || entry.image;
  const themeDescription =
    entry.theme?.description?.trim() || entry.description?.trim();

  return (
    <div
      style={{
        border: `1px solid ${themeColor}`,
        borderRadius: 12,
        padding: "10px 12px",
        background: accentColor ? `${accentColor}18` : "rgba(0, 0, 0, 0.02)",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={`${themeTitle} theme`}
            style={{
              width: 52,
              height: 52,
              borderRadius: 10,
              objectFit: "cover",
              flex: "0 0 auto",
            }}
          />
        ) : (
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: accentColor || "#f5f5f5",
              color: entry.theme?.color || undefined,
              flex: "0 0 auto",
            }}
          >
            <Icon
              name={(entry.theme?.icon?.trim() as any) || "cube"}
              style={{ fontSize: "22px" }}
            />
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
              marginBottom: "2px",
            }}
          >
            <span style={{ fontWeight: 600 }}>{themeTitle}</span>
            {entry.section ? (
              <Tag
                color={sectionTagColor(entry.section)}
                style={{ marginInlineEnd: 0 }}
              >
                {sectionLabel(entry.section)}
              </Tag>
            ) : null}
            {entry.version ? (
              <Tag style={{ marginInlineEnd: 0 }}>{entry.version}</Tag>
            ) : null}
            {entry.channel ? (
              <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
                {entry.channel}
              </Tag>
            ) : null}
            {entry.gpu ? (
              <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                GPU
              </Tag>
            ) : null}
            {scanTagColor(entry) ? (
              <Tag color={scanTagColor(entry)} style={{ marginInlineEnd: 0 }}>
                scan {entry.scan?.status}
              </Tag>
            ) : null}
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: "11px",
              color: COLORS.GRAY_M,
              overflowWrap: "anywhere",
              marginBottom: themeDescription ? "2px" : 0,
            }}
          >
            {entry.image}
          </div>
          {themeDescription ? (
            <div
              style={{
                fontSize: "12px",
                color: COLORS.GRAY_D,
                overflowWrap: "anywhere",
              }}
            >
              {themeDescription}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
