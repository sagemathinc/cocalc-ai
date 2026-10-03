// Retained chat switching with the real ChatLog. Built as its own bundle
// because ChatLog pulls in far more of the frontend than the composer harness.
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { ChatLog } from "../chat-log";

const THREAD_BASE_DATE = {
  A: 1_700_000_000_000,
  B: 1_700_000_000_000,
  C: 1_710_000_000_000,
};

function switchMessage(prefix: string, i: number) {
  const date = (THREAD_BASE_DATE[prefix] ?? 1_700_000_000_000) + i * 60_000;
  const paragraphs = 1 + ((i * 7) % 6);
  const content = Array.from(
    { length: paragraphs },
    (_, p) =>
      `${prefix} message ${i}, paragraph ${p}. ` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4),
  ).join("\n\n");
  return {
    date,
    message_id: `${prefix}-${i}`,
    thread_id: `${prefix}-thread`,
    sender_id:
      i % 2 === 0 ? "00000000-1000-4000-8000-000000000000" : "other-user",
    history: [{ content, author_id: "x", date }],
  };
}

function switchMessages(prefix: string, count: number) {
  const messages = new Map<string, any>();
  for (let i = 0; i < count; i++) {
    const message = switchMessage(prefix, i);
    messages.set(`${message.date}`, message);
  }
  return messages;
}

// Two retained chats stacked like Agents workspaces. With `reorder`, the active
// one moves to the end of its keyed siblings, as a recency-ordered list would.
function ChatSwitchHarness({
  reorder,
  mode,
}: {
  reorder: boolean;
  mode: "standalone" | "sidechat";
}): React.JSX.Element {
  const [order, setOrder] = useState<string[]>(["a", "b"]);
  // ChatRoom owns these; bottom-following depends on them.
  const scrollToBottomRefA = useRef<any>(null);
  const scrollToBottomRefB = useRef<any>(null);
  const [active, setActive] = useState<string>("a");
  const [logs, setLogs] = useState(() => ({
    a: switchMessages("A", 200),
    b: switchMessages("B", 200),
    c: switchMessages("C", 200),
  }));
  // Log "a" can switch between two threads of the same chat, as the thread
  // sidebar does: one ChatLog, new selectedThread and rows.
  const [threadA, setThreadA] = useState<"A" | "C">("A");
  // Retained views get evicted (Agents keeps a few) and later remount fresh.
  const [evicted, setEvicted] = useState<Record<string, boolean>>({});
  // Rendering real messages touches many chat actions; none matter here.
  const actions = useMemo(
    () =>
      new Proxy({ store: { get: () => undefined }, syncdb: undefined } as any, {
        get: (target, key) => (key in target ? target[key] : () => undefined),
      }),
    [],
  );
  useEffect(() => {
    // New rows arriving, as while an agent is working.
    (window as any).__chatAppend = (id: "a" | "b") => {
      setLogs((old) => {
        const log = new Map(old[id]);
        const message = switchMessage(id.toUpperCase(), log.size);
        log.set(`${message.date}`, message);
        return { ...old, [id]: log };
      });
    };
    // The newest message keeps growing, as an agent reply streams in.
    (window as any).__chatGrow = (id: "a" | "b") => {
      setLogs((old) => {
        const log = new Map(old[id]);
        const [key, message] = [...log.entries()].pop()!;
        const content = `${message.history[0].content}\n\nStreaming paragraph ${log.get(key).history[0].content.length}. ${"More streamed words. ".repeat(12)}`;
        log.set(key, {
          ...message,
          history: [{ ...message.history[0], content }],
        });
        return { ...old, [id]: log };
      });
    };
    (window as any).__chatThread = (thread: "A" | "C") => setThreadA(thread);
    (window as any).__chatEvict = (id: string, value = true) =>
      setEvicted((old) => ({ ...old, [id]: value }));
    (window as any).__chatSwitch = (id: string) => {
      setActive(id);
      if (reorder) {
        setOrder((old) => [...old.filter((x) => x !== id), id]);
      }
    };
  }, [reorder]);
  return (
    <div style={{ position: "relative", height: 600, width: 800 }}>
      {order.map((id) => {
        const shown = active === id;
        return (
          <div
            key={id}
            data-testid={`log-${id}`}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              visibility: shown ? "visible" : "hidden",
            }}
          >
            {evicted[id] ? null : (
              <ChatLog
                project_id="project-1"
                path={`${id}.chat`}
                mode={mode}
                actions={actions}
                selectedThread={
                  id === "a"
                    ? `${threadA}-thread`
                    : `${id.toUpperCase()}-thread`
                }
                messages={id === "a" && threadA === "C" ? logs.c : logs[id]}
                scrollCacheId={`switch-${id}`}
                isVisible={shown}
                scrollToBottomRef={
                  id === "a" ? scrollToBottomRefA : scrollToBottomRefB
                }
                // ChatRoom passes counters that start at 0.
                activityJumpToken={0}
                searchJumpToken={0}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function start() {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("missing #root");
  }
  const params = new URLSearchParams(window.location.search);
  ReactDOM.createRoot(root).render(
    <ChatSwitchHarness
      reorder={params.get("reorder") === "1"}
      // Auto-scrolling needs a foreground surface; side chats always are one.
      mode={params.get("chatMode") === "sidechat" ? "sidechat" : "standalone"}
    />,
  );
}

start();
