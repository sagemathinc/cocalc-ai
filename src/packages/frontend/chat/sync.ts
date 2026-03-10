import { Map as iMap, fromJS } from "immutable";
import { normalizeChatMessage } from "./normalize";

const THREAD_STATE_EVENT = "chat-thread-state";
const CHAT_EVENT = "chat";

function threadStateToAcpState(state: unknown): string | undefined {
  switch (state) {
    case "queued":
      return "queue";
    case "running":
      return "running";
    default:
      return undefined;
  }
}

function threadStateKey(record: any): string | undefined {
  const threadId = (record as any)?.thread_id;
  if (typeof threadId !== "string" || threadId.length === 0) return undefined;
  return `thread:${threadId}`;
}

function threadStateActiveMessageKey(record: any): string | undefined {
  const messageId = (record as any)?.active_message_id;
  if (typeof messageId !== "string" || messageId.length === 0) return undefined;
  return `message:${messageId}`;
}

function threadStateRecordLookupFromRows(rows: any[]): Map<string, any> {
  const lookup = new Map<string, any>();
  for (const row of rows) {
    if ((row as any)?.event !== THREAD_STATE_EVENT) continue;
    const threadId = (row as any)?.thread_id;
    if (typeof threadId !== "string" || threadId.length === 0) continue;
    lookup.set(threadId, row);
  }
  return lookup;
}

function chatRowToAcpState({
  record,
  getThreadStateRecord,
}: {
  record: any;
  getThreadStateRecord?: (threadId: string) => any;
}): string | undefined {
  const state = (record as any)?.acp_state;
  switch (state) {
    case "queued":
      return "queue";
    case "running": {
      const threadId = `${(record as any)?.thread_id ?? ""}`.trim();
      const messageId = `${(record as any)?.message_id ?? ""}`.trim();
      if (!threadId || !messageId || !getThreadStateRecord) return undefined;
      const threadState = getThreadStateRecord(threadId);
      const threadStateName = `${(threadState as any)?.state ?? ""}`.trim();
      const activeMessageId =
        `${(threadState as any)?.active_message_id ?? ""}`.trim();
      return activeMessageId === messageId &&
        (threadStateName === "queued" || threadStateName === "running")
        ? "running"
        : undefined;
    }
    default:
      return undefined;
  }
}

function chatMessageKey(record: any): string | undefined {
  const messageId = (record as any)?.message_id;
  if (typeof messageId !== "string" || messageId.length === 0) return undefined;
  return `message:${messageId}`;
}

function applyChatRowAcpState(
  acpState: any,
  record: any,
  getThreadStateRecord?: (threadId: string) => any,
): any {
  const mapped = chatRowToAcpState({
    record,
    getThreadStateRecord,
  });
  const byMessageId = chatMessageKey(record);
  if (!byMessageId) return acpState;
  return mapped
    ? acpState.set(byMessageId, mapped)
    : acpState.delete(byMessageId);
}

export function initFromSyncDB({ syncdb, store }: { syncdb: any; store: any }) {
  if (!syncdb || !store || typeof syncdb.get !== "function") return;
  const rows = syncdb.get();
  if (!Array.isArray(rows)) return;
  const threadStateLookup = threadStateRecordLookupFromRows(rows);
  let acpState = iMap();
  for (const row of rows) {
    if ((row as any)?.event === THREAD_STATE_EVENT) {
      const mapped = threadStateToAcpState((row as any)?.state);
      const messageMapped =
        (row as any)?.state === "running" ? mapped : undefined;
      const byThreadId = threadStateKey(row);
      const byMessageId = threadStateActiveMessageKey(row);
      if (mapped) {
        if (byThreadId) {
          acpState = acpState.set(byThreadId, mapped);
        }
        if (byMessageId) {
          acpState = messageMapped
            ? acpState.set(byMessageId, messageMapped)
            : acpState.delete(byMessageId);
        }
      } else {
        if (byThreadId) {
          acpState = acpState.delete(byThreadId);
        }
        if (byMessageId) {
          acpState = acpState.delete(byMessageId);
        }
      }
      continue;
    }
    if ((row as any)?.event === CHAT_EVENT) {
      acpState = applyChatRowAcpState(acpState, row, (threadId) =>
        threadStateLookup.get(threadId),
      );
    }
  }
  store.setState({ acpState });
}

