import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button, Empty, Input, Modal, Select, Space } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { agentSearchStore } from "./search-state";
import { boundedProjectSearch, type AgentSearchHit } from "./search-runner";
import { useArtifactPins } from "@cocalc/frontend/chat/use-artifact-pins";

interface Cursor {
  agent: NamedAgent;
  offset: number;
}
const identity = ({ agent, hit }: AgentSearchHit) =>
  JSON.stringify([
    agent.endpoint.project_id,
    agent.path,
    agent.thread_id,
    hit.artifact_id,
  ]);

export function AgentArtifactBrowser({
  accountId,
  agents,
  active,
  onSelect,
}: {
  accountId: string;
  agents: NamedAgent[];
  active: boolean;
  onSelect: (hit: AgentSearchHit) => Promise<void>;
}) {
  const store = agentSearchStore(accountId);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const open = !!state.artifactsOpen && active;
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string>();
  const [sort, setSort] = useState("recent");
  const [results, setResults] = useState<AgentSearchHit[]>([]);
  const [pending, setPending] = useState<Cursor[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [searched, setSearched] = useState("");
  const generation = useRef(0);
  const busyRef = useRef(false);
  const pins = useArtifactPins();
  const projects = [
    ...new Set(agents.map((agent) => agent.endpoint.project_id)),
  ];
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (open) void search(false);
    else generation.current++;
  }, [open]);

  async function search(more: boolean) {
    if (busyRef.current) return;
    const run = ++generation.current;
    const canceled = () => run !== generation.current;
    busyRef.current = true;
    setBusy(true);
    const needle = more ? searched : query.trim();
    const queue = more
      ? [...pending]
      : agents
          .filter((agent) => !project || agent.endpoint.project_id === project)
          .map((agent) => ({ agent, offset: 0 }));
    const found = more ? [...results] : [];
    const failures = more ? [...errors] : [];
    if (!more) {
      setResults([]);
      setErrors([]);
      setSearched(needle);
    }
    const deadline = Date.now() + 20_000;
    let requests = 0;
    try {
      while (
        queue.length &&
        requests++ < 20 &&
        Date.now() < deadline &&
        !canceled() &&
        found.length < 500
      ) {
        const cursor = queue[0];
        const { agent, offset } = cursor;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            boundedProjectSearch(agent.endpoint.project_id, () =>
              webapp_client.conat_client.hub.projects.chatStoreSearch({
                project_id: agent.endpoint.project_id,
                chat_path: agent.path,
                thread_id: agent.thread_id,
                artifacts: true,
                query: needle,
                limit: Math.min(25, 500 - found.length),
                offset,
              }),
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    Error("Project search timed out; results are incomplete"),
                  ),
                Math.min(8000, Math.max(1, deadline - Date.now())),
              );
            }),
          ]);
          if (canceled()) return;
          if (!response.includes_artifacts)
            throw Error("Project host needs an update for artifact discovery");
          for (const hit of response.hits) {
            if (!hit.artifact_id || hit.thread_id !== agent.thread_id) continue;
            const result = {
              agent,
              threadId: agent.thread_id,
              historical: false,
              hit,
            };
            if (!found.some((row) => identity(row) === identity(result)))
              found.push(result);
          }
          queue.shift();
          if (response.next_offset !== undefined)
            queue.unshift({ agent, offset: response.next_offset });
        } catch (err) {
          if (canceled()) return;
          queue.shift();
          failures.push(`@${agent.name}: ${err}`);
          // Leave other sources for explicit continuation, rather than repeatedly
          // probing while an outstanding request still occupies the shared slot.
          break;
        } finally {
          clearTimeout(timer);
        }
        setResults([...found]);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (!canceled()) {
        setResults(found);
        setPending(queue);
        setErrors(failures);
      }
    }
  }

  const ordered = [...results].sort((a, b) => {
    const ai = pins.pins.indexOf(identity(a)),
      bi = pins.pins.indexOf(identity(b));
    if (ai >= 0 || bi >= 0) return ai < 0 ? 1 : bi < 0 ? -1 : ai - bi;
    return sort === "title"
      ? (a.hit.artifact_title ?? "").localeCompare(b.hit.artifact_title ?? "")
      : (b.hit.date_ms ?? 0) - (a.hit.date_ms ?? 0);
  });
  return (
    <Modal
      open={open}
      title="Artifacts across all agents"
      footer={null}
      width={760}
      onCancel={() => {
        generation.current++;
        store.set({ artifactsOpen: false });
      }}
    >
      <KeyboardBoundary boundary="all-agent-artifacts">
        <Input.Search
          autoFocus
          aria-label="Search all agent artifacts"
          placeholder="Search titles, text, paths, commits..."
          maxLength={256}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={() => void search(false)}
          loading={busy}
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
          <Button disabled={busy} onClick={() => void search(false)}>
            Refresh
          </Button>
        </Space>
        <p style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
          Saved artifacts in current agent conversations. Pinned results appear
          first. Searches run in bounded batches without opening chats. Sorting
          and pins apply to discovered results only. Opening a result switches
          to its source agent's Workbench.
        </p>
        <div role="status">
          {results.length} artifacts found{searched ? ` for “${searched}”` : ""}
          . {busy ? "Searching…" : `${pending.length} source pages remaining.`}
        </div>
        {!!errors.length && (
          <Alert
            type="warning"
            title="Partial results: some sources could not be searched"
            description={
              <div style={{ maxHeight: 100, overflow: "auto" }}>
                {errors.map((error, i) => (
                  <div key={i}>{error}</div>
                ))}
              </div>
            }
          />
        )}
        {pins.error && <div role="alert">{pins.error}</div>}
        <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
          {!busy && !results.length && (
            <Empty description="No artifacts found in successfully searched sources" />
          )}
          {ordered.map((result) => (
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
                  try {
                    await onSelect(result);
                    store.set({ artifactsOpen: false });
                  } catch (err) {
                    setErrors((errors) => [...errors, `${err}`]);
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
        {!!pending.length && (
          <Button
            disabled={busy || results.length >= 500}
            onClick={() => void search(true)}
          >
            Search more agents / artifacts
          </Button>
        )}
        {results.length >= 500 && (
          <p>Result limit reached. Narrow the query or select a project.</p>
        )}
      </KeyboardBoundary>
    </Modal>
  );
}
