// Retained chat switching with the real ChatLog. Built as its own bundle
// because ChatLog pulls in far more of the frontend than the composer harness.
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { ChatLog } from "../chat-log";

function switchMessages(prefix: string, count: number) {
  const messages = new Map<string, any>();
  for (let i = 0; i < count; i++) {
    const date = 1_700_000_000_000 + i * 60_000;
    const paragraphs = 1 + ((i * 7) % 6);
    const content = Array.from(
      { length: paragraphs },
      (_, p) =>
        `${prefix} message ${i}, paragraph ${p}. ` +
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4),
    ).join("\n\n");
    messages.set(`${date}`, {
      date,
      message_id: `${prefix}-${i}`,
      thread_id: `${prefix}-thread`,
      sender_id:
        i % 2 === 0 ? "00000000-1000-4000-8000-000000000000" : "other-user",
      history: [{ content, author_id: "x", date }],
    });
  }
  return messages;
}

// Two retained chats stacked like Agents workspaces. With `reorder`, the active
// one moves to the end of its keyed siblings, as a recency-ordered list would.
function ChatSwitchHarness({
  reorder,
}: {
  reorder: boolean;
}): React.JSX.Element {
  const [order, setOrder] = useState<string[]>(["a", "b"]);
  const [active, setActive] = useState<string>("a");
  const logs = useMemo(
    () => ({ a: switchMessages("A", 200), b: switchMessages("B", 200) }),
    [],
  );
  // Rendering real messages touches many chat actions; none matter here.
  const actions = useMemo(
    () =>
      new Proxy({ store: { get: () => undefined }, syncdb: undefined } as any, {
        get: (target, key) => (key in target ? target[key] : () => undefined),
      }),
    [],
  );
  useEffect(() => {
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
            <ChatLog
              project_id="project-1"
              path={`${id}.chat`}
              mode="standalone"
              actions={actions}
              selectedThread={`${id.toUpperCase()}-thread`}
              messages={logs[id]}
              scrollCacheId={`switch-${id}`}
              isVisible={shown}
              // ChatRoom passes counters that start at 0.
              activityJumpToken={0}
              searchJumpToken={0}
            />
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
    <ChatSwitchHarness reorder={params.get("reorder") === "1"} />,
  );
}

start();
