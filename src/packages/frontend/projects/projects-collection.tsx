/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Projects list as cards or rows, with the same pinned section and
// drag-to-reorder as Agents, People and the Library. Pins are the starred
// projects (same storage and order as the classic starred bar). Checkboxes
// drive the existing bulk operations.

import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Checkbox, Select, Tag, Typography } from "antd";
import { useIntl } from "react-intl";
import { useActions } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import {
  Collection,
  CollectionViewControl,
  type CollectionControls,
  type CollectionView,
} from "@cocalc/frontend/components/collection";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import { VirtualCollectionContext } from "@cocalc/frontend/components/virtual-collection";
import { labels } from "@cocalc/frontend/i18n";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { CollaboratorsAvatars } from "./collaborators-avatars";
import {
  ProjectRootfsBadge,
  ProjectRootfsRuntimeModal,
} from "./project-rootfs-badge";
import { ProjectActionsMenu } from "./projects-actions-menu";
import {
  getStateIcon,
  projectDescriptionText,
  projectRoleTag,
  type ProjectTableRecord,
} from "./projects-table-columns";
import { ProjectThemeAvatar } from "./theme";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { useProjectTableRecords } from "./use-project-table-records";

export type ProjectsSort = "last_edited" | "title" | "host";
export type ProjectsGroup = "none" | "host";

// visible_projects arrive ordered by last edited.
export function sortProjectRecords(
  records: ProjectTableRecord[],
  sort: ProjectsSort,
): ProjectTableRecord[] {
  if (sort === "last_edited") return records;
  const key = (r: ProjectTableRecord) =>
    `${sort === "title" ? r.title : (r.host ?? "")}`.toLowerCase();
  return [...records].sort(
    (a, b) => key(a).localeCompare(key(b)) || a.title.localeCompare(b.title),
  );
}

