import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { FrameContext, defaultFrameContext } from "../../frame-editors/frame-tree/frame-context";
import ChatInput from "../input";

declare global {
  interface Window {
    __CHAT_COMPOSER_DEBUG?: boolean;
    __chatComposerTest?: {
      getInput: () => string;
      getSends: () => string[];
      newChat: () => void;
      setOscillationEnabled: (enabled: boolean) => void;
    };
  }
}

function Harness(): React.JSX.Element {
  const [composerDraftKey, setComposerDraftKey] = useState<number>(0);
  const [composerSession, setComposerSession] = useState<number>(1);
  const [input, setInput] = useState<string>("");
  const [oscillationEnabled, setOscillationEnabled] = useState<boolean>(true);
  const [sends, setSends] = useState<string[]>([]);
  const sessionRef = useRef(composerSession);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    sessionRef.current = composerSession;
  }, [composerSession]);

  useEffect(() => {
    return () => {
      for (const t of timersRef.current) {
        window.clearTimeout(t);
      }
      timersRef.current = [];
    };
  }, []);

  const frameContext = useMemo(
    () => ({
      ...defaultFrameContext,
      id: "chat-harness-frame",
      project_id: "project-1",
      path: "chat-harness.chat",
      isFocused: true,
      isVisible: true,
    }),
    [],
  );

  const clearAndAdvanceSession = () => {
    const next = sessionRef.current + 1;
    sessionRef.current = next;
    setComposerSession(next);
    setInput("");
  };

  useEffect(() => {
    window.__CHAT_COMPOSER_DEBUG = true;
    window.__chatComposerTest = {
      getInput: () => input,
      getSends: () => sends,
      newChat: () => {
        clearAndAdvanceSession();
        setComposerDraftKey(0);
      },
      setOscillationEnabled: (enabled: boolean) => {
        setOscillationEnabled(enabled);
      },
    };
  }, [input, sends]);

  const cacheId = `chat-harness-draft-${composerDraftKey}`;
  const fakeSyncdb = useMemo(
    () =>
      ({
        set: () => undefined,
        commit: () => undefined,
      }) as any,
    [],
  );

  return (
    <FrameContext.Provider value={frameContext as any}>
      <div style={{ padding: 16, width: 760 }}>
        <h3>Chat Composer Harness</h3>
        <p style={{ color: "#666", marginTop: 0 }}>
          draftKey: <span data-testid="draft-key">{composerDraftKey}</span>, session:{" "}
          <span data-testid="session">{composerSession}</span>
        </p>
        <ChatInput
          cacheId={cacheId}
          fixedMode="markdown"
          input={input}
          onChange={(value: string, sessionToken?: number) => {
            if (sessionToken != null && sessionToken !== sessionRef.current) return;
            setInput(value);
          }}
          on_send={(value: string) => {
            setSends((prev) => [...prev, value]);
            clearAndAdvanceSession();
            const newThreadKey = -Date.now();
            if (!oscillationEnabled) return;
            setComposerDraftKey(newThreadKey);
            timersRef.current.push(
              window.setTimeout(() => setComposerDraftKey(0), 80),
              window.setTimeout(() => setComposerDraftKey(newThreadKey), 220),
            );
          }}
          syncdb={fakeSyncdb}
          date={composerDraftKey}
          sessionToken={composerSession}
          autoGrowMaxHeight={220}
          style={{ background: "white" }}
        />
      </div>
    </FrameContext.Provider>
  );
}

function start() {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("missing #root");
  }
  ReactDOM.createRoot(root).render(<Harness />);
}

start();
