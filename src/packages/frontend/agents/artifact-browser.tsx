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
import { Alert, Button, Checkbox, Empty, Input, Select } from "antd";
import type { InputRef } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { Icon, isIconName } from "@cocalc/frontend/components";
import { blobImageUrl } from "@cocalc/frontend/components/theme-image-url";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { AgentSearchHit } from "./search-runner";
import { useArtifactPins } from "@cocalc/frontend/chat/use-artifact-pins";
import { useArtifactNames } from "./artifact-names";
import { librarySearchRequest } from "@cocalc/frontend/app/sidebar-search-requests";
import {
  Collection,
  type CollectionControls,
} from "@cocalc/frontend/components/collection";
import {
  sharedArtifactCatalog,
  artifactIdentity as identity,
  catalogResults,
  CATALOG_LIMITS,
} from "./artifact-catalog-store";

const LibraryAppearanceEditor = lazy(() =>
  import("./library-appearance-editor").then(({ LibraryAppearanceEditor }) => ({
    default: LibraryAppearanceEditor,
  })),
);

const viewStorageKey = (accountId: string) =>
  `cocalc:agent-library:view:${accountId}`;

function initialView(accountId: string): "list" | "grid" {
  try {
    return localStorage.getItem(viewStorageKey(accountId)) === "grid"
      ? "grid"
      : "list";
  } catch {
    return "list";
  }
}

