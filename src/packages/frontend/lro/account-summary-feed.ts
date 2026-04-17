import { redux as appRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  accountFeedStreamName,
  type AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { isTerminal } from "./utils";

type FeedReason = "change" | "reset";
type Listener = (reason: FeedReason) => void;
type ListLroFunction = (opts: {
  scope_type: LroSummary["scope_type"];
  scope_id: string;
  include_completed?: boolean;
}) => Promise<LroSummary[]>;

const listeners = new Set<Listener>();
const summaries = new Map<string, LroSummary>();
const bootstrapInFlight = new Map<string, Promise<void>>();

let hooksInstalled = false;
let realtimeFeed: DStream<AccountFeedEvent> | undefined;
let realtimeFeedAccountId: string | undefined;
let signedInListener: (() => void) | undefined;
let signedOutListener: (() => void) | undefined;
let rememberMeFailedListener: (() => void) | undefined;
let conatConnectedListener: (() => void) | undefined;

function notify(reason: FeedReason): void {
  for (const listener of Array.from(listeners)) {
    listener(reason);
  }
}

function getAccountId(): string | undefined {
  return (
    webapp_client.account_id ?? appRedux.getStore("account")?.get("account_id")
  );
}

function closeRealtimeFeed(): void {
  if (realtimeFeed != null) {
    realtimeFeed.removeListener("change", handleRealtimeFeedChange);
    realtimeFeed.removeListener("history-gap", handleRealtimeFeedHistoryGap);
    realtimeFeed.close();
    realtimeFeed = undefined;
  }
  realtimeFeedAccountId = undefined;
}

function clearSummaries(): void {
  if (summaries.size === 0) {
    return;
  }
  summaries.clear();
  notify("change");
}

async function ensureRealtimeFeedForCurrentAccount(): Promise<void> {
  if (listeners.size === 0) {
    closeRealtimeFeed();
    return;
  }
  if (!webapp_client.is_signed_in()) {
    closeRealtimeFeed();
    return;
  }
  const account_id = getAccountId();
  if (account_id == null) {
    return;
  }
  if (
    realtimeFeed != null &&
    realtimeFeedAccountId === account_id &&
    !realtimeFeed.isClosed()
  ) {
    return;
  }
  closeRealtimeFeed();
  try {
    const feed = await webapp_client.conat_client.dstream<AccountFeedEvent>({
      account_id,
      name: accountFeedStreamName(),
      ephemeral: true,
    });
    if (listeners.size === 0) {
      feed.close();
      return;
    }
    feed.on("change", handleRealtimeFeedChange);
    feed.on("history-gap", handleRealtimeFeedHistoryGap);
    realtimeFeed = feed;
    realtimeFeedAccountId = account_id;
  } catch (err) {
    console.warn("lro summary realtime feed error", err);
  }
}

function handleRealtimeFeedChange(event?: AccountFeedEvent): void {
  if (event == null || event.type !== "lro.summary") {
    return;
  }
  summaries.set(event.summary.op_id, event.summary);
  notify("change");
}

function handleRealtimeFeedHistoryGap(): void {
  closeRealtimeFeed();
  notify("reset");
  void ensureRealtimeFeedForCurrentAccount();
}

function installHooks(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;
  signedInListener = () => {
    void ensureRealtimeFeedForCurrentAccount();
  };
  signedOutListener = () => {
    closeRealtimeFeed();
    clearSummaries();
  };
  rememberMeFailedListener = () => {
    closeRealtimeFeed();
    clearSummaries();
  };
  conatConnectedListener = () => {
    void ensureRealtimeFeedForCurrentAccount();
  };
  webapp_client.on("signed_in", signedInListener);
  webapp_client.on("signed_out", signedOutListener);
  webapp_client.on("remember_me_failed", rememberMeFailedListener);
  webapp_client.conat_client.on("connected", conatConnectedListener);
}

function sameScope(
  summary: LroSummary,
  scope_type: LroSummary["scope_type"],
  scope_id: string,
): boolean {
  return summary.scope_type === scope_type && summary.scope_id === scope_id;
}

function shouldReplaceFromBootstrap(
  summary: LroSummary,
  include_completed?: boolean,
): boolean {
  if (include_completed) {
    return true;
  }
  return !summary.dismissed_at && !isTerminal(summary.status);
}

function mergeBootstrapSummaries(opts: {
  scope_type: LroSummary["scope_type"];
  scope_id: string;
  include_completed?: boolean;
  rows: LroSummary[];
}): void {
  const nextIds = new Set(opts.rows.map((row) => row.op_id));
  let changed = false;
  for (const [op_id, summary] of Array.from(summaries.entries())) {
    if (
      sameScope(summary, opts.scope_type, opts.scope_id) &&
      shouldReplaceFromBootstrap(summary, opts.include_completed) &&
      !nextIds.has(op_id)
    ) {
      summaries.delete(op_id);
      changed = true;
    }
  }
  for (const row of opts.rows) {
    const prev = summaries.get(row.op_id);
    if (prev !== row) {
      summaries.set(row.op_id, row);
      changed = true;
    }
  }
  if (changed) {
    notify("change");
  }
}

export function subscribeAccountLroSummaryFeed(listener: Listener): () => void {
  installHooks();
  listeners.add(listener);
  void ensureRealtimeFeedForCurrentAccount();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      closeRealtimeFeed();
    }
  };
}

