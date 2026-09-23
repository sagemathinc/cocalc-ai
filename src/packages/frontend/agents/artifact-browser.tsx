import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentRef } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Select,
  Space,
} from "antd";
import type { InputRef } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { AgentSearchHit } from "./search-runner";
import { useArtifactPins } from "@cocalc/frontend/chat/use-artifact-pins";
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

interface Props {
  accountId: string;
  agents: NamedAgent[];
  active: boolean;
  activeAgent?: NamedAgent;
  onSelect: (hit: AgentSearchHit) => Promise<void>;
  onShowConversation?: (hit: AgentSearchHit) => Promise<void>;
  onClose?: () => void;
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
}: Props) {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string>();
  const [sort, setSort] = useState("recent");
  const [groupByProject, setGroupByProject] = useState(false);
  const searchRef = useRef<InputRef>(null);
  useEffect(() => {
    if (active) searchRef.current?.focus();
  }, [active]);
  const [catalog] = useState(
    () =>
      new ArtifactCatalogStore(accountId, (opts) =>
        webapp_client.conat_client.hub.artifactCatalog.listProject(opts),
      ),
  );
  const metadata = useSyncExternalStore(catalog.subscribe, catalog.get);
  const [openError, setOpenError] = useState("");
  const [opening, setOpening] = useState(false);
  const pins = useArtifactPins();
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
  });
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
  // Keep hooks and the catalog alive even while another page is visible.
  if (!active) return null;
  return (
    <KeyboardBoundary
      boundary="agent-library"
      role="region"
      aria-label="Library"
      style={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        flex: 1,
        overflowY: "auto",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        {onClose && <Button onClick={onClose}>Back to agent</Button>}
        <h1 style={{ margin: 0, fontSize: 24 }}>Library</h1>
      </Space>
      <Input.Search
        ref={searchRef}
        aria-label="Search all agent artifacts"
        placeholder="Filter cached titles, descriptions, paths, commits..."
        maxLength={256}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Space wrap style={{ margin: "12px 0" }}>
        <Select
          aria-label="Filter artifact projects"
          placeholder="All projects"
          allowClear
          value={project}
          onChange={setProject}
          style={{ width: 220 }}
          options={projects.map((value) => ({
            value,
            label: projectTitle(value),
          }))}
        />
        <Checkbox
          checked={groupByProject}
          onChange={(e) => setGroupByProject(e.target.checked)}
        >
          Group by project
        </Checkbox>
        <Select
          aria-label="Sort discovered artifacts"
          style={{ width: 180 }}
          value={sort}
          onChange={setSort}
          options={[
            { value: "recent", label: "Recent" },
            { value: "title", label: "Title" },
            { value: "custom", label: "Custom" },
          ]}
        />
        <Button
          disabled={metadata.loading}
          onClick={() => void catalog.refresh()}
        >
          Refresh
        </Button>
      </Space>
      <p style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
        Saved artifacts from current agent conversations. Updates refresh in the
        background; some sources may still be indexing.
      </p>
      <div role="status">
        {ordered.length} artifacts
        {metadata.loading ? " · Refreshing..." : ""}
        {metadata.limited &&
          " · Local preview limit reached; some metadata is not cached."}
      </div>
      {metadata.error && (
        <Alert
          type="warning"
          title="Metadata preview unavailable"
          description={metadata.error}
        />
      )}
      {pins.error && <div role="alert">{pins.error}</div>}
      {openError && <div role="alert">{openError}</div>}
      <div>
        {!metadata.loading && !ordered.length && (
          <Empty description="No matching cached artifacts. Sources may not be indexed yet." />
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
              <div role="list">
                <SortableList
                  items={visiblePins}
                  disabled={sort !== "custom"}
                  onDragStop={(_from, to, id) => {
                    if (typeof id === "string") pins.move(visiblePins, id, to);
                  }}
                >
                  {results.map((result) => {
                    const id = identity(result);
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
                          flexWrap: "wrap",
                          padding: "6px 0",
                        }}
                      >
                        {reorder && (
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
                          style={{
                            flex: 1,
                            minWidth: 0,
                            height: "auto",
                            whiteSpace: "normal",
                            justifyContent: "flex-start",
                            textAlign: "left",
                          }}
                          onClick={() => void openResult(result)}
                        >
                          <span
                            style={{ minWidth: 0, overflowWrap: "anywhere" }}
                          >
                            <strong
                              style={{
                                display: "block",
                              }}
                            >
                              {result.hit.artifact_title}
                            </strong>
                            <span
                              style={{
                                color: UI_COLORS.secondary,
                                fontSize: 12,
                              }}
                            >
                              {projectTitle(result.agent.endpoint.project_id)} ·
                              @{result.agent.name} · {result.hit.artifact_kind}
                            </span>
                          </span>
                        </Button>
                        {onShowConversation && (
                          <Button
                            type="text"
                            disabled={opening}
                            aria-label={`Show conversation for ${result.hit.artifact_title} from ${result.agent.name}`}
                            onClick={() => void openResult(result, true)}
                          >
                            Show conversation
                          </Button>
                        )}
                        <Button
                          type="text"
                          aria-label={`${pins.pins.includes(identity(result)) ? "Unpin" : "Pin"} ${result.hit.artifact_title}`}
                          aria-pressed={pins.pins.includes(identity(result))}
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
                      </div>
                    );
                    return reorder ? (
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
      <details style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
        <summary>Preview details</summary>
        <p>
          Background-refreshed metadata preview, not a live feed. Refreshes
          about every 10 seconds while mounted, without scanning files or
          starting projects. Only known current agent threads are shown. Pinned
          artifacts appear first in Custom order. Drag pinned artifacts or use
          their Move up/down menu to reorder within the current project group
          and filters. Other artifacts follow in recent order.
        </p>
        <p>
          {metadata.indexedSources} successfully indexed sources reported; this
          is not a completeness count. {metadata.checkedProjects} project
          listings read to the end. Coverage may still be partial.
        </p>
        <p>
          Preview limits: {CATALOG_LIMITS.projects} projects,{" "}
          {CATALOG_LIMITS.pages} pages, {CATALOG_LIMITS.entries} entries and
          approximately 16 MiB of metadata per refresh. Search, project filters
          and sorting use cached metadata only; they do not fetch beyond these
          limits.
        </p>
      </details>
    </KeyboardBoundary>
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
