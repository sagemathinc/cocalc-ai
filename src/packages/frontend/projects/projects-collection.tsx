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
  type ProjectTableRecord,
} from "./projects-table-columns";
import { ProjectThemeAvatar } from "./theme";
import { COMPUTE_STATES } from "@cocalc/util/compute-states";
import "./projects-collection.css";
import { AliasDialog } from "@cocalc/frontend/people/alias-dialog";
import { setProjectAlias, useProjectAliases } from "./project-aliases";
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

// Selection helpers live in a small module so other collections can use
// them without loading this page.
export {
  displayOrder,
  rangeSelection,
} from "@cocalc/frontend/components/collection-selection";
import {
  displayOrder,
  rangeSelection,
} from "@cocalc/frontend/components/collection-selection";

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
  // The scrolling element the cards are virtualized in. null until it mounts:
  // nothing is rendered then, since rendering every card unvirtualized is slow
  // with thousands of projects (an instructor of a large course). Undefined
  // renders every card.
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
  const aliases = useProjectAliases();
  const [aliasFor, setAliasFor] = useState<ProjectTableRecord>();
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
          alias={aliases.get(record.project_id)}
          onEditAlias={() => setAliasFor(record)}
        />
      </div>
    );
    const props = {
      record,
      selecting: selectedProjectIds.length > 0,
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
      ) : scrollParent === null ? null : scrollParent ? (
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
      <AliasDialog
        open={aliasFor != null}
        title={aliasFor?.title || "Untitled"}
        alias={aliasFor ? aliases.get(aliasFor.project_id) : undefined}
        urlKind="projects"
        onClose={() => setAliasFor(undefined)}
        onSave={async (alias) => {
          if (aliasFor) await setProjectAlias(aliasFor.project_id, alias);
        }}
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
  selecting?: boolean;
  checkbox: ReactNode;
  actions: ReactNode;
  rootfs: ReactNode;
  onOpen: (e?: React.MouseEvent) => void;
}

function Title({
  record,
  lines = 1,
}: {
  record: ProjectTableRecord;
  lines?: number;
}) {
  const running = record.state?.get?.("state") === "running";
  const alias = useProjectAliases().get(record.project_id);
  return (
    <span
      title={record.title || "Untitled"}
      style={{
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: lines,
        overflow: "hidden",
        overflowWrap: "anywhere",
        lineHeight: 1.3,
        fontSize: 15,
        fontWeight: running ? 600 : 500,
        opacity: record.deleting || record.deletionScheduled ? 0.6 : undefined,
      }}
    >
      {record.title || "Untitled"}
      {alias && (
        <span style={{ color: UI_COLORS.link, fontWeight: 400 }}>
          {" "}
          @{alias}
        </span>
      )}
    </span>
  );
}

// Run state, and role only when it is not Owner (the common case), plus
// deletion and archive markers.
function StatusLine({ record }: { record: ProjectTableRecord }) {
  const intl = useIntl();
  const state = record.state?.get?.("state");
  const stateIcon = getStateIcon(record.state);
  const display = state ? COMPUTE_STATES[state]?.display : undefined;
  const label = display ? intl.formatMessage(display) : "";
  const deleteFailed = record.deleteFailed && !record.deletionScheduled;
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        minWidth: 0,
        fontSize: 12,
        color: UI_COLORS.secondary,
      }}
    >
      {label && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            color: state === "running" ? UI_COLORS.success : undefined,
          }}
        >
          {stateIcon && <Icon name={stateIcon} />}
          {label}
        </span>
      )}
      {record.currentRole && record.currentRole !== "owner" && (
        <span>
          {label ? "· " : ""}
          {record.currentRole === "viewer" ? "Viewer" : "Collaborator"}
        </span>
      )}
      {record.deletionScheduled && (
        <Tag color="orange" style={{ margin: 0 }}>
          Scheduled for deletion
        </Tag>
      )}
      {record.deleting && (
        <Tag color="orange" style={{ margin: 0 }}>
          Deleting...
        </Tag>
      )}
      {deleteFailed && (
        <Tag color="red" style={{ margin: 0 }}>
          Deletion failed
        </Tag>
      )}
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

// Clicking anywhere on a card or row (outside its controls) opens the
// project; the title is the keyboard-focusable open button.
function rowClick(onOpen: ItemProps["onOpen"]) {
  return {
    onClick: (e: React.MouseEvent) => onOpen(e),
    onAuxClick: (e: React.MouseEvent) => onOpen(e),
  };
}

function OpenTitle({
  record,
  onOpen,
  lines,
}: Pick<ItemProps, "record" | "onOpen"> & { lines?: number }) {
  return (
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
      style={{ ...OPEN_BUTTON, display: "block", width: "100%" }}
    >
      <Title record={record} lines={lines} />
    </button>
  );
}

// Fixed height so cards in a row line up, as in People and Agents.
function GridCard({
  record,
  selecting,
  checkbox,
  actions,
  rootfs,
  onOpen,
}: ItemProps) {
  return (
    <div
      className={`cocalc-project-card${selecting ? " cocalc-project-card-selecting" : ""}`}
      {...rowClick(onOpen)}
      style={{
        height: 156,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 12px 8px 14px",
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 10,
        background: UI_COLORS.surface,
        // The project's color, when it has one, as an accent stripe.
        boxShadow: record.color ? `inset 4px 0 ${record.color}` : undefined,
        cursor: "pointer",
        opacity: record.deletionBlocked ? 0.72 : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <ProjectThemeAvatar theme={record.theme} size={40} border />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          <OpenTitle record={record} onOpen={onOpen} lines={2} />
          <StatusLine record={record} />
        </div>
        <span
          className="cocalc-project-card-select"
          onClick={(e) => e.stopPropagation()}
        >
          {checkbox}
        </span>
      </div>
      <div style={{ minWidth: 0, paddingLeft: 50 }}>{rootfs}</div>
      <span style={{ flex: 1 }} />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderTop: `1px solid ${UI_COLORS.border}`,
          paddingTop: 6,
          cursor: "default",
        }}
      >
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
          title={record.host}
        >
          {record.last_edited && <TimeAgo date={record.last_edited} />}
          {record.host ? ` · ${record.host}` : ""}
        </span>
        {actions}
      </div>
    </div>
  );
}

// One-line row with fixed columns: project, host, collaborators, edited.
function ListRow({ record, checkbox, actions, rootfs, onOpen }: ItemProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 56,
        padding: "0 8px 0 12px",
        border: `1px solid ${UI_COLORS.border}`,
        boxShadow: record.color ? `inset 4px 0 ${record.color}` : undefined,
        marginTop: -1,
        background: UI_COLORS.surface,
        opacity: record.deletionBlocked ? 0.72 : undefined,
      }}
    >
      {checkbox}
      <div
        {...rowClick(onOpen)}
        style={{
          cursor: "pointer",
          flex: 1,
          alignSelf: "stretch",
          display: "grid",
          gridTemplateColumns:
            "minmax(0, 4fr) minmax(0, 1.4fr) 112px minmax(88px, 120px)",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          <ProjectThemeAvatar theme={record.theme} size={32} border />
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              gap: 2,
            }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <OpenTitle record={record} onOpen={onOpen} />
              </span>
              <span style={{ flexShrink: 0 }}>
                <StatusLine record={record} />
              </span>
            </span>
            {rootfs}
          </span>
        </span>
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
