import { useDeferredValue, useLayoutEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import type { ComponentRef } from "react";
import { Button, Empty, Input, Modal, Select, Space, message } from "antd";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ChatActions } from "./actions";
import { artifactCatalog, filterArtifacts } from "./artifact-catalog";
import type { ArtifactCatalogEntry } from "./artifact-catalog";
import { ArtifactCard } from "./artifact-card";
import { artifactSyncdbReady, useArtifactChanges } from "./artifacts";
import { openArtifact } from "./open-artifact";
import { dateValue } from "./access";
import { Icon } from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { useArtifactPins } from "./use-artifact-pins";
import { useChatEmbeddingOptions } from "./embedding-options";

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
  organization,
}: {
  actions: ChatActions;
  query?: string;
  threadId?: string;
  kind?: string;
  sort?: "published" | "created" | "title";
  onOpen?: () => void;
  organization?: ReturnType<typeof useArtifactPins>;
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
  const entryId = (entry: ArtifactCatalogEntry) =>
    JSON.stringify([
      actions.store?.get("project_id"),
      actions.store?.get("path"),
      entry.publication.thread_id,
      entry.publication.artifact_id,
    ]);
  const pins = organization?.pins ?? [];
  const focusPin = useRef<string | undefined>(undefined);
  const pinButtons = useRef(new Map<string, ComponentRef<typeof Button>>());
  useLayoutEffect(() => {
    if (focusPin.current) {
      pinButtons.current.get(focusPin.current)?.focus();
      focusPin.current = undefined;
    }
  });
  const pinned = entries
    .filter((entry) => pins.includes(entryId(entry)))
    .sort((a, b) => pins.indexOf(entryId(a)) - pins.indexOf(entryId(b)));
  const unpinned = entries.filter((entry) => !pins.includes(entryId(entry)));
  const visiblePins = pinned.map(entryId);
  function renderEntry(entry: ArtifactCatalogEntry, pinnedIndex = -1) {
    const id = entryId(entry);
    const canOpen = !!actions.frameTreeActions && !!actions.frameId;
    return (
      <div key={id} style={{ marginBottom: 2 }}>
        <ArtifactCard
          compact
          leading={
            organization?.canPin &&
            (pinnedIndex >= 0 ? (
              <DragHandle
                id={id}
                ariaLabel={`Drag ${entry.title} to reorder`}
                style={{ padding: "4px 2px" }}
              />
            ) : (
              <span style={{ display: "inline-block", width: 18 }} />
            ))
          }
          trailing={
            organization?.canPin && (
              <Button
                ref={(button) => {
                  if (button) pinButtons.current.set(id, button);
                  else pinButtons.current.delete(id);
                }}
                size="small"
                type="text"
                style={{
                  color:
                    pinnedIndex >= 0 ? UI_COLORS.link : UI_COLORS.secondary,
                }}
                aria-label={`${pinnedIndex >= 0 ? "Unpin" : "Pin"} ${entry.title}`}
                onClick={() => {
                  focusPin.current = id;
                  organization.setPinned(id, pinnedIndex < 0);
                }}
                icon={
                  <Icon
                    name={pinnedIndex >= 0 ? "pushpin-filled" : "pushpin"}
                  />
                }
              />
            )
          }
          reorder={
            organization?.canPin && pinnedIndex >= 0
              ? {
                  up:
                    pinnedIndex > 0
                      ? () =>
                          organization.move(visiblePins, id, pinnedIndex - 1)
                      : undefined,
                  down:
                    pinnedIndex < pinned.length - 1
                      ? () =>
                          organization.move(visiblePins, id, pinnedIndex + 1)
                      : undefined,
                }
              : undefined
          }
          publication={entry.publication}
          current={entry.current}
          syncdb={actions.syncdb}
          projectId={actions.store?.get("project_id")}
          open={
            canOpen
              ? (version) => {
                  openArtifact(
                    actions,
                    entry.publication,
                    version ??
                      (entry.current
                        ? undefined
                        : entry.publication.operation_id),
                  );
                  onOpen?.();
                }
              : undefined
          }
          showInConversation={async () => {
            if (await showConversation(actions, entry)) onOpen?.();
          }}
        />
      </div>
    );
  }
  if (!artifactSyncdbReady(actions.syncdb))
    return <div role="status">Loading artifacts...</div>;
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
      {!!pinned.length && (
        <section aria-label="Pinned artifacts">
          <h4
            style={{
              margin: "8px 0 4px",
              fontSize: 13,
              fontWeight: 400,
              color: UI_COLORS.secondary,
            }}
          >
            Pinned
          </h4>
          <SortableList
            items={visiblePins}
            onDragStop={(_from, to, id) => {
              if (typeof id === "string")
                organization?.move(visiblePins, id, to);
            }}
          >
            {pinned.map((entry, index) => (
              <SortableItem
                key={entryId(entry)}
                id={entryId(entry)}
                hideActive={false}
              >
                {renderEntry(entry, index)}
              </SortableItem>
            ))}
          </SortableList>
        </section>
      )}
      {!!pinned.length && !!unpinned.length && (
        <h4
          style={{
            margin: "8px 0 4px",
            fontSize: 13,
            fontWeight: 400,
            color: UI_COLORS.secondary,
          }}
        >
          Other artifacts
        </h4>
      )}
      {unpinned.slice(0, limit).map((entry) => renderEntry(entry))}
      {unpinned.length > limit && (
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
  const { agentWorkspace = false, onBrowseAllArtifacts } =
    useChatEmbeddingOptions();
  const organization = useArtifactPins();
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
            style={{ width: 170 }}
            value={agentWorkspace ? "thread" : scope}
            disabled={agentWorkspace && !onBrowseAllArtifacts}
            onChange={(value) => {
              if (value === "agents") {
                onClose();
                onBrowseAllArtifacts?.();
              } else setScope(value);
            }}
            options={
              agentWorkspace
                ? [
                    { value: "thread", label: "This agent" },
                    ...(onBrowseAllArtifacts
                      ? [{ value: "agents", label: "All agents" }]
                      : []),
                  ]
                : [
                    ...(threadId
                      ? [{ value: "thread", label: "This thread" }]
                      : []),
                    { value: "room", label: "Entire chatroom" },
                  ]
            }
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
            style={{ width: 180 }}
            value={sort}
            onChange={setSort}
            options={[
              { value: "published", label: "Recently added" },
              { value: "created", label: "Recently created" },
              { value: "title", label: "Title" },
            ]}
          />
        </Space>
        {organization.error && <div role="alert">{organization.error}</div>}
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {agentWorkspace && !threadId ? (
            <div role="status">Select an agent to browse its artifacts.</div>
          ) : (
            <ArtifactResults
              actions={actions}
              query={query}
              threadId={
                agentWorkspace || scope === "thread" ? threadId : undefined
              }
              kind={kind}
              sort={sort}
              onOpen={onClose}
              organization={organization}
            />
          )}
        </div>
      </KeyboardBoundary>
    </Modal>
  );
}
