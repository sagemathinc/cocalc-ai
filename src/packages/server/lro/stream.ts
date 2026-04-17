import { conat } from "@cocalc/backend/conat";
import {
  publishLroEvent as publishLroEvent0,
  publishLroSummary as publishLroSummary0,
} from "@cocalc/conat/lro/stream";
import type { AccountFeedEvent } from "@cocalc/conat/hub/api/account-feed";
import type {
  LroEvent,
  LroScopeType,
  LroSummary,
} from "@cocalc/conat/hub/api/lro";
import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";

export async function publishLroEvent(opts: {
  scope_type: LroScopeType;
  scope_id: string;
  op_id: string;
  event: LroEvent;
  ttl?: number;
}): Promise<void> {
  await publishLroEvent0({
    ...opts,
    client: conat(),
  });
}

export async function publishLroSummary(opts: {
  scope_type: LroScopeType;
  scope_id: string;
  summary: LroSummary;
}): Promise<void> {
  await publishLroSummary0({
    ...opts,
    client: conat(),
  });
  const account_ids = new Set<string>();
  const created_by = `${opts.summary.created_by ?? ""}`.trim();
  if (created_by) {
    account_ids.add(created_by);
  }
  if (opts.scope_type === "account") {
    const scope_account_id = `${opts.scope_id ?? ""}`.trim();
    if (scope_account_id) {
      account_ids.add(scope_account_id);
    }
  }
  for (const account_id of account_ids) {
    void publishAccountFeedEventBestEffort({
      account_id,
      event: {
        type: "lro.summary",
        ts: Date.now(),
        account_id,
        summary: opts.summary,
      } satisfies AccountFeedEvent,
    });
  }
}
