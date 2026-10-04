/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Input, Space, Typography } from "antd";
import { useMemo, useState } from "react";

import { renderRootfsCatalogOption } from "@cocalc/frontend/rootfs/catalog-ui";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

import "./catalog-picker.css";

export function rootfsEntrySearchText(entry: RootfsImageEntry): string {
  return [
    entry.label,
    entry.slug,
    entry.image,
    entry.description,
    entry.content?.title,
    entry.content?.subtitle,
    entry.content?.description,
    entry.content?.publisher?.name,
    entry.theme?.title,
    entry.theme?.description,
    entry.section,
    entry.version,
    entry.channel,
    entry.owner_name,
    "rootfs",
    ...(entry.content?.highlights ?? []),
    ...(entry.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function RootfsCatalogPicker({
  images,
  selectedImage,
  selectedId,
  onSelect,
  loading = false,
  disabled = false,
  search,
  onSearchChange,
  searchPlaceholder = "Search images, e.g. SageMath, R, Python, GPU...",
  emptyText = "No matching images. Try a different search.",
  height = 260,
  maxHeight,
}: {
  images: RootfsImageEntry[];
  selectedImage?: string;
  selectedId?: string;
  onSelect: (entry: RootfsImageEntry) => void;
  loading?: boolean;
  disabled?: boolean;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  // "auto" sizes to the list, up to maxHeight.
  height?: number | "auto";
  maxHeight?: number;
}) {
  const [internalSearch, setInternalSearch] = useState("");
  const query = search ?? internalSearch;
  const setSearch = onSearchChange ?? setInternalSearch;
  const visibleImages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return images;
    return images.filter((entry) =>
      rootfsEntrySearchText(entry).includes(normalized),
    );
  }, [images, query]);

  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Input.Search
        allowClear
        value={query}
        placeholder={searchPlaceholder}
        onChange={(event) => setSearch(event.target.value)}
        disabled={disabled || loading}
      />
      <div
        className="cc-rootfs-catalog-picker-list"
        style={{ height: height === "auto" ? undefined : height, maxHeight }}
      >
        {visibleImages.map((entry) => {
          const selected =
            entry.id === selectedId || entry.image === selectedImage;
          return (
            <button
              key={entry.id}
              type="button"
              className="cc-rootfs-catalog-picker-option"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onSelect(entry)}
            >
              {renderRootfsCatalogOption(entry)}
            </button>
          );
        })}
        {!loading && visibleImages.length === 0 && (
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0, padding: 12 }}
          >
            {emptyText}
          </Typography.Paragraph>
        )}
        {loading && visibleImages.length === 0 && (
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0, padding: 12 }}
          >
            Loading images...
          </Typography.Paragraph>
        )}
      </div>
    </Space>
  );
}
