import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentRef, ReactNode } from "react";
import { Alert, Button, Checkbox, Dropdown, Empty, Input, Select } from "antd";
import type { InputRef } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { Icon, isIconName } from "@cocalc/frontend/components";
import { blobImageUrl } from "@cocalc/frontend/components/theme-image-url";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { AgentSearchHit } from "./search-runner";
import { useArtifactPins } from "@cocalc/frontend/chat/use-artifact-pins";
import { useArtifactNames } from "./artifact-names";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import {
  ArtifactCatalogStore,
  artifactIdentity as identity,
  catalogResults,
  CATALOG_LIMITS,
} from "./artifact-catalog-store";

const LibraryAppearanceEditor = lazy(() =>
  import("./library-appearance-editor").then(({ LibraryAppearanceEditor }) => ({
    default: LibraryAppearanceEditor,
  })),
);

interface Props {
  accountId: string;
  agents: NamedAgent[];
  active: boolean;
  activeAgent?: NamedAgent;
  onSelect: (hit: AgentSearchHit) => Promise<void>;
  onShowConversation?: (hit: AgentSearchHit) => Promise<void>;
  onClose?: () => void;
  navigation?: ReactNode;
  /** artifactIdentity(hit); applied on return, without changing filters. */
  selectedArtifactIdentity?: string;
}

export function AgentArtifactBrowser(props: Props) {
  // Remount before rendering another account: never expose the old snapshot.
  return <AccountArtifactBrowser key={props.accountId} {...props} />;
}