// The order Collection shows items in: pins (in pin order), then the rest,
// each grouped (by first appearance) when grouping is on. Shift-click
// selection ranges follow this order.
export function displayOrder(
  ids: string[],
  pins: string[],
  groupKey?: (id: string) => string,
): string[] {
  const pinPosition = new Map(pins.map((id, index) => [id, index]));
  const pinned = ids
    .filter((id) => pinPosition.has(id))
    .sort((a, b) => pinPosition.get(a)! - pinPosition.get(b)!);
  const others = ids.filter((id) => !pinPosition.has(id));
  const grouped = (section: string[]) => {
    if (!groupKey) return section;
    const groups = new Map<string, string[]>();
    for (const id of section) {
      const key = groupKey(id);
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    return [...groups.values()].flat();
  };
  return [...grouped(pinned), ...grouped(others)];
}

// Shift-click: set every selectable id between the anchor and `id` to `on`.
export function rangeSelection({
  order,
  selected,
  anchor,
  id,
  on,
  selectable,
}: {
  order: string[];
  selected: string[];
  anchor?: string;
  id: string;
  on: boolean;
  selectable: (id: string) => boolean;
}): string[] {
  const from = anchor == null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  const range =
    from < 0 || to < 0
      ? [id]
      : order.slice(Math.min(from, to), Math.max(from, to) + 1);
  const targets = new Set(range.filter(selectable));
  targets.add(id);
  const rest = selected.filter((x) => !targets.has(x));
  return on ? [...rest, ...order.filter((x) => targets.has(x))] : rest;
}

export function ProjectsCollection({
  visible_projects,
  rootfsImages,
  rootfsImagesLoading,
  selectedProjectIds,
  onSelectedProjectIdsChange,
  view,
  onViewChange,
  scrollParent,
}: {
  visible_projects: string[];
  rootfsImages: RootfsImageEntry[];
  rootfsImagesLoading?: boolean;
  selectedProjectIds: string[];
  onSelectedProjectIdsChange: (ids: string[]) => void;
  view: CollectionView;
  onViewChange: (view: CollectionView) => void;
  scrollParent?: HTMLElement | null;
}) {
  const intl = useIntl();
  const actions = useActions("projects");
  const projectLabel = intl.formatMessage(labels.project);
  const records = useProjectTableRecords({ visible_projects, projectLabel });
  const {
    bookmarkedProjects,
    setProjectBookmarked,
    setBookmarkedProjectsOrder,
  } = useBookmarkedProjects();
  const [sort, setSort] = useState<ProjectsSort>("last_edited");
  const [group, setGroup] = useState<ProjectsGroup>("none");
  const [rootfsModalProjectId, setRootfsModalProjectId] = useState("");
  const items = useMemo(
    () => sortProjectRecords(records, sort),
    [records, sort],
  );
  const selected = new Set(selectedProjectIds);
  const selectable = items.filter((r) => !r.deleting && !r.deletionScheduled);
  const allSelected =
    selectable.length > 0 &&
    selectable.every((r) => selected.has(r.project_id));

  const anchor = useRef<string | undefined>(undefined);
  function toggleSelected(id: string, on: boolean, shift: boolean) {
    if (shift && anchor.current != null) {
      const host = new Map(items.map((r) => [r.project_id, r.host ?? ""]));
      onSelectedProjectIdsChange(
        rangeSelection({
          order: displayOrder(
            items.map((r) => r.project_id),
            bookmarkedProjects,
            group === "host" ? (id) => host.get(id) ?? "" : undefined,
          ),
          selected: selectedProjectIds,
          anchor: anchor.current,
          id,
          on,
          selectable: (x) => selectable.some((r) => r.project_id === x),
        }),
      );
    } else {
      onSelectedProjectIdsChange(
        on
          ? [...selectedProjectIds.filter((x) => x !== id), id]
          : selectedProjectIds.filter((x) => x !== id),
      );
    }
    anchor.current = id;
  }

  function open(record: ProjectTableRecord, e?: React.MouseEvent) {
    if (record.deletionBlocked) return;
    actions.open_project({
      project_id: record.project_id,
      target: "files/",
      switch_to: !(e?.button === 1 || e?.ctrlKey || e?.metaKey),
    });
  }

  function renderItem(
    record: ProjectTableRecord,
    controls: CollectionControls,
  ) {
    const checkbox = (
      // Shift-click selects a range; keep it from also selecting page text.
      <span
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault();
        }}
        style={{ display: "inline-flex" }}
      >
        <Checkbox
          aria-label={`Select project ${record.title}`}
          checked={selected.has(record.project_id)}
          disabled={record.deleting || record.deletionScheduled}
          onChange={(e) =>
            toggleSelected(
              record.project_id,
              e.target.checked,
              !!(e.nativeEvent as MouseEvent | undefined)?.shiftKey,
            )
          }
        />
      </span>
    );
    const actionsNode = (
      <div style={CONTROLS_STYLE}>
        <span style={{ width: 28, display: "inline-flex" }}>
          {controls.dragHandle}
        </span>
        {controls.pinButton}
        <ProjectActionsMenu
          record={record}
          onToggleDetails={() =>
            actions.toggle_expanded_project(record.project_id)
          }
        />
      </div>
    );
    const props = {
      record,
      checkbox,
      actions: actionsNode,
      onOpen: (e?: React.MouseEvent) => open(record, e),
      rootfs: (
        <ProjectMetadata
          record={record}
          rootfsImages={rootfsImages}
          rootfsImagesLoading={rootfsImagesLoading}
          onOpenRootfs={() => setRootfsModalProjectId(record.project_id)}
        />
      ),
    };
    return view === "grid" ? <GridCard {...props} /> : <ListRow {...props} />;
  }

  const collection = (
    <Collection<ProjectTableRecord>
      items={items}
      itemId={(r) => r.project_id}
      itemTitle={(r) => r.title || "Untitled"}
      pins={bookmarkedProjects}
      view={view}
      otherTitle={intl.formatMessage(labels.projects)}
      group={group === "host" ? (r) => r.host || "" : undefined}
      groupTitle={(host) => host || "No host"}
      onPin={(r, pinned) => setProjectBookmarked(r.project_id, pinned)}
      onMove={(visible, id, index) =>
        setBookmarkedProjectsOrder(
          moveVisibleCollectionPin(bookmarkedProjects, visible, id, index),
        )
      }
      renderItem={renderItem}
    />
  );

  return (
    <div
      style={
        {
          "--collection-grid-min-width": "280px",
          "--collection-heading-size": "16px",
        } as CSSProperties
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Checkbox
          aria-label="Select all projects"
          checked={allSelected}
          indeterminate={!allSelected && selectedProjectIds.length > 0}
          disabled={selectable.length === 0}
          onChange={(e) =>
            onSelectedProjectIdsChange(
              e.target.checked ? selectable.map((r) => r.project_id) : [],
            )
          }
        >
          <span style={{ color: UI_COLORS.secondary, fontSize: 13 }}>
            {items.length}{" "}
            {items.length === 1
              ? projectLabel
              : intl.formatMessage(labels.projects)}
            {selectedProjectIds.length > 0 &&
              ` · ${selectedProjectIds.length} selected`}
          </span>
        </Checkbox>
        <span style={{ flex: 1 }} />
        <Select
          aria-label="Sort projects"
          value={sort}
          onChange={setSort}
          style={{ minWidth: 130 }}
          options={[
            { value: "last_edited", label: "Last edited" },
            { value: "title", label: "Title" },
            { value: "host", label: "Host" },
          ]}
        />
        <Select
          aria-label="Group projects"
          value={group}
          onChange={setGroup}
          style={{ minWidth: 140 }}
          options={[
            { value: "none", label: "No grouping" },
            { value: "host", label: "By host" },
          ]}
        />
        <CollectionViewControl
          view={view}
          onChange={onViewChange}
          label="Projects"
        />
      </div>
      {items.length === 0 ? (
        <Typography.Paragraph type="secondary">
          No matching projects.
        </Typography.Paragraph>
      ) : scrollParent ? (
        <VirtualCollectionContext.Provider
          value={{ scrollParent, loadMore: () => {} }}
        >
          {collection}
        </VirtualCollectionContext.Provider>
      ) : (
        collection
      )}
      <ProjectRootfsRuntimeModal
        onClose={() => setRootfsModalProjectId("")}
        open={!!rootfsModalProjectId}
        project_id={rootfsModalProjectId}
      />
    </div>
  );
}

