/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useRef, useState } from "react";
import { Alert, Button, Input, Modal, Typography } from "antd";
import { TimeAgo } from "@cocalc/frontend/components";
import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ChatStoreSearchHit } from "@cocalc/conat/hub/api/projects";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ListedConversation } from "@cocalc/util/people";

// Message search runs the existing per-file chat-store search over the most
// recently active conversations, one at a time.
export const SEARCH_MAX_CONVERSATIONS = 50;
const HITS_PER_CONVERSATION = 5;

// Escape glob metacharacters so a file name matches only itself.
export function globLiteral(name: string): string {
  return name.replace(/[\\*?[\]{}!]/g, (c) => `\\${c}`);
}

// Turn ripgrep --json output for a .chat file into hits: each matching line is
// one chat record.
export function hitsFromRipgrepJson(
  stdout: string,
  query: string,
): ChatStoreSearchHit[] {
  const hits: ChatStoreSearchHit[] = [];
  const needle = query.toLowerCase();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "match") continue;
    let record: any;
    try {
      record = JSON.parse(event.data?.lines?.text ?? "");
    } catch {
      continue;
    }
    if (record?.event !== "chat") continue;
    const text = `${record.history?.[0]?.content ?? record.content ?? ""}`;
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 60);
    const date = Date.parse(record.date);
    hits.push({
      row_id: event.data?.line_number ?? hits.length,
      segment_id: "head",
      thread_id: record.thread_id,
      date_ms: Number.isFinite(date) ? date : undefined,
      snippet:
        (start > 0 ? "..." : "") +
        text.slice(start, at + needle.length + 100).replace(/\s+/g, " "),
    });
  }
  return hits;
}

// Current messages: ripgrep the .chat file through the project-host
// filesystem (no compute start). Archived messages: the chat store.
async function searchConversationFile(
  c: ListedConversation,
  query: string,
): Promise<ChatStoreSearchHit[]> {
  await ensureProjectReduxRuntime();
  const fs = redux.getProjectActions(c.project_id)?.fs();
  if (fs == null) throw Error("project is not available");
  const slash = c.path.lastIndexOf("/");
  const output = await fs.ripgrep(c.path.slice(0, slash) || "/", query, {
    options: [
      "--json",
      "--fixed-strings",
      "--ignore-case",
      "--hidden",
      "--no-ignore",
      "--max-depth",
      "1",
      "--glob",
      globLiteral(c.path.slice(slash + 1)),
      "--max-count",
      `${HITS_PER_CONVERSATION * 4}`,
    ],
    timeout: 15_000,
    maxSize: 2_000_000,
  });
  const hits = hitsFromRipgrepJson(
    Buffer.from(output.stdout).toString(),
    query,
  ).slice(0, HITS_PER_CONVERSATION);
  try {
    const archived =
      await webapp_client.conat_client.hub.projects.chatStoreSearch({
        project_id: c.project_id,
        chat_path: c.path,
        query,
        limit: HITS_PER_CONVERSATION,
      });
    hits.push(...archived.hits);
  } catch {
    // no archive for this chat
  }
  return hits;
}

interface Hit {
  conversation: ListedConversation;
  hit: ChatStoreSearchHit;
}

export async function searchConversations({
  conversations,
  query,
  search = searchConversationFile,
  onProgress,
  canceled,
}: {
  conversations: ListedConversation[];
  query: string;
  search?: (
    c: ListedConversation,
    query: string,
  ) => Promise<ChatStoreSearchHit[]>;
  onProgress: (hits: Hit[], searched: number, failed: number) => void;
  canceled: () => boolean;
}): Promise<void> {
  const targets = [...conversations]
    .sort((a, b) => b.last_activity - a.last_activity)
    .slice(0, SEARCH_MAX_CONVERSATIONS);
  const hits: Hit[] = [];
  let searched = 0;
  let failed = 0;
  for (const conversation of targets) {
    if (canceled()) return;
    try {
      for (const hit of await search(conversation, query)) {
        hits.push({ conversation, hit });
      }
    } catch {
      failed += 1;
    }
    searched += 1;
    hits.sort((a, b) => (b.hit.date_ms ?? 0) - (a.hit.date_ms ?? 0));
    onProgress([...hits], searched, failed);
  }
}

export function SearchDialog({
  open,
  conversations,
  onOpen,
  onClose,
}: {
  open: boolean;
  conversations: ListedConversation[];
  onOpen: (conversation: ListedConversation) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState(0);
  const [failed, setFailed] = useState(0);
  const [running, setRunning] = useState(false);
  const generation = useRef(0);
  const total = Math.min(conversations.length, SEARCH_MAX_CONVERSATIONS);

  async function run() {
    const q = query.trim();
    if (!q) return;
    const current = ++generation.current;
    setRunning(true);
    setHits([]);
    setSearched(0);
    setFailed(0);
    await searchConversations({
      conversations,
      query: q,
      canceled: () => current !== generation.current,
      onProgress: (hits, searched, failed) => {
        if (current !== generation.current) return;
        setHits(hits);
        setSearched(searched);
        setFailed(failed);
      },
    });
    if (current === generation.current) setRunning(false);
  }

  return (
    <Modal
      open={open}
      title="Search messages"
      width={760}
      footer={null}
      onCancel={() => {
        generation.current++;
        onClose();
      }}
      destroyOnHidden
    >
      <Input.Search
        aria-label="Search messages"
        placeholder="Words in messages"
        autoFocus
        enterButton="Search"
        loading={running}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={() => void run()}
      />
      <div
        role="status"
        style={{ color: UI_COLORS.secondary, fontSize: 13, margin: "8px 0" }}
      >
        {searched > 0 &&
          `Searched ${searched} of ${total} conversations · ${hits.length} ${hits.length === 1 ? "match" : "matches"}`}
        {conversations.length > SEARCH_MAX_CONVERSATIONS &&
          searched > 0 &&
          ` (the ${SEARCH_MAX_CONVERSATIONS} most recent)`}
      </div>
      {failed > 0 && (
        <Alert
          type="warning"
          role="alert"
          title={`${failed} ${failed === 1 ? "conversation" : "conversations"} could not be searched.`}
        />
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {hits.map(({ conversation, hit }, i) => (
          <li key={`${conversation.conversation_id}:${hit.row_id}:${i}`}>
            <Button
              type="text"
              block
              style={{
                height: "auto",
                textAlign: "left",
                display: "block",
                padding: "6px 8px",
                whiteSpace: "normal",
              }}
              onClick={() => {
                generation.current++;
                onOpen(conversation);
                onClose();
              }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <Typography.Text strong ellipsis style={{ flex: 1 }}>
                  {conversation.title}
                </Typography.Text>
                {hit.date_ms != null && (
                  <span style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
                    <TimeAgo date={new Date(hit.date_ms)} />
                  </span>
                )}
              </div>
              <div style={{ color: UI_COLORS.secondary, fontSize: 13 }}>
                {hit.snippet ?? hit.excerpt ?? ""}
              </div>
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
