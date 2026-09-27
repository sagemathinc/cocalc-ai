/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { showCodexNotificationBestEffort } from "@cocalc/frontend/notifications/codex-turn-toast";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const REFRESH_MS = 5_000;
const MAX_RETAINED_RESPONSES = 20;

function needsResponse(record: AcpAttentionRecord): boolean {
  return record.state === "pending" && record.response_submitted_at == null;
}

function deliverAttention(
  record: AcpAttentionRecord,
  attentionState: AcpAttentionRecord["state"] = record.state,
): void {
  void showCodexNotificationBestEffort({
    account_id: record.account_id,
    row: {
      notification_id: record.attention_id,
      kind: "account_notice",
      project_id: record.project_id,
      summary: {
        notice_type: "codex_attention",
        origin_label: "Codex",
        attention_id: record.attention_id,
        attention_state: attentionState,
        message_date: record.message_date,
        path: record.path,
        thread_id: record.thread_id,
        stable_source_id: record.source_id,
      },
    },
  });
}

export function pendingAttentionByThread(
  records: readonly AcpAttentionRecord[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (!needsResponse(record)) continue;
    const threadId = `${record.thread_id ?? ""}`.trim();
    if (!threadId) continue;
    counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
  }
  return counts;
}

export function useCodexAttentionSummary(opts: {
  active: boolean;
  account_id?: string;
  project_id: string;
  path: string;
}): {
  count: number;
  records: readonly AcpAttentionRecord[];
  byThread: ReadonlyMap<string, number>;
  targetByThread: ReadonlyMap<string, string>;
} {
  const [records, setRecords] = useState<AcpAttentionRecord[]>([]);
  const context = JSON.stringify([opts.account_id, opts.project_id, opts.path]);
  const [recordsContext, setRecordsContext] = useState(context);
  const recordsRef = useRef<AcpAttentionRecord[]>([]);

  useEffect(() => {
    if (!opts.active || !opts.project_id || !opts.path.trim()) {
      setRecords([]);
      recordsRef.current = [];
      return;
    }
    setRecords([]);
    setRecordsContext(context);
    recordsRef.current = [];
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const runtime = await webapp_client.conat_client.attentionAcp({
          action: "list",
          project_id: opts.project_id,
          path: opts.path,
          state: "actionable",
        });
        if (disposed || !runtime.ok) return;
        const actionableIds = new Set(
          (runtime.records ?? []).map(({ attention_id }) => attention_id),
        );
        const missingQuestions = recordsRef.current.filter(
          (record) =>
            record.attention_kind === "question" &&
            (record.state === "pending" ||
              (record.state === "stale" &&
                record.source_kind === "codex_sync_question")) &&
            !actionableIds.has(record.attention_id),
        );
        // Resolve only questions observed in this open chat, once they leave the
        // actionable list. Do not poll all history or let its 200-row limit bury
        // current requests. Durable message rows remain the full history.
        const settled: AcpAttentionRecord[] = [];
        for (const threadId of new Set(
          missingQuestions.map(({ thread_id }) => thread_id),
        )) {
          try {
            const history = await webapp_client.conat_client.attentionAcp({
              action: "list",
              project_id: opts.project_id,
              path: opts.path,
              thread_id: threadId,
              state: "all",
            });
            if (!history.ok) continue;
            const missingIds = new Set(
              missingQuestions.map(({ attention_id }) => attention_id),
            );
            settled.push(
              ...(history.records ?? []).filter(
                (record) =>
                  missingIds.has(record.attention_id) &&
                  record.response_submitted_at != null,
              ),
            );
          } catch {
            // Settled history is optional; never discard fresh actionable data.
          }
        }
        if (!disposed) {
          const submitted = [
            ...settled,
            ...recordsRef.current.filter(
              (record) =>
                record.attention_kind === "question" &&
                record.state !== "pending" &&
                !(
                  record.state === "stale" &&
                  record.source_kind === "codex_sync_question"
                ) &&
                record.response_submitted_at != null,
            ),
          ].slice(0, MAX_RETAINED_RESPONSES);
          const candidates = [...submitted, ...(runtime.records ?? [])];
          const latest = new Map<string, AcpAttentionRecord>();
          for (const record of candidates) {
            const previous = latest.get(record.attention_id);
            if (!previous || record.updated_at > previous.updated_at) {
              latest.set(record.attention_id, record);
            }
          }
          const next = [...latest.values()].filter(
            (record) =>
              (!opts.account_id || record.account_id === opts.account_id) &&
              ((record.attention_kind === "question" &&
                record.response_submitted_at != null) ||
                record.state === "pending" ||
                (record.state === "stale" &&
                  record.source_kind === "codex_sync_question")) &&
              (record.state !== "pending" ||
                !record.expires_at ||
                record.expires_at > Date.now()),
          );
          const nextIds = new Set(next.map(({ attention_id }) => attention_id));
          for (const previous of recordsRef.current) {
            if (!nextIds.has(previous.attention_id)) {
              deliverAttention(previous, "resolved");
            }
          }
          for (const record of next) {
            if (needsResponse(record)) deliverAttention(record);
            else if (
              recordsRef.current.some(
                (previous) =>
                  previous.attention_id === record.attention_id &&
                  needsResponse(previous),
              )
            ) {
              deliverAttention(record, "resolved");
            }
          }
          recordsRef.current = next;
          setRecords(next);
        }
      } catch {
        // Keep the last authoritative result across transient reconnects.
      } finally {
        refreshing = false;
        if (!disposed) timer = setTimeout(() => void refresh(), REFRESH_MS);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [opts.active, opts.account_id, opts.path, opts.project_id, context]);

  const visibleRecords = recordsContext === context ? records : [];
  const byThread = useMemo(
    () => pendingAttentionByThread(visibleRecords),
    [visibleRecords],
  );
  const targetByThread = useMemo(() => {
    const targets = new Map<string, string>();
    for (const record of visibleRecords) {
      if (!needsResponse(record) || targets.has(record.thread_id)) continue;
      targets.set(record.thread_id, record.attention_id);
    }
    return targets;
  }, [visibleRecords]);
  return useMemo(
    () => ({
      count: [...byThread.values()].reduce((sum, value) => sum + value, 0),
      records: visibleRecords,
      byThread,
      targetByThread,
    }),
    [byThread, visibleRecords, targetByThread],
  );
}