const CONTROLS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  flexShrink: 0,
};

const ELLIPSIS: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const OPEN_BUTTON: CSSProperties = {
  border: "none",
  background: "transparent",
  color: UI_COLORS.text,
  cursor: "pointer",
  textAlign: "left",
  padding: 0,
  font: "inherit",
  minWidth: 0,
};

interface ItemProps {
  record: ProjectTableRecord;
  checkbox: ReactNode;
  actions: ReactNode;
  rootfs: ReactNode;
  onOpen: (e?: React.MouseEvent) => void;
}

function Title({ record }: { record: ProjectTableRecord }) {
  const stateIcon = getStateIcon(record.state);
  const state = record.state?.get?.("state");
  const deleteFailed = record.deleteFailed && !record.deletionScheduled;
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}
    >
      {stateIcon && (
        <Icon
          name={stateIcon}
          style={{ fontSize: 13, color: UI_COLORS.secondary, flexShrink: 0 }}
        />
      )}
      <span
        style={{
          ...ELLIPSIS,
          fontWeight: state === "running" ? 600 : 500,
          opacity:
            record.deleting || record.deletionScheduled ? 0.6 : undefined,
        }}
      >
        {record.title || "Untitled"}
      </span>
      <span style={{ flexShrink: 0, display: "inline-flex" }}>
        {projectRoleTag(record.currentRole)}
        {record.deletionScheduled && (
          <Tag color="orange">Scheduled for deletion</Tag>
        )}
        {state === "archived" && <Tag color="purple">Archived</Tag>}
        {record.deleting && <Tag color="orange">Deleting...</Tag>}
        {deleteFailed && <Tag color="red">Deletion failed</Tag>}
      </span>
    </span>
  );
}

// Image badge and description, on one line.
function ProjectMetadata({
  record,
  rootfsImages,
  rootfsImagesLoading,
  onOpenRootfs,
}: {
  record: ProjectTableRecord;
  rootfsImages: RootfsImageEntry[];
  rootfsImagesLoading?: boolean;
  onOpenRootfs: () => void;
}) {
  const description = projectDescriptionText(record.description);
  const showRootfs = !!record.rootfs_image_id?.trim() && !rootfsImagesLoading;
  if (record.deleteFailed && !record.deletionScheduled)
    return (
      <span style={{ ...ELLIPSIS, color: UI_COLORS.danger, fontSize: 12 }}>
        {record.deleteError
          ? `Error: ${record.deleteError}`
          : "Select it and choose Leave or Delete to retry."}
      </span>
    );
  if (!showRootfs && !description) return null;
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        overflow: "hidden",
        whiteSpace: "nowrap",
        color: UI_COLORS.secondary,
        fontSize: 13,
      }}
    >
      {showRootfs && (
        <span style={{ display: "inline-flex", minWidth: 0, maxWidth: "50%" }}>
          <ProjectRootfsBadge
            rootfsImageId={record.rootfs_image_id}
            rootfsImages={rootfsImages}
            rootfsImagesLoading={rootfsImagesLoading}
            onClick={(e) => {
              e.stopPropagation();
              onOpenRootfs();
            }}
          />
        </span>
      )}
      {description && <span style={ELLIPSIS}>{description}</span>}
    </span>
  );
}

