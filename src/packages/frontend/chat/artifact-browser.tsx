import { useDeferredValue, useRef, useState } from "react";
import type { InputRef } from "antd";
import { Button, Empty, Input, Modal, Select, Space, Tag, message } from "antd";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ChatActions } from "./actions";
import { artifactCatalog, filterArtifacts } from "./artifact-catalog";
import type { ArtifactCatalogEntry } from "./artifact-catalog";
import { ArtifactIdentity } from "./artifact-card";
import { artifactSyncdbReady, useArtifactChanges } from "./artifacts";
import { openArtifact } from "./open-artifact";
import { dateValue } from "./access";

async function showConversation(
  actions: ChatActions,
  entry: ArtifactCatalogEntry,
) {
  const { thread_id, message_id } = entry.publication;
  try {
    const producing = actions
      .getMessagesInThread(thread_id)
      ?.find((row) => row.message_id === message_id);
    let date = dateValue(producing)?.valueOf();
    if (date === undefined) {
      const project_id = actions.store?.get("project_id");
      const chat_path = actions.store?.get("path");
      if (!project_id || !chat_path) throw Error("Chat location unavailable.");
      const { webapp_client } = await import("@cocalc/frontend/webapp-client");
      const result =
        await webapp_client.conat_client.hub.projects.chatStoreReadArchivedHit({
          project_id,
          chat_path,
          thread_id,
          message_id,
        });
      if (result?.row?.row) actions.hydrateArchivedRows([result.row.row]);
      date =
        result?.row?.date_ms == null ? undefined : Number(result.row.date_ms);
    }
    if (!Number.isFinite(date))
      throw Error("The producing message is no longer available.");
    await actions.frameTreeActions?.gotoFragment({
      chat: `${date}`,
      thread: thread_id,
    });
    return true;
  } catch (err) {
    message.error(`${err}`);
    return false;
  }
}

const kinds = ["markdown", "file", "actions", "github-pr", "commit"];

export function ArtifactResults({
  actions,
  query = "",
  threadId,
  kind,
  sort = "published",
  onOpen,
}: {
  actions: ChatActions;
  query?: string;
  threadId?: string;
  kind?: string;
  sort?: "published" | "created" | "title";
  onOpen?: () => void;
}) {
  useArtifactChanges(actions.syncdb);
  const [limit, setLimit] = useState(50);
  const deferredQuery = useDeferredValue(query);
  const entries = filterArtifacts(artifactCatalog(actions.syncdb), {
    query: deferredQuery,
    threadId,
    kind,
    sort,
  });
  if (!artifactSyncdbReady(actions.syncdb))
    return <div role="status">Loading artifacts...</div>;
  const threadNames = new Map<string, string>();
  for (const row of actions.listThreadConfigRows?.() ?? []) {
    const config = row?.toJS?.() ?? row;
    if (config?.name) threadNames.set(config.thread_id, config.name);
  }
  return (
    <section aria-label="Artifact results">
      <div
        role="status"
        style={{ color: UI_COLORS.secondary, marginBottom: 8 }}
      >
        {entries.length} artifacts
      </div>
      {!entries.length && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No matching artifacts"
        />
      )}
      {entries.slice(0, limit).map((entry) => {
        const data = entry.current ?? entry.publication.snapshot;
        return (
          <article
            key={`${entry.publication.thread_id}:${entry.publication.artifact_id}`}
            style={{
              padding: "12px 0",
              borderBottom: `1px solid ${UI_COLORS.border}`,
            }}
          >
            <Button
              type="text"
              aria-label={`Open artifact: ${entry.title}`}
              disabled={!actions.frameTreeActions || !actions.frameId}
              style={{
                height: "auto",
                width: "100%",
                whiteSpace: "normal",
                textAlign: "left",
                justifyContent: "start",
              }}
              onClick={() => {
                openArtifact(
                  actions,
                  entry.publication,
                  entry.current ? undefined : entry.publication.operation_id,
                );
                onOpen?.();
              }}
            >
              <ArtifactIdentity
                title={entry.title}
                theme={data.theme}
                icon={
                  data.commit || data.github_pr
                    ? "git"
                    : data.actions
                      ? "tasks"
                      : "file"
                }
              />
            </Button>
            <div
              style={{
                margin: "6px 12px",
                overflowWrap: "anywhere",
                color: UI_COLORS.secondary,
              }}
            >
              <Tag>{entry.kind}</Tag>
              {data.file?.path ?? data.theme?.description ?? data.title}
              <div>
                {entry.published
                  ? `Published ${new Date(entry.published).toLocaleString()}`
                  : "Publication date unknown"}
              </div>
              {!threadId && (
                <div>
                  Thread:{" "}
                  {threadNames.get(entry.publication.thread_id) ??
                    entry.publication.thread_id}
                </div>
              )}
            </div>
            <Button
              size="small"
              type="link"
              aria-label={`Show in conversation: ${entry.title}`}
              onClick={async () => {
                if (await showConversation(actions, entry)) onOpen?.();
              }}
            >
              Show in conversation
            </Button>
          </article>
        );
      })}
      {entries.length > limit && (
        <Button onClick={() => setLimit(limit + 50)}>
          Show more artifacts
        </Button>
      )}
    </section>
  );
}

export default function ArtifactBrowser({
  actions,
  threadId,
  onClose,
}: {
  actions: ChatActions;
  threadId?: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState(threadId ? "thread" : "room");
  const inputRef = useRef<InputRef>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>();
  const [sort, setSort] = useState<"published" | "created" | "title">(
    "published",
  );
  return (
    <Modal
      open
      title="Artifacts"
      onCancel={onClose}
      footer={null}
      width={720}
      afterOpenChange={(open) => {
        if (open) inputRef.current?.focus();
      }}
    >
      <KeyboardBoundary boundary="artifact-browser">
        <Input
          ref={inputRef}
          autoFocus
          aria-label="Filter artifacts"
          placeholder="Search titles, text, paths, commits..."
          allowClear
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Space wrap style={{ margin: "12px 0" }}>
          <Select
            aria-label="Artifact scope"
            value={scope}
            onChange={setScope}
            options={[
              ...(threadId ? [{ value: "thread", label: "This thread" }] : []),
              { value: "room", label: "Entire chatroom" },
            ]}
          />
          <Select
            aria-label="Artifact type"
            value={kind}
            onChange={setKind}
            allowClear
            placeholder="All types"
            style={{ minWidth: 130 }}
            options={kinds.map((value) => ({ value, label: value }))}
          />
          <Select
            aria-label="Sort artifacts"
            value={sort}
            onChange={setSort}
            options={[
              { value: "published", label: "Recently published" },
              { value: "created", label: "Recently created" },
              { value: "title", label: "Title" },
            ]}
          />
        </Space>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          <ArtifactResults
            actions={actions}
            query={query}
            threadId={scope === "thread" ? threadId : undefined}
            kind={kind}
            sort={sort}
            onOpen={onClose}
          />
        </div>
      </KeyboardBoundary>
    </Modal>
  );
}
