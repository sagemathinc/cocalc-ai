/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Typography } from "antd";

import {
  ROOTFS_TAG_DEV_FIXTURE,
  ROOTFS_TAG_ONBOARDING_PREFIX,
  ROOTFS_TAG_PRESET_PREFIX,
  ROOTFS_TAG_PROJECT_PUBLISH,
  ROOTFS_TAG_SNAPSHOT_PREFIX,
  ROOTFS_TAG_SOURCE_PREFIX,
  type RootfsImageEntry,
} from "@cocalc/util/rootfs-images";

const { Text } = Typography;

export type RootfsTagOption = {
  count: number;
  tag: string;
};

export function publicRootfsTags(entry: RootfsImageEntry): string[] {
  const tags = (entry.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .filter(
      (tag) =>
        tag !== ROOTFS_TAG_PROJECT_PUBLISH &&
        tag !== ROOTFS_TAG_DEV_FIXTURE &&
        !tag.startsWith(ROOTFS_TAG_SOURCE_PREFIX) &&
        !tag.startsWith(ROOTFS_TAG_SNAPSHOT_PREFIX) &&
        !tag.startsWith(ROOTFS_TAG_ONBOARDING_PREFIX),
    )
    .map((tag) =>
      tag.startsWith(ROOTFS_TAG_PRESET_PREFIX)
        ? tag.slice(ROOTFS_TAG_PRESET_PREFIX.length)
        : tag,
    );
  return Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b));
}

export function RootfsTagPill({
  count,
  disabled = false,
  selected,
  tag,
  onToggle,
}: {
  count?: number;
  disabled?: boolean;
  selected: boolean;
  tag: string;
  onToggle: (tag: string) => void;
}) {
  const countLabel =
    count == null ? "" : ` (${count} ${count === 1 ? "family" : "families"})`;
  return (
    <Button
      aria-disabled={disabled}
      aria-label={`Filter by #${tag}${countLabel}`}
      aria-pressed={selected}
      onClick={() => {
        if (!disabled) onToggle(tag);
      }}
      shape="round"
      size="small"
      style={disabled ? { cursor: "not-allowed", opacity: 0.5 } : undefined}
      title={
        disabled
          ? "No image families match this tag with the current filters"
          : undefined
      }
      type={selected ? "primary" : "default"}
    >
      #{tag}
      {count == null ? null : (
        <Text
          style={{
            color: selected ? "inherit" : undefined,
            fontSize: "0.85em",
            opacity: 0.72,
          }}
        >
          {" "}
          {count}
        </Text>
      )}
    </Button>
  );
}

export function RootfsTagFilter({
  disabledTags,
  options,
  selectedTags,
  onToggle,
}: {
  disabledTags: Set<string>;
  options: RootfsTagOption[];
  selectedTags: Set<string>;
  onToggle: (tag: string) => void;
}) {
  if (!options.length) return null;
  return (
    <Flex vertical gap="small">
      <Text strong>Filter by tag</Text>
      <Flex
        aria-label="Filter runtime images by tag"
        gap={8}
        role="group"
        wrap="wrap"
      >
        {options.map(({ tag, count }) => (
          <RootfsTagPill
            count={count}
            disabled={disabledTags.has(tag)}
            key={tag}
            onToggle={onToggle}
            selected={selectedTags.has(tag)}
            tag={tag}
          />
        ))}
      </Flex>
    </Flex>
  );
}
