import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import type { EditorDescription } from "@cocalc/frontend/frame-editors/frame-tree/types";
import { Card, Input, Select } from "antd";
import { path_split, separate_file_extension, set } from "@cocalc/util/misc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { throttle } from "lodash";
import { TimeAgo } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import type { ChatMessages } from "@cocalc/frontend/chat/types";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import type { ChatStoreSearchHit } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  COMBINED_FEED_KEY,
  deriveThreadLabel,
} from "@cocalc/frontend/chat/threads";
import useSearchIndex from "@cocalc/frontend/frame-editors/generic/search/use-search-index";

const COMBINED_FEED_LABEL = "Combined feed";
const ALL_MESSAGES_LABEL = "All messages";
const ALL_MESSAGES_KEY = "__all_messages__";

interface MatchHit {
  id: string;
  content: string;
  source?: "live" | "archived";
}

interface ThreadOption {
  key: string;
  label: string;
  newestTime: number;
}

function asArchivedFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  return false;
}

function threadLabelFromConfigRow(row: any, newestTime: number): string {
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  if (name) return name;
  if (newestTime > 0) {
    return new Date(newestTime).toLocaleString();
  }
  return "Untitled chat";
}

export const search: EditorDescription = {
  type: "search",
  short: "Search",
  name: "Search",
  icon: "comment",
  commands: set(["decrease_font_size", "increase_font_size"]),
  component: (props) => <ChatSearch {...props} />,
} as const;

interface Props {
  font_size: number;
  desc;
}

