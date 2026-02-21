import { Map as iMap, fromJS } from "immutable";
import { normalizeChatMessage } from "./normalize";

const THREAD_STATE_EVENT = "chat-thread-state";

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

export function initFromSyncDB({
  syncdb,
  store,
}: {
  syncdb: any;
  store: any;
}) {
  if (!syncdb || !store || typeof syncdb.get !== "function") return;
  const rows = syncdb.get();
  if (!Array.isArray(rows)) return;
  let acpState = store.get("acpState") ?? iMap();
  for (const row of rows) {
    if ((row as any)?.event !== THREAD_STATE_EVENT) continue;
    const ms = new Date((row as any)?.date).valueOf();
    if (!Number.isFinite(ms)) continue;
    const mapped = threadStateToAcpState((row as any)?.state);
    const byThreadId = threadStateKey(row);
    if (mapped) {
      acpState = acpState.set(`${ms}`, mapped);
      if (byThreadId) {
        acpState = acpState.set(byThreadId, mapped);
      }
    } else {
      acpState = acpState.delete(`${ms}`);
      if (byThreadId) {
        acpState = acpState.delete(byThreadId);
      }
    }
  }
  store.setState({ acpState });
}

const ignoredChatEvents = new Set([
  "chat-thread",
  "chat-thread-config",
]);
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

    if (event === "chat") {
      const record = syncdb.get_one(where);
      if (!record) continue;
      const { message } = normalizeChatMessage(record);
      if (!activityReady || !message) continue;
      const root = message.reply_to
        ? new Date(message.reply_to).valueOf()
        : message.date.valueOf();
      const key = `${root}`;
      const now = Date.now();
      const activity = (store.get("activity") ?? iMap()).set(key, now);
      store.setState({ activity });
      continue;
    }

    if (event === THREAD_STATE_EVENT) {
      const ms = new Date(date).valueOf();
      if (!Number.isFinite(ms)) continue;
      const record = syncdb.get_one(where);
      const mapped = threadStateToAcpState((record as any)?.state);
      const key = `${ms}`;
      const byThreadId = threadStateKey(record ?? obj);
      const acpState = store.get("acpState") ?? iMap();
      let next = mapped ? acpState.set(key, mapped) : acpState.delete(key);
      if (byThreadId) {
        next = mapped ? next.set(byThreadId, mapped) : next.delete(byThreadId);
      }
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