function AccountArtifactBrowser({
  accountId,
  agents,
  active,
  onSelect,
  onShowConversation,
  onClose,
  navigation,
  selectedArtifactIdentity,
}: Props) {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string>();
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"list" | "grid">("list");
  const [groupByProject, setGroupByProject] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const organizationId = useId();
  const organizationRef = useRef<ComponentRef<typeof Button>>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const lastArtifact = useRef<string | undefined>(undefined);
  const scrollTop = useRef(0);
  const wasActive = useRef(false);
  const restorePending = useRef(false);
  const searchRef = useRef<InputRef>(null);
  const [catalog] = useState(
    () =>
      new ArtifactCatalogStore(accountId, (opts) =>
        webapp_client.conat_client.hub.artifactCatalog.listProject(opts),
      ),
  );
  const metadata = useSyncExternalStore(catalog.subscribe, catalog.get);
  const [openError, setOpenError] = useState("");
  const [appearanceTarget, setAppearanceTarget] =
    useState<ForeignArtifactTarget>();
  const [opening, setOpening] = useState(false);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (active && !wasActive.current) restorePending.current = true;
    wasActive.current = active;
    if (!active) {
      restorePending.current = false;
      if (viewport.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
      return;
    }
    if (!restorePending.current) return;
    viewport.scrollTop = scrollTop.current;
    // The parent's navigation may finish before its async onSelect settles.
    if (opening) return;
    restorePending.current = false;
    const artifactButton = (id: string | undefined) =>
      id
        ? Array.from(
            viewport.querySelectorAll<HTMLButtonElement>(
              "[data-artifact-identity]",
            ),
          ).find((button) => button.dataset.artifactIdentity === id)
        : undefined;
    const previous = lastFocus.current;
    const target =
      artifactButton(selectedArtifactIdentity) ??
      (previous && viewport.contains(previous) && !previous.closest("[hidden]")
        ? previous
        : artifactButton(lastArtifact.current));
    if (target) target.focus({ preventScroll: true });
    else searchRef.current?.focus({ preventScroll: true });
  }, [active, opening, selectedArtifactIdentity]);
  const pins = useArtifactPins();
  const { names: artifactNames } = useArtifactNames();
  const projects = [
    ...new Set(agents.map((agent) => agent.endpoint.project_id)),
  ].sort();
  const projectKey = JSON.stringify(projects);
  useEffect(() => {
    catalog.start(JSON.parse(projectKey));
    return catalog.stop;
  }, [catalog, projectKey]);

  const ordered = catalogResults(metadata.entries, agents, {
    query,
    project,
    sort,
    pins: sort === "custom" ? pins.pins : [],
    aliases: artifactNames,
  });
  const catalogById = new Map(
    metadata.entries.map((entry) => [
      `${entry.project_id}/${entry.entry_id}`,
      entry,
    ]),
  );
  const projectTitle = (id: string) =>
    agents.find((agent) => agent.endpoint.project_id === id)?.project_title ||
    id;
  // Bound the total rendered rows, not each project independently.
  const groups = new Map<string, AgentSearchHit[]>();
  for (const result of ordered.slice(0, 200)) {
    const key = groupByProject ? result.agent.endpoint.project_id : "";
    const rows = groups.get(key) ?? [];
    rows.push(result);
    groups.set(key, rows);
  }
  async function openResult(result: AgentSearchHit, conversation = false) {
    lastArtifact.current = identity(result);
    setOpening(true);
    setOpenError("");
    try {
      if (conversation) await onShowConversation?.(result);
      else await onSelect(result);
    } catch (err) {
      setOpenError(`${err}`);
    } finally {
      setOpening(false);
    }
  }
  // Retain the DOM as well as the catalog, including disclosure and row state.
  return (
    <div
      ref={viewportRef}
      hidden={!active}
      role="region"
      aria-label="Library"
      onFocusCapture={(event) => {
        lastFocus.current = event.target;
      }}
      onScroll={(event) => {
        if (active) scrollTop.current = event.currentTarget.scrollTop;
      }}
      style={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        flex: 1,
        overflowY: "auto",
        boxSizing: "border-box",
        color: UI_COLORS.text,
        background: UI_COLORS.page,
      }}
    >
      <KeyboardBoundary
        boundary="agent-library"
        style={{
          maxWidth: 1440,
          margin: "0 auto",
          padding: "24px 16px",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            marginBottom: 20,
          }}
        >
          {navigation}
          {onClose && (
            <Button
              type="text"
              aria-label="Return to agent"
              onClick={onClose}
              icon={<Icon name="arrow-left" />}
            />
          )}
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 600,
              flex: "1 1 auto",
            }}
          >
            Library
          </h1>
          <div
            role="group"
            aria-label="Library view"
            style={{ display: "flex", gap: 4 }}
          >
            <Button
              type={view === "grid" ? "primary" : "text"}
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              icon={<Icon name="dashboard" />}
              onClick={() => setView("grid")}
            />
            <Button
              type={view === "list" ? "primary" : "text"}
              aria-label="List view"
              aria-pressed={view === "list"}
              icon={<Icon name="list" />}
              onClick={() => setView("list")}
            />
          </div>
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search library"
            placeholder="Search library"
            prefix={<Icon name="search" />}
            style={{ flex: "0 1 320px", minWidth: 0 }}
            maxLength={256}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </header>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflowWrap: "anywhere",
              color: UI_COLORS.secondary,
              fontSize: 13,
            }}
          >
            {project ? projectTitle(project) : "All projects"}
            <span role="status" aria-atomic="true">
              {" · "}
              {ordered.length} {ordered.length === 1 ? "artifact" : "artifacts"}
              {metadata.loading
                ? ordered.length
                  ? " · Refreshing..."
                  : " · Loading library..."
                : ""}
              {metadata.limited && " · Preview limit reached"}
            </span>
          </div>
          <Button
            ref={organizationRef}
            type="text"
            size="small"
            aria-expanded={organizationOpen}
            aria-controls={organizationId}
            onClick={() => setOrganizationOpen(!organizationOpen)}
            icon={<Icon name="sliders" />}
          >
            Filters & organization
            {project || groupByProject || sort !== "recent" ? " (active)" : ""}
          </Button>
        </div>
        <div
          id={organizationId}
          hidden={!organizationOpen}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.stopPropagation();
              setOrganizationOpen(false);
              organizationRef.current?.focus();
            }
          }}
          style={{
            padding: 16,
            marginBottom: 16,
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 8,
            background: UI_COLORS.surface,
            color: UI_COLORS.text,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "end",
              flexWrap: "wrap",
              gap: 16,
            }}
          >
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <label
                htmlFor={`${organizationId}-project`}
                style={{ display: "block", marginBottom: 4 }}
              >
                Project
              </label>
              <Select
                id={`${organizationId}-project`}
                placeholder="All projects"
                allowClear
                value={project}
                onChange={setProject}
                style={{ width: "100%" }}
                getPopupContainer={(trigger) => trigger.parentElement!}
                options={projects.map((value) => ({
                  value,
                  label: projectTitle(value),
                }))}
              />
            </div>
            <div style={{ flex: "1 1 160px", minWidth: 0 }}>
              <label
                htmlFor={`${organizationId}-sort`}
                style={{ display: "block", marginBottom: 4 }}
              >
                Sort
              </label>
              <Select
                id={`${organizationId}-sort`}
                style={{ width: "100%" }}
                getPopupContainer={(trigger) => trigger.parentElement!}
                value={sort}
                onChange={setSort}
                options={[
                  { value: "recent", label: "Recent" },
                  { value: "title", label: "Title" },
                  { value: "custom", label: "Custom" },
                ]}
              />
            </div>
            <Checkbox
              checked={groupByProject}
              onChange={(e) => setGroupByProject(e.target.checked)}
            >
              Group by project
            </Checkbox>
            <Button
              disabled={metadata.loading}
              onClick={() => void catalog.refresh()}
            >
              Refresh
            </Button>
          </div>
          <details
            style={{ color: UI_COLORS.secondary, fontSize: 12, marginTop: 16 }}
          >
            <summary>About this library</summary>
            <p>
              Metadata from current agent conversations refreshes in the
              background about every 10 seconds, without scanning files or
              starting projects. Search and filters use cached metadata; sources
              may still be indexing.
            </p>
            <p>
              Pinned artifacts appear first in Custom order. Drag pins or use
              their Move up/down menu to reorder within the current group and
              filters.
            </p>
            <p>
              {metadata.indexedSources} indexed sources reported; this is not a
              completeness count. {metadata.checkedProjects} project listings
              read to the end. Coverage may still be partial.
            </p>
            <p>
              Preview limits: {CATALOG_LIMITS.projects} projects,{" "}
              {CATALOG_LIMITS.pages} pages, {CATALOG_LIMITS.entries} entries and
              approximately 16 MiB of metadata per refresh.
            </p>
          </details>
        </div>
        {metadata.error && (
          <Alert
            type="warning"
            title="Library metadata unavailable"
            description={metadata.error}
          />
        )}
        {pins.error && <div role="alert">{pins.error}</div>}
        {openError && <div role="alert">{openError}</div>}
        <div>
          {!metadata.loading && !metadata.error && !ordered.length && (
            <Empty
              description={
                query || project
                  ? "No matching artifacts. Try another search or project."
                  : "No artifacts yet. Saved artifacts will appear here as sources are indexed."
              }
            />
          )}
          {[...groups].map(([projectId, results]) => {
            const visiblePins = results
              .map(identity)
              .filter((id) => pins.pins.includes(id));
            return (
              <section
                key={projectId}
                aria-label={
                  groupByProject ? projectTitle(projectId) : "Artifacts"
                }
              >
                {groupByProject && (
                  <h2 style={{ fontSize: 16, margin: "16px 0 4px" }}>
                    {projectTitle(projectId)}
                  </h2>
                )}
                <div
                  role="list"
                  style={
                    view === "grid"
                      ? {
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fill, minmax(min(100%, 220px), 1fr))",
                          gap: 8,
                        }
                      : undefined
                  }
                >
                  <SortableList
                    items={visiblePins}
                    disabled={sort !== "custom" || view === "grid"}
                    onDragStop={(_from, to, id) => {
                      if (typeof id === "string")
                        pins.move(visiblePins, id, to);
                    }}
                  >
                    {results.map((result) => {
                      const id = identity(result);
                      const alias = artifactNames.find(
                        (item) =>
                          item.active &&
                          item.project_id ===
                            result.agent.endpoint.project_id &&
                          item.entry_id === result.catalogEntryId,
                      )?.name;
                      const appearance = catalogById.get(
                        `${result.agent.endpoint.project_id}/${result.catalogEntryId}`,
                      )?.item.appearance;
                      const pinnedIndex = visiblePins.indexOf(id);
                      const reorder = sort === "custom" && pinnedIndex >= 0;
                      const row = (
                        <div
                          role="listitem"
                          key={identity(result)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: view === "grid" ? "nowrap" : "wrap",
                            flexDirection: view === "grid" ? "column" : "row",
                            minHeight: view === "grid" ? 136 : undefined,
                            padding: view === "grid" ? 10 : "12px 8px",
                            border:
                              view === "grid"
                                ? `1px solid ${appearance?.color ?? UI_COLORS.border}`
                                : undefined,
                            borderBottom:
                              view === "grid"
                                ? undefined
                                : `1px solid ${UI_COLORS.border}`,
                            borderLeft:
                              view === "list" && appearance?.color
                                ? `3px solid ${appearance.color}`
                                : undefined,
                            borderRadius: view === "grid" ? 12 : undefined,
                            background: appearance?.accent_color
                              ? `linear-gradient(130deg, color-mix(in srgb, ${appearance.accent_color} ${view === "grid" ? 12 : 6}%, ${UI_COLORS.surface}), ${UI_COLORS.surface})`
                              : view === "grid"
                                ? UI_COLORS.surface
                                : undefined,
                          }}
                        >
                          {reorder && view === "list" && (
                            <DragHandle
                              id={id}
                              ariaLabel={`Drag ${result.hit.artifact_title} to reorder`}
                              style={{ padding: 4 }}
                            />
                          )}
                          <Button
                            type="text"
                            disabled={opening}
                            aria-label={`Open ${result.hit.artifact_title} from ${result.agent.name}`}
                            data-artifact-identity={id}
                            style={{
                              flex: view === "grid" ? "1 1 auto" : "1 1 180px",
                              minWidth: 0,
                              width: view === "grid" ? "100%" : undefined,
                              height: "auto",
                              whiteSpace: "normal",
                              justifyContent:
                                view === "grid" ? "center" : "flex-start",
                              textAlign: view === "grid" ? "center" : "left",
                            }}
                            onClick={() => void openResult(result)}
                          >
                            <span
                              style={{
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                display: view === "list" ? "flex" : undefined,
                                alignItems: "center",
                                gap: 12,
                              }}
                            >
                              {appearance?.image_blob ? (
                                <img
                                  src={blobImageUrl(appearance.image_blob)}
                                  alt=""
                                  style={{
                                    display: "block",
                                    width: view === "grid" ? 32 : 36,
                                    height: view === "grid" ? 32 : 36,
                                    objectFit: "cover",
                                    borderRadius: 6,
                                    margin:
                                      view === "grid"
                                        ? "0 auto 8px"
                                        : undefined,
                                    flexShrink: 0,
                                  }}
                                />
                              ) : (
                                <Icon
                                  name={
                                    isIconName(appearance?.icon)
                                      ? appearance.icon
                                      : "file"
                                  }
                                  style={{
                                    display: "block",
                                    fontSize: view === "grid" ? 30 : 28,
                                    marginBottom:
                                      view === "grid" ? 8 : undefined,
                                    color: appearance?.color ?? UI_COLORS.text,
                                    flexShrink: 0,
                                  }}
                                />
                              )}
                              <span style={{ minWidth: 0 }}>
                                <strong
                                  style={{
                                    display: "block",
                                  }}
                                >
                                  {result.hit.artifact_title}
                                </strong>
                                {alias && (
                                  <span
                                    style={{
                                      display: "block",
                                      color: UI_COLORS.link,
                                      fontSize: 12,
                                    }}
                                  >
                                    @{alias}
                                  </span>
                                )}
                                <span
                                  style={{
                                    color: UI_COLORS.secondary,
                                    fontSize: 12,
                                  }}
                                >
                                  {projectTitle(
                                    result.agent.endpoint.project_id,
                                  )}{" "}
                                  · @{result.agent.name} ·{" "}
                                  {result.hit.artifact_kind}
                                </span>
                              </span>
                            </span>
                          </Button>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              alignSelf:
                                view === "grid" ? "stretch" : undefined,
                              justifyContent:
                                view === "grid" ? "flex-end" : undefined,
                            }}
                          >
                            {onShowConversation && (
                              <Button
                                type="text"
                                disabled={opening}
                                aria-label={`Show conversation for ${result.hit.artifact_title} from ${result.agent.name}`}
                                onClick={() => void openResult(result, true)}
                                icon={<Icon name="comment" />}
                              />
                            )}
                            <Button
                              type="text"
                              aria-label={`${pins.pins.includes(identity(result)) ? "Unpin" : "Pin"} ${result.hit.artifact_title}`}
                              aria-pressed={pins.pins.includes(
                                identity(result),
                              )}
                              onClick={() =>
                                pins.setPinned(
                                  identity(result),
                                  !pins.pins.includes(identity(result)),
                                )
                              }
                              icon={
                                <Icon
                                  name={
                                    pins.pins.includes(identity(result))
                                      ? "pushpin-filled"
                                      : "pushpin"
                                  }
                                />
                              }
                            />
                            {reorder && (
                              <PinOrderMenu
                                title={result.hit.artifact_title ?? "artifact"}
                                index={pinnedIndex}
                                count={visiblePins.length}
                                onMove={(index) =>
                                  pins.move(visiblePins, id, index)
                                }
                              />
                            )}
                            <Dropdown
                              trigger={["click"]}
                              menu={{
                                items: [
                                  {
                                    key: "appearance",
                                    label: "Edit appearance",
                                  },
                                ],
                                onClick: () => {
                                  if (!result.hit.artifact_id) return;
                                  setAppearanceTarget({
                                    projectId: result.agent.endpoint.project_id,
                                    path: result.agent.path,
                                    threadId: result.threadId,
                                    artifactId: result.hit.artifact_id,
                                  });
                                },
                              }}
                            >
                              <Button
                                type="text"
                                aria-label={`More options for ${result.hit.artifact_title}`}
                                icon={<Icon name="ellipsis" />}
                              />
                            </Dropdown>
                          </div>
                        </div>
                      );
                      return reorder && view === "list" ? (
                        <SortableItem key={id} id={id} hideActive={false}>
                          {row}
                        </SortableItem>
                      ) : (
                        row
                      );
                    })}
                  </SortableList>
                </div>
              </section>
            );
          })}
        </div>
        {ordered.length > 200 && (
          <p role="status">
            Showing the first 200 of {ordered.length} matches. Narrow the search
            or project filter to see other cached artifacts.
          </p>
        )}
        {appearanceTarget && (
          <Suspense
            fallback={<div role="status">Loading appearance editor...</div>}
          >
            <LibraryAppearanceEditor
              target={appearanceTarget}
              onClose={() => setAppearanceTarget(undefined)}
            />
          </Suspense>
        )}
      </KeyboardBoundary>
    </div>
  );
}

function PinOrderMenu({
  title,
  index,
  count,
  onMove,
}: {
  title: string;
  index: number;
  count: number;
  onMove: (index: number) => void;
}) {
  const button = useRef<ComponentRef<typeof Button>>(null);
  return (
    <Dropdown
      trigger={["click"]}
      getPopupContainer={(trigger) => trigger.parentElement!}
      autoFocus
      onOpenChange={(open) => {
        if (!open) button.current?.focus();
      }}
      menu={{
        items: [
          { key: "up", label: "Move up", disabled: index === 0 },
          { key: "down", label: "Move down", disabled: index === count - 1 },
        ],
        onClick: ({ key }) => {
          onMove(index + (key === "up" ? -1 : 1));
          button.current?.focus();
        },
      }}
    >
      <Button
        ref={button}
        type="text"
        aria-label={`Reorder ${title}`}
        icon={<Icon name="ellipsis" />}
      />
    </Dropdown>
  );
}