function ChatSearch({ font_size: fontSize, desc }: Props) {
  const { actions, path, id, project_id } = useFrameContext();
  const chatActions = ((actions &&
    "getChatActions" in actions &&
    typeof (actions as any).getChatActions === "function"
    ? (actions as any).getChatActions()
    : actions) ?? undefined) as ChatActions | undefined;
  const [search, setSearch] = useState<string>(desc?.get?.("data-search") ?? "");
  const [searchInput, setSearchInput] = useState<string>(
    desc?.get?.("data-search") ?? "",
  );
  const { error, setError, index, doRefresh, fragmentKey, isIndexing } =
    useSearchIndex();
  const messageCache = chatActions?.messageCache;
  const [cacheVersion, setCacheVersion] = useState<number>(0);
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | undefined>(
    undefined,
  );
  const [result, setResult] = useState<MatchHit[]>([]);
  const [archivedResult, setArchivedResult] = useState<MatchHit[]>([]);
  const [archivedTotalCount, setArchivedTotalCount] = useState<number>(0);
  const [archivedSearchError, setArchivedSearchError] = useState<string>("");
  const [archivedSearchLoading, setArchivedSearchLoading] = useState<boolean>(false);
  const saveSearch = useMemo(
    () =>
      throttle((value) => {
        if (!actions?.isClosed?.()) {
          actions?.set_frame_data?.({ id, search: value });
        }
      }, 250),
    [actions, id],
  );
  const doRefreshRef = useRef(doRefresh);
  const refreshIndex = useMemo(
    () => throttle(() => doRefreshRef.current(), 1000),
    [],
  );

  const messages: ChatMessages | undefined = chatActions?.getAllMessages();
  const threadIndex = chatActions?.getThreadIndex?.();

  const threadOptions: ThreadOption[] = useMemo(() => {
    const archivedByThreadId = new Map<string, boolean>();
    for (const row0 of chatActions?.listThreadConfigRows?.() ?? []) {
      const row =
        row0 && typeof row0?.toJS === "function" ? row0.toJS() : row0;
      const threadId = `${row?.thread_id ?? ""}`.trim();
      if (!threadId) continue;
      archivedByThreadId.set(threadId, asArchivedFlag(row?.archived));
    }
    const byKey = new Map<string, ThreadOption>();
    for (const entry of threadIndex?.values() ?? []) {
      if (archivedByThreadId.get(entry.key) === true) continue;
      const rootMessage =
        entry.rootMessage ??
        (messages ? messages.get(entry.key) : undefined);
      byKey.set(entry.key, {
        key: entry.key,
        label: deriveThreadLabel(rootMessage, entry.key),
        newestTime: entry.newestTime,
      });
    }
    const configRows = chatActions?.listThreadConfigRows?.() ?? [];
    for (const row0 of configRows) {
      const row =
        row0 && typeof row0?.toJS === "function" ? row0.toJS() : row0;
      const threadId = `${row?.thread_id ?? ""}`.trim();
      if (
        !threadId ||
        threadId === COMBINED_FEED_KEY ||
        threadId === ALL_MESSAGES_KEY ||
        archivedByThreadId.get(threadId) === true ||
        byKey.has(threadId)
      ) {
        continue;
      }
      const whenRaw = row?.updated_at ?? row?.date;
      const when = new Date(whenRaw);
      const newestTime = Number.isFinite(when.valueOf()) ? when.valueOf() : 0;
      byKey.set(threadId, {
        key: threadId,
        label: threadLabelFromConfigRow(row, newestTime),
        newestTime,
      });
    }
    const items = Array.from(byKey.values());
    items.sort((a, b) => b.newestTime - a.newestTime);
    return items;
  }, [threadIndex, messages, chatActions]);

  useEffect(() => {
    if (!messageCache) {
      return;
    }
    const handleVersion = (version: number) => {
      setCacheVersion(version);
    };
    handleVersion(messageCache.getVersion());
    messageCache.on("version", handleVersion);
    return () => {
      messageCache.off("version", handleVersion);
    };
  }, [messageCache]);

  useEffect(() => {
    doRefreshRef.current = doRefresh;
  }, [doRefresh]);

  useEffect(() => {
    if (!search.trim()) {
      return;
    }
    refreshIndex();
  }, [search, cacheVersion, refreshIndex]);

  useEffect(() => {
    return () => {
      refreshIndex.cancel();
    };
  }, [refreshIndex]);

  useEffect(() => {
    if (!selectedThreadKey && threadOptions.length > 0) {
      setSelectedThreadKey(threadOptions[0].key);
      return;
    }
    if (
      selectedThreadKey &&
      selectedThreadKey !== COMBINED_FEED_KEY &&
      selectedThreadKey !== ALL_MESSAGES_KEY &&
      !threadOptions.some((thread) => thread.key === selectedThreadKey)
    ) {
      setSelectedThreadKey(threadOptions[0]?.key);
    }
  }, [selectedThreadKey, threadOptions]);

  const searchScope = selectedThreadKey ?? threadOptions[0]?.key;

  const scopeKeys = useMemo(() => {
    if (!messages) {
      return [];
    }
    if (
      searchScope &&
      searchScope !== COMBINED_FEED_KEY &&
      searchScope !== ALL_MESSAGES_KEY &&
      threadIndex
    ) {
      return Array.from(threadIndex.get(searchScope)?.messageKeys ?? []);
    }
    const archivedThreadIds = new Set<string>();
    for (const row0 of chatActions?.listThreadConfigRows?.() ?? []) {
      const row =
        row0 && typeof row0?.toJS === "function" ? row0.toJS() : row0;
      const threadId = `${row?.thread_id ?? ""}`.trim();
      if (!threadId) continue;
      if (asArchivedFlag(row?.archived)) archivedThreadIds.add(threadId);
    }
    return Array.from(messages.keys()).filter((key) => {
      const msg = messages.get(key) as any;
      const threadId = `${msg?.thread_id ?? ""}`.trim();
      if (!threadId) return true;
      return !archivedThreadIds.has(threadId);
    });
  }, [messages, threadIndex, searchScope, chatActions]);

  const scopeHasArchivedRows = useMemo(() => {
    if (!chatActions || !searchScope) return false;
    if (searchScope === COMBINED_FEED_KEY || searchScope === ALL_MESSAGES_KEY) {
      // Keep "all/combined" scoped to currently loaded rows only, so user-archived
      // threads never appear through backend-row matches.
      return false;
    }
    const meta = chatActions.getThreadMetadata?.(searchScope, {
      threadId: searchScope,
    });
    const value = meta?.archived_chat_rows;
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }, [chatActions, searchScope, cacheVersion]);
  const keysToScanSet = useMemo(() => new Set(scopeKeys), [scopeKeys]);

  const resultLimit = useMemo(() => messages?.size ?? 0, [messages]);

  useEffect(() => {
    if (!index || !search.trim() || !messages || messages.size === 0) {
      setResult([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rawResult = await index.search({
          term: search,
          limit: resultLimit,
        });
        if (cancelled) return;
        const hits = rawResult?.hits ?? [];
        const filtered = hits.filter((hit) =>
          keysToScanSet.has(hit.id ?? hit.document?.id),
        );
        setResult(
          filtered.map((hit) => ({
            id: hit.id,
            content: hit.document?.content ?? "",
          })),
        );
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index, search, messages, resultLimit, keysToScanSet, setError]);

  useEffect(() => {
    const query = search.trim();
    if (
      !query ||
      !project_id ||
      !path ||
      !searchScope ||
      !scopeHasArchivedRows
    ) {
      setArchivedSearchLoading(false);
      setArchivedSearchError("");
      setArchivedResult([]);
      setArchivedTotalCount(0);
      return;
    }
    const hubProjects = webapp_client.conat_client?.hub?.projects;
    if (!hubProjects) {
      setArchivedSearchLoading(false);
      setArchivedSearchError("Conat project API is unavailable.");
      setArchivedResult([]);
      setArchivedTotalCount(0);
      return;
    }
    const threadId =
      searchScope === COMBINED_FEED_KEY || searchScope === ALL_MESSAGES_KEY
        ? undefined
        : searchScope;
    let cancelled = false;
    setArchivedSearchLoading(true);
    setArchivedSearchError("");
    void (async () => {
      try {
        const response = await hubProjects.chatStoreSearch({
          project_id,
          chat_path: path,
          query,
          thread_id: threadId,
          limit: 100,
          offset: 0,
        });
        if (cancelled) return;
        const mapped = (response?.hits ?? []).map(mapArchivedHitToMatchHit);
        setArchivedResult(mapped);
        setArchivedTotalCount(
          parseArchivedTotalCount(response, mapped.length),
        );
      } catch (err) {
        if (cancelled) return;
        setArchivedSearchError(`${err}`);
        setArchivedResult([]);
        setArchivedTotalCount(0);
      } finally {
        if (!cancelled) {
          setArchivedSearchLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project_id, path, search, searchScope, scopeHasArchivedRows]);

  const combinedResult = useMemo(() => {
    if (archivedResult.length === 0) return result;
    const all = [...result, ...archivedResult];
    const deduped = new Map<string, MatchHit>();
    for (const hit of all) {
      const key = `${hit.id}|${hit.source ?? "live"}`;
      if (!deduped.has(key)) deduped.set(key, hit);
    }
    return Array.from(deduped.values()).sort((a, b) => {
      const ta = Number.parseFloat(a.id);
      const tb = Number.parseFloat(b.id);
      const va = Number.isFinite(ta) ? ta : 0;
      const vb = Number.isFinite(tb) ? tb : 0;
      return vb - va;
    });
  }, [result, archivedResult]);

  const hydratedThreadDate = useCallback(
    async (threadId: string, targetDateMs: number): Promise<boolean> => {
      if (!project_id || !path || !chatActions) return false;
      const dateKey = `${targetDateMs}`;
      if (chatActions.getAllMessages()?.has(dateKey)) return true;
      const hubProjects = webapp_client.conat_client?.hub?.projects;
      if (!hubProjects) return false;
      let offset = 0;
      const limit = 200;
      for (let i = 0; i < 25; i++) {
        const result = await hubProjects.chatStoreReadArchived({
          project_id,
          chat_path: path,
          thread_id: threadId,
          limit,
          offset,
        });
        const rows = result.rows ?? [];
        if (!rows.length) return chatActions.getAllMessages()?.has(dateKey) ?? false;
        chatActions.hydrateArchivedRows(
          rows.map((row) => row.row).filter((row) => row != null),
        );
        if (chatActions.getAllMessages()?.has(dateKey)) return true;
        if (result.next_offset == null) break;
        offset = result.next_offset;
      }
      return chatActions.getAllMessages()?.has(dateKey) ?? false;
    },
    [chatActions, path, project_id],
  );

  const onSelectHit = useCallback(
    async (hit: MatchHit) => {
      const key = fragmentKey ?? "chat";
      const dateMs = Number.parseFloat(hit.id);
      if (!Number.isFinite(dateMs)) return;
      if (
        hit.source === "archived" &&
        searchScope &&
        searchScope !== COMBINED_FEED_KEY &&
        searchScope !== ALL_MESSAGES_KEY
      ) {
        try {
          await hydratedThreadDate(searchScope, dateMs);
        } catch (err) {
          setArchivedSearchError(`${err}`);
        }
      }
      actions?.gotoFragment?.({ [key]: `${dateMs}` });
    },
    [actions, fragmentKey, hydratedThreadDate, searchScope],
  );

  const loadedCount = result.length;
  const archivedCount = archivedResult.length;
  const totalCount = combinedResult.length;

  return (
    <div className="smc-vfill">
      <Card
        title={
          <>
            Search Chatroom{" "}
            {separate_file_extension(path_split(path).tail).name}
          </>
        }
        style={{ fontSize }}
      >
        <ShowError
          error={error}
          setError={setError}
          style={{ marginBottom: "15px", fontSize }}
        />
        {isIndexing ? (
          <div style={{ color: "#888", marginBottom: "10px", fontSize }}>
            Indexing...
          </div>
        ) : null}
        {archivedSearchLoading ? (
          <div style={{ color: "#888", marginBottom: "10px", fontSize }}>
            Searching backend history...
          </div>
        ) : null}
        {archivedSearchError ? (
          <div style={{ color: "#b71c1c", marginBottom: "10px", fontSize }}>
            Backend search error: {archivedSearchError}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignItems: "stretch",
          }}
        >
          <Select
            style={{ width: "100%" }}
            value={searchScope}
            onChange={(value) => setSelectedThreadKey(value)}
            showSearch={{
              optionFilterProp: "label",
              filterSort: (optionA, optionB) =>
                (optionA?.label ?? "")
                  .toLowerCase()
                  .localeCompare((optionB?.label ?? "").toLowerCase()),
            }}
            options={[
              { value: ALL_MESSAGES_KEY, label: ALL_MESSAGES_LABEL },
              { value: COMBINED_FEED_KEY, label: COMBINED_FEED_LABEL },
              ...threadOptions.map((thread) => ({
                value: thread.key,
                label: thread.label,
              })),
            ]}
          />
          <Input.Search
            style={{ fontSize, width: "100%" }}
            allowClear
            placeholder="Search chat..."
            value={searchInput}
            onChange={(e) => {
              const value = e.target.value ?? "";
              setSearchInput(value);
              if (!value.trim()) {
                setSearch("");
                saveSearch("");
              }
            }}
            onSearch={(value) => {
              const nextValue = value ?? "";
              setSearch(nextValue);
              saveSearch(nextValue);
            }}
          />
          {search.trim() ? (
            <div style={{ color: "#666", fontSize: 12 }}>
              {archivedSearchLoading
                ? `Searching… loaded: ${loadedCount}`
                : `Hits shown: ${totalCount} (${loadedCount} loaded${
                    scopeHasArchivedRows
                      ? `, ${archivedCount} backend shown / ${archivedTotalCount} backend total`
                      : ""
                  })`}
            </div>
          ) : null}
        </div>
      </Card>
      <div className="smc-vfill">
        <div style={{ overflow: "auto", padding: "15px" }}>
          <div style={{ color: "#888", textAlign: "center", fontSize }}>
            {!search?.trim() && <span>Enter a search above</span>}
            {combinedResult.length === 0 && search?.trim() && <span>No Matches</span>}
          </div>
          {combinedResult.map((hit) => (
            <SearchResult
              key={`${hit.source ?? "live"}:${hit.id}`}
              hit={hit}
              onSelect={onSelectHit}
              fontSize={fontSize}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SearchResult({
  hit,
  onSelect,
  fontSize,
}: {
  hit: MatchHit;
  onSelect: (hit: MatchHit) => void | Promise<void>;
  fontSize: number;
}) {
  const dateMs = Number.parseFloat(hit.id);
  const hasJumpTarget = Number.isFinite(dateMs);
  return (
    <div
      style={{
        cursor: hasJumpTarget ? "pointer" : "default",
        margin: "10px 0",
        padding: "5px",
        border: "1px solid #ccc",
        background: "#f8f8f8",
        borderRadius: "5px",
        maxHeight: "120px",
        overflow: "hidden",
        fontSize,
      }}
      onClick={() => {
        if (!hasJumpTarget) return;
        void onSelect(hit);
      }}
    >
      {hasJumpTarget ? (
        <TimeAgo style={{ float: "right", color: "#888" }} date={dateMs} />
      ) : null}
      {hit.source === "archived" ? (
        <span style={{ float: "right", color: "#888", marginRight: 8 }}>
          backend
        </span>
      ) : null}
      <StaticMarkdown
        value={hit.content}
        style={{ marginBottom: "-10px" /* account for <p> */ }}
      />
    </div>
  );
}

function mapArchivedHitToMatchHit(hit: ChatStoreSearchHit): MatchHit {
  const dateMs =
    typeof hit?.date_ms === "number" && Number.isFinite(hit.date_ms)
      ? hit.date_ms
      : undefined;
  const id = dateMs != null ? `${dateMs}` : `${hit.segment_id}:${hit.row_id}`;
  const content = (hit.snippet ?? hit.excerpt ?? "").trim() || "(no preview)";
  return { id, content, source: "archived" };
}

function parseArchivedTotalCount(
  response: { total_hits?: unknown; total?: unknown } | undefined,
  fallback: number,
): number {
  const totalHits = Number(response?.total_hits);
  if (Number.isFinite(totalHits) && totalHits >= 0) return Math.floor(totalHits);
  const legacyTotal = Number(response?.total);
  if (Number.isFinite(legacyTotal) && legacyTotal >= 0) {
    return Math.floor(legacyTotal);
  }
  return fallback;
}
