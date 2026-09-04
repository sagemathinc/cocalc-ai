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
    if (record.state !== "pending") continue;
    const threadId = `${record.thread_id ?? ""}`.trim();
    if (!threadId) continue;
    counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
  }
  return counts;
}

export function useCodexAttentionSummary(opts: {
  active: boolean;
  project_id: string;
  path: string;
}): {
  count: number;
  records: readonly AcpAttentionRecord[];
  byThread: ReadonlyMap<string, number>;
  targetByThread: ReadonlyMap<string, string>;
} {
  const [records, setRecords] = useState<AcpAttentionRecord[]>([]);
  const recordsRef = useRef<AcpAttentionRecord[]>([]);

  useEffect(() => {
    if (!opts.active || !opts.project_id || !opts.path.trim()) {
      setRecords([]);
      recordsRef.current = [];
      return;
    }
    setRecords([]);
    recordsRef.current = [];
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const result = await webapp_client.conat_client.attentionAcp({
          action: "list",
          project_id: opts.project_id,
          path: opts.path,
          state: "pending",
        });
        if (!disposed && result.ok) {
          const next = result.records ?? [];
          const nextIds = new Set(next.map(({ attention_id }) => attention_id));
          for (const previous of recordsRef.current) {
            if (!nextIds.has(previous.attention_id)) {
              deliverAttention(previous, "resolved");
            }
          }
          for (const record of next) deliverAttention(record);
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
  }, [opts.active, opts.path, opts.project_id]);

  const byThread = useMemo(() => pendingAttentionByThread(records), [records]);
  const targetByThread = useMemo(() => {
    const targets = new Map<string, string>();
    for (const record of records) {
      if (record.state !== "pending" || targets.has(record.thread_id)) continue;
      targets.set(record.thread_id, record.attention_id);
    }
    return targets;
  }, [records]);
  return useMemo(
    () => ({
      count: [...byThread.values()].reduce((sum, value) => sum + value, 0),
      records,
      byThread,
      targetByThread,
    }),
    [byThread, records, targetByThread],
  );
}
