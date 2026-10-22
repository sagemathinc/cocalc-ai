/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// CoCalc Lite has no account notifications (its mentions store stays empty),
// so the sidebar learns which conversations wait for an answer from the
// project's attention records instead, as the chat's own question cards do.

import { useEffect, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { waitingThreadsFromAttention } from "./sidebar-recent";

const REFRESH_MS = 10_000;

export function useLiteWaitingThreads({
  active,
  project_id,
  account_id,
}: {
  active: boolean;
  project_id: string;
  account_id?: string;
}): ReadonlySet<string> {
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!active || !project_id) {
      setWaiting(new Set());
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await webapp_client.conat_client.attentionAcp({
          action: "list",
          project_id,
          state: "actionable",
        });
        if (!disposed && result.ok) {
          const next = waitingThreadsFromAttention(result.records, account_id);
          // Keep the same set while nothing changed, so the list stays put.
          setWaiting((previous) =>
            previous.size === next.size &&
            [...next].every((key) => previous.has(key))
              ? previous
              : next,
          );
        }
      } catch {
        // Keep the last known state; the next refresh tries again.
      }
      if (!disposed) timer = setTimeout(refresh, REFRESH_MS);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, project_id, account_id]);
  return waiting;
}