interface Props {
  accountId: string;
  agents: NamedAgent[];
  active: boolean;
  activeAgent?: NamedAgent;
  onSelect: (hit: AgentSearchHit) => Promise<void>;
  onShowConversation?: (hit: AgentSearchHit) => Promise<void>;
  onClose?: () => void;
  navigation?: ReactNode;
  onNewArtifact?: () => void;
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
  onNewArtifact,
  selectedArtifactIdentity,
}: Props) {
  const [query, setQuery] = useState("");
  // Another page asked to open the Library on a search (e.g. an agent's name).
  const requestedQuery = useTypedRedux("page", "library_query");
  useEffect(() => {
    if (requestedQuery == null) return;
    setQuery(requestedQuery);
    redux.getActions("page").setState({ library_query: undefined });
  }, [requestedQuery]);
  const [project, setProject] = useState<string>();
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"list" | "grid">(() =>
    initialView(accountId),
  );
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
  // "Search Library" in the sidebar.
  useEffect(
    () => librarySearchRequest.on(() => searchRef.current?.focus()),
    [],
  );
  const [catalog] = useState(() =>
    sharedArtifactCatalog(accountId, (opts) =>
      webapp_client.conat_client.hub.artifactCatalog.listProject(opts),
    ),
  );
  const metadata = useSyncExternalStore(catalog.subscribe, catalog.get);
  const [openError, setOpenError] = useState("");
  const [appearanceTarget, setAppearanceTarget] = useState<
    ForeignArtifactTarget & { entryId: string }
  >();
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(viewStorageKey(accountId), view);
    } catch {
      // The in-memory view still works if storage is unavailable.
    }
  }, [accountId, view]);
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
    // Pins have their own section; the sort orders everything else.
    pins: [],
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
  const shown = ordered.slice(0, 200);
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
  function renderRow(result: AgentSearchHit, controls: CollectionControls) {
    const id = identity(result);
    const alias = artifactNames.find(
      (item) =>
        item.active &&
        item.project_id === result.agent.endpoint.project_id &&
        item.entry_id === result.catalogEntryId,
    )?.name;
    const appearance = catalogById.get(
      `${result.agent.endpoint.project_id}/${result.catalogEntryId}`,
    )?.item.appearance;
    const menu = controls.menu(
      [
        {
          key: "appearance",
          label: "Edit appearance",
          onClick: () => {
            if (!result.hit.artifact_id || !result.catalogEntryId) return;
            setAppearanceTarget({
              projectId: result.agent.endpoint.project_id,
              path: result.agent.path,
              threadId: result.threadId,
              artifactId: result.hit.artifact_id,
              entryId: result.catalogEntryId,
            });
          },
        },
      ],
      `More options for ${result.hit.artifact_title}`,
    );
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: view === "grid" ? 4 : 8,
          flexDirection: view === "grid" ? "column" : "row",
          // Fixed card height so the grid lines up, as in People.
          height: view === "grid" ? 150 : undefined,
          boxSizing: "border-box",
          overflow: "hidden",
          padding: 8,
          border:
            view === "grid"
              ? `1px solid ${appearance?.color ?? UI_COLORS.border}`
              : undefined,
          borderBottom:
            view === "grid" ? undefined : `1px solid ${UI_COLORS.border}`,
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
            justifyContent: view === "grid" ? "center" : "flex-start",
            textAlign: view === "grid" ? "center" : "left",
          }}
          onClick={() => void openResult(result)}
        >
          <span
            style={{
              minWidth: 0,
              width: view === "grid" ? "100%" : undefined,
              overflow: "hidden",
              overflowWrap: view === "grid" ? "normal" : "anywhere",
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
                  width: view === "grid" ? 24 : 36,
                  height: view === "grid" ? 24 : 36,
                  objectFit: "cover",
                  borderRadius: 6,
                  margin: view === "grid" ? "0 auto 4px" : undefined,
                  flexShrink: 0,
                }}
              />
            ) : (
              <Icon
                name={isIconName(appearance?.icon) ? appearance.icon : "file"}
                style={{
                  display: "block",
                  fontSize: view === "grid" ? 24 : 28,
                  marginBottom: view === "grid" ? 4 : undefined,
                  color: appearance?.color ?? UI_COLORS.text,
                  flexShrink: 0,
                }}
              />
            )}
            <span style={{ minWidth: 0 }}>
              <strong
                style={{
                  display: view === "grid" ? "-webkit-box" : "block",
                  WebkitBoxOrient: view === "grid" ? "vertical" : undefined,
                  WebkitLineClamp: view === "grid" ? 2 : undefined,
                  overflow: view === "grid" ? "hidden" : undefined,
                  lineHeight: 1.3,
                }}
                title={result.hit.artifact_title}
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
                  display: "block",
                  overflow: view === "grid" ? "hidden" : undefined,
                  textOverflow: view === "grid" ? "ellipsis" : undefined,
                  whiteSpace: view === "grid" ? "nowrap" : undefined,
                }}
                title={`${projectTitle(result.agent.endpoint.project_id)} · @${result.agent.name} · ${result.hit.artifact_kind}`}
              >
                {projectTitle(result.agent.endpoint.project_id)} · @
                {result.agent.name} · {result.hit.artifact_kind}
              </span>
            </span>
          </span>
        </Button>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            alignSelf: view === "grid" ? "stretch" : undefined,
            justifyContent: view === "grid" ? "flex-end" : undefined,
          }}
        >
          {/* Same width with or without a handle, so columns line up. */}
          <span style={{ width: 28, display: "inline-flex" }}>
            {controls.dragHandle}
          </span>
          {onShowConversation && (
            <Button
              type="text"
              disabled={opening}
              aria-label={`Show conversation for ${result.hit.artifact_title} from ${result.agent.name}`}
              onClick={() => void openResult(result, true)}
              icon={<Icon name="comment" />}
            />
          )}
          {controls.pinButton}
          {menu}
        </div>
      </div>
    );
  }
  // Retain the DOM as well as the catalog, including disclosure and row state.
  return (
    <div
      ref={viewportRef}
      hidden={!active}
      role="region"
      aria-label="Artifacts page"
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
            Artifacts
          </h1>
          {onNewArtifact && (
            <Button icon={<Icon name="plus" />} onClick={onNewArtifact}>
              New artifact
            </Button>
          )}
          <div
            role="group"
            aria-label="Artifacts view"
            style={{ display: "flex", gap: 4 }}
          >
            <Button
              type={view === "grid" ? "primary" : "text"}
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              icon={<Icon name="overview" />}
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
            aria-label="Search artifacts"
            placeholder="Search artifacts"
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
                  : " · Loading artifacts..."
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
              Pinned artifacts have their own section at the top. Drag them, or
              focus a handle and use Space and the arrow keys, to reorder.
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
            title="Artifact metadata unavailable"
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
          <Collection<AgentSearchHit>
            items={shown}
            itemId={identity}
            itemTitle={(result) => result.hit.artifact_title ?? "artifact"}
            pins={pins.pins}
            view={view}
            otherTitle="Artifacts"
            group={
              groupByProject
                ? (result) => result.agent.endpoint.project_id
                : undefined
            }
            groupTitle={projectTitle}
            onPin={(result, pinned) => pins.setPinned(identity(result), pinned)}
            onMove={pins.move}
            renderItem={renderRow}
          />
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
              onSaved={(theme, artifactTitle) =>
                catalog.updateAppearance(
                  appearanceTarget.projectId,
                  appearanceTarget.entryId,
                  {
                    title: theme.title || artifactTitle,
                    description: theme.description,
                    appearance: {
                      ...(theme.color ? { color: theme.color } : {}),
                      ...(theme.accent_color
                        ? { accent_color: theme.accent_color }
                        : {}),
                      ...(theme.icon ? { icon: theme.icon } : {}),
                      ...(theme.image_blob
                        ? { image_blob: theme.image_blob }
                        : {}),
                    },
                  },
                )
              }
            />
          </Suspense>
        )}
      </KeyboardBoundary>
    </div>
  );
}
