import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Button, Empty, Input, Modal, Select, Space } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { agentSearchStore } from "./search-state";
import type { AgentSearchHit } from "./search-runner";
import { useArtifactPins } from "@cocalc/frontend/chat/use-artifact-pins";
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
  onSelect: (hit: AgentSearchHit) => Promise<void>;
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
}: Props) {
  const store = agentSearchStore(accountId);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const open = !!state.artifactsOpen && active;
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string>();
  const [sort, setSort] = useState("recent");
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
    pins: pins.pins,
  });
  return (
    <Modal
      open={open}
      title="Artifacts across all agents"
      footer={null}
      width={760}
      onCancel={() => {
        store.set({ artifactsOpen: false });
      }}
    >
      <KeyboardBoundary boundary="all-agent-artifacts">
        <Input.Search
          autoFocus
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
              label:
                agents.find((a) => a.endpoint.project_id === value)
                  ?.project_title || value,
            }))}
          />
          <Select
            aria-label="Sort discovered artifacts"
            style={{ width: 180 }}
            value={sort}
            onChange={setSort}
            options={[
              { value: "recent", label: "Recently added" },
              { value: "title", label: "Title" },
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
          Saved artifacts from current agent conversations. Updates refresh in
          the background; some sources may still be indexing.
          <br />
          Opening an artifact switches to its source agent's Workbench.
        </p>
        <div role="status">
          {ordered.length} artifacts{metadata.loading ? " · Refreshing..." : ""}
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
        <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
          {!metadata.loading && !ordered.length && (
            <Empty description="No matching cached artifacts. Sources may not be indexed yet." />
          )}
          {ordered.slice(0, 200).map((result) => (
            <div
              key={identity(result)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
              }}
            >
              <Button
                type="text"
                disabled={opening}
                aria-label={`Open ${result.hit.artifact_title} from ${result.agent.name}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "auto",
                  justifyContent: "flex-start",
                  textAlign: "left",
                }}
                onClick={async () => {
                  setOpening(true);
                  setOpenError("");
                  try {
                    await onSelect(result);
                    store.set({ artifactsOpen: false });
                  } catch (err) {
                    setOpenError(`${err}`);
                  } finally {
                    setOpening(false);
                  }
                }}
              >
                <span style={{ minWidth: 0, overflow: "hidden" }}>
                  <strong
                    style={{
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {result.hit.artifact_title}
                  </strong>
                  <span style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
                    @{result.agent.name} · {result.hit.artifact_kind}
                  </span>
                </span>
              </Button>
              <Button
                type="text"
                aria-label={`${pins.pins.includes(identity(result)) ? "Unpin" : "Pin"} ${result.hit.artifact_title}`}
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
            </div>
          ))}
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
            starting projects. Only known current agent threads are shown.
            Pinned artifacts appear first.
          </p>
          <p>
            {metadata.indexedSources} successfully indexed sources reported;
            this is not a completeness count. {metadata.checkedProjects} project
            listings read to the end. Coverage may still be partial.
          </p>
          <p>
            Preview limits: {CATALOG_LIMITS.projects} projects,{" "}
            {CATALOG_LIMITS.pages} pages, {CATALOG_LIMITS.entries} entries and
            approximately 16 MiB of metadata per refresh. Search, project
            filters and sorting use cached metadata only; they do not fetch
            beyond these limits.
          </p>
        </details>
      </KeyboardBoundary>
    </Modal>
  );
}