function getThreadStateRecord(syncdb: any, threadId?: string): any {
  const normalized = `${threadId ?? ""}`.trim();
  if (!normalized) return undefined;
  return syncdb?.get_one?.({
    event: THREAD_STATE_EVENT,
    thread_id: normalized,
  });
}

function reconcileThreadChatRowAcpState({
  acpState,
  syncdb,
  threadId,
}: {
  acpState: any;
  syncdb: any;
  threadId?: string;
}): any {
  const normalized = `${threadId ?? ""}`.trim();
  if (!normalized) return acpState;
  const rows =
    typeof syncdb?.get === "function"
      ? syncdb.get({ event: CHAT_EVENT, thread_id: normalized })
      : [];
  const records = Array.isArray(rows)
    ? rows
    : typeof rows?.toJS === "function"
      ? rows.toJS()
      : [];
  let next = acpState;
  for (const record of records) {
    next = applyChatRowAcpState(next, record, (id) =>
      getThreadStateRecord(syncdb, id),
    );
  }
  return next;
}

const ignoredChatEvents = new Set(["chat-thread", "chat-thread-config"]);
const warnedUnknownEvents = new Set<string>();

export function handleSyncDBChange({
  syncdb,
  store,
  changes,
}: {
  syncdb: any;
  store: any;
  changes: Set<Record<string, unknown>> | Record<string, unknown>[] | undefined;
}): void {
  if (!syncdb || !store || changes == null) {
    console.warn("handleSyncDBChange: inputs should not be null");
    return;
  }

  const activityReady = store.get("activityReady") === true;
  const rows = Array.isArray(changes) ? changes : Array.from(changes);

  for (const obj of rows) {
    const event = (obj as any)?.event;
    const sender_id = (obj as any)?.sender_id;
    const date = (obj as any)?.date;
    const where: any = {};
    if (event != null) where.event = event;
    if (sender_id != null) where.sender_id = sender_id;
    if (date != null) where.date = date;

    if (event === "draft") {
      let drafts = store.get("drafts") ?? (fromJS({}) as any);
      const record = syncdb.get_one(where);
      const key = `${sender_id}:${date}`;
      if (record == null) {
        drafts = drafts.delete(key);
      } else {
        drafts = drafts.set(key, record);
      }
      store.setState({ drafts });
      continue;
    }

    if (event === CHAT_EVENT) {
      const record = syncdb.get_one(where);
      if (!record) continue;
      const { message } = normalizeChatMessage(record);
      let acpState = store.get("acpState") ?? iMap();
      acpState = applyChatRowAcpState(acpState, record, (threadId) =>
        getThreadStateRecord(syncdb, threadId),
      );
      if (!activityReady || !message) {
        store.setState({ acpState });
        continue;
      }
      const threadId =
        typeof (message as any)?.thread_id === "string"
          ? `${(message as any).thread_id}`.trim()
          : "";
      if (!threadId) {
        store.setState({ acpState });
        continue;
      }
      const key = threadId;
      const now = Date.now();
      const activity = (store.get("activity") ?? iMap()).set(key, now);
      store.setState({ activity, acpState });
      continue;
    }

    if (event === THREAD_STATE_EVENT) {
      const record = syncdb.get_one(where);
      const mapped = threadStateToAcpState((record as any)?.state);
      const messageMapped =
        (record as any)?.state === "running" ? mapped : undefined;
      const byThreadId = threadStateKey(record ?? obj);
      const byMessageId = threadStateActiveMessageKey(record ?? obj);
      const acpState = store.get("acpState") ?? iMap();
      let next = acpState;
      if (byThreadId) {
        next = mapped ? next.set(byThreadId, mapped) : next.delete(byThreadId);
      }
      if (byMessageId) {
        next = messageMapped
          ? next.set(byMessageId, messageMapped)
          : next.delete(byMessageId);
      }
      next = reconcileThreadChatRowAcpState({
        acpState: next,
        syncdb,
        threadId:
          syncdb?.get_one?.(where)?.thread_id ?? (record ?? obj)?.thread_id,
      });
      store.setState({
        acpState: next,
      });
      continue;
    }

    if (ignoredChatEvents.has(event)) {
      continue;
    }
    const key = typeof event === "string" ? event : String(event);
    if (!warnedUnknownEvents.has(key)) {
      warnedUnknownEvents.add(key);
      console.warn("unknown chat event: ", event);
    }
  }

  if (!activityReady) {
    store.setState({ activityReady: true });
  }
}