// Avatar and title open the project (keyboard focusable); the image badge
// beside them has its own action, so it is not nested inside that button.
function Heading({
  record,
  rootfs,
  onOpen,
  avatarSize,
}: Pick<ItemProps, "record" | "rootfs" | "onOpen"> & { avatarSize: number }) {
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
    >
      <ProjectThemeAvatar theme={record.theme} size={avatarSize} border />
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          gap: 2,
        }}
      >
        <button
          type="button"
          aria-label={`Open project ${record.title || "Untitled"}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(e);
          }}
          onAuxClick={(e) => {
            e.stopPropagation();
            onOpen(e);
          }}
          style={OPEN_BUTTON}
        >
          <Title record={record} />
        </button>
        {rootfs}
      </span>
    </span>
  );
}

// Clicking anywhere else on a card or row also opens the project.
function rowClick(onOpen: ItemProps["onOpen"]) {
  return {
    onClick: (e: React.MouseEvent) => onOpen(e),
    onAuxClick: (e: React.MouseEvent) => onOpen(e),
    style: { cursor: "pointer" } as CSSProperties,
  };
}

// Fixed height so cards in a row line up, as in People and Agents.
function GridCard({ record, checkbox, actions, rootfs, onOpen }: ItemProps) {
  const click = rowClick(onOpen);
  return (
    <div
      style={{
        height: 136,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        padding: "10px 12px 8px",
        border: `1px solid ${UI_COLORS.border}`,
        borderTop: `4px solid ${record.color ?? UI_COLORS.border}`,
        borderRadius: 8,
        background: UI_COLORS.surface,
        opacity: record.deletionBlocked ? 0.72 : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {checkbox}
        <div
          onClick={click.onClick}
          onAuxClick={click.onAuxClick}
          style={{ ...click.style, flex: 1, minWidth: 0 }}
        >
          <Heading
            record={record}
            rootfs={rootfs}
            onOpen={onOpen}
            avatarSize={32}
          />
        </div>
      </div>
      <div
        onClick={click.onClick}
        onAuxClick={click.onAuxClick}
        style={{ ...click.style, flex: 1 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CollaboratorsAvatars
          collaboratorIds={record.collaborators}
          size={20}
        />
        <span
          style={{
            ...ELLIPSIS,
            color: UI_COLORS.secondary,
            fontSize: 12,
            flex: 1,
          }}
        >
          {record.host ? `${record.host} · ` : ""}
          {record.last_edited && <TimeAgo date={record.last_edited} />}
        </span>
        {actions}
      </div>
    </div>
  );
}

// One-line row with fixed columns: project, host, collaborators, edited.
function ListRow({ record, checkbox, actions, rootfs, onOpen }: ItemProps) {
  const click = rowClick(onOpen);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 56,
        padding: "0 8px 0 10px",
        border: `1px solid ${UI_COLORS.border}`,
        borderLeft: `4px solid ${record.color ?? UI_COLORS.border}`,
        marginTop: -1,
        background: UI_COLORS.surface,
        opacity: record.deletionBlocked ? 0.72 : undefined,
      }}
    >
      {checkbox}
      <div
        onClick={click.onClick}
        onAuxClick={click.onAuxClick}
        style={{
          ...click.style,
          flex: 1,
          alignSelf: "stretch",
          display: "grid",
          gridTemplateColumns:
            "minmax(0, 4fr) minmax(0, 1.4fr) 112px minmax(88px, 120px)",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Heading
          record={record}
          rootfs={rootfs}
          onOpen={onOpen}
          avatarSize={32}
        />
        <span style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}>
          {record.host ?? ""}
        </span>
        <span style={{ display: "inline-flex", minWidth: 0 }}>
          <CollaboratorsAvatars
            collaboratorIds={record.collaborators}
            size={22}
          />
        </span>
        <span
          style={{
            ...ELLIPSIS,
            color: UI_COLORS.secondary,
            fontSize: 13,
            textAlign: "right",
          }}
        >
          {record.last_edited && <TimeAgo date={record.last_edited} />}
        </span>
      </div>
      {actions}
    </div>
  );
}