export function getAccountLroSummaries(opts?: {
  scope_type?: LroSummary["scope_type"];
  scope_id?: string;
}): LroSummary[] {
  const rows = Array.from(summaries.values());
  if (opts?.scope_type == null || opts.scope_id == null) {
    return rows;
  }
  return rows.filter((row) => sameScope(row, opts.scope_type!, opts.scope_id!));
}

export async function bootstrapAccountLroScope(opts: {
  scope_type: LroSummary["scope_type"];
  scope_id: string;
  include_completed?: boolean;
  listLro: ListLroFunction;
}): Promise<void> {
  const key = JSON.stringify([
    opts.scope_type,
    opts.scope_id,
    !!opts.include_completed,
  ]);
  const existing = bootstrapInFlight.get(key);
  if (existing != null) {
    await existing;
    return;
  }
  const inFlight = (async () => {
    const rows = await opts.listLro({
      scope_type: opts.scope_type,
      scope_id: opts.scope_id,
      include_completed: opts.include_completed,
    });
    mergeBootstrapSummaries({
      scope_type: opts.scope_type,
      scope_id: opts.scope_id,
      include_completed: opts.include_completed,
      rows,
    });
  })();
  bootstrapInFlight.set(key, inFlight);
  try {
    await inFlight;
  } finally {
    if (bootstrapInFlight.get(key) === inFlight) {
      bootstrapInFlight.delete(key);
    }
  }
}

export function resetAccountLroSummaryFeedForTests(): void {
  closeRealtimeFeed();
  bootstrapInFlight.clear();
  summaries.clear();
  listeners.clear();
  if (!hooksInstalled) {
    return;
  }
  if (signedInListener != null) {
    webapp_client.removeListener?.("signed_in", signedInListener);
    signedInListener = undefined;
  }
  if (signedOutListener != null) {
    webapp_client.removeListener?.("signed_out", signedOutListener);
    signedOutListener = undefined;
  }
  if (rememberMeFailedListener != null) {
    webapp_client.removeListener?.(
      "remember_me_failed",
      rememberMeFailedListener,
    );
    rememberMeFailedListener = undefined;
  }
  if (conatConnectedListener != null) {
    webapp_client.conat_client.removeListener?.(
      "connected",
      conatConnectedListener,
    );
    conatConnectedListener = undefined;
  }
  hooksInstalled = false;
}
