import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { FrameContext, defaultFrameContext } from "../../frame-editors/frame-tree/frame-context";
import ChatInput from "../input";
import { ChatRoomComposer } from "../composer";

declare global {
  interface Window {
    __CHAT_COMPOSER_DEBUG?: boolean;
    __chatHarnessBootError?: string;
    __chatComposerTest?: {
      getInput: () => string;
      getSends: () => string[];
      setInputRaw: (value: string) => void;
      newChat: () => void;
      setOscillationEnabled: (enabled: boolean) => void;
      getSendButtonVisible: () => boolean;
      getSendButtonDisabled: () => boolean;
    };
  }
}

function InputHarness({ fixedMode = "markdown" }: { fixedMode?: "markdown" | "editor" }): React.JSX.Element {
  const [composerDraftKey, setComposerDraftKey] = useState<number>(0);
  const [composerSession, setComposerSession] = useState<number>(1);
  const [input, setInput] = useState<string>("");
  const [oscillationEnabled, setOscillationEnabled] = useState<boolean>(false);
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
      setInputRaw: (value: string) => {
        setInput(value);
      },
      newChat: () => {
        clearAndAdvanceSession();
        setComposerDraftKey(0);
      },
      setOscillationEnabled: (enabled: boolean) => {
        setOscillationEnabled(enabled);
      },
      getSendButtonVisible: () => false,
      getSendButtonDisabled: () => true,
    };
  }, [input, sends]);

  const cacheId = `chat-harness-draft-${composerDraftKey}`;
  const fakeSyncdb = useMemo(
    () =>
      ({
        set: () => undefined,
        commit: () => undefined,
        set_cursor_locs: () => undefined,
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
          fixedMode={fixedMode}
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

type FakeActions = {
  syncdb: { set: () => void; commit: () => void; set_cursor_locs: () => void };
  deleteDraft: (_draftKey: number) => void;
};

function ComposerHarness(): React.JSX.Element {
  const [composerDraftKey, setComposerDraftKey] = useState<number>(0);
  const [composerSession, setComposerSession] = useState<number>(1);
  const [input, setInput] = useState<string>("");
  const [oscillationEnabled, setOscillationEnabled] = useState<boolean>(false);
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

  const fakeActions: FakeActions = useMemo(
    () => ({
      syncdb: {
        set: () => undefined,
        commit: () => undefined,
        set_cursor_locs: () => undefined,
      },
      deleteDraft: () => undefined,
    }),
    [],
  );

  const hasInput = input.trim().length > 0;

  useEffect(() => {
    window.__CHAT_COMPOSER_DEBUG = true;
    window.__chatComposerTest = {
      getInput: () => input,
      getSends: () => sends,
      setInputRaw: (value: string) => {
        setInput(value);
      },
      newChat: () => {
        clearAndAdvanceSession();
        setComposerDraftKey(0);
      },
      setOscillationEnabled: (enabled: boolean) => {
        setOscillationEnabled(enabled);
      },
      getSendButtonVisible: () => {
        return (
          Array.from(document.querySelectorAll("button")).some(
            (btn) => (btn as HTMLButtonElement).innerText.trim() === "Send",
          ) ?? false
        );
      },
      getSendButtonDisabled: () => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (el) => (el as HTMLButtonElement).innerText.trim() === "Send",
        ) as HTMLButtonElement | undefined;
        return btn ? btn.disabled : true;
      },
    };
  }, [input, sends]);

  return (
    <FrameContext.Provider value={frameContext as any}>
      <div style={{ padding: 16, width: 760 }}>
        <h3>Chat Composer Harness</h3>
        <p style={{ color: "#666", marginTop: 0 }}>
          draftKey: <span data-testid="draft-key">{composerDraftKey}</span>, session:{" "}
          <span data-testid="session">{composerSession}</span>
        </p>
        <ChatRoomComposer
          actions={fakeActions as any}
          project_id="project-1"
          path="chat-harness.chat"
          fontSize={14}
          composerDraftKey={composerDraftKey}
          composerSession={composerSession}
          input={input}
          setInput={(value: string, token?: number) => {
            if (token != null && token !== sessionRef.current) return;
            setInput(value);
          }}
          on_send={(value?: string) => {
            const text = `${value ?? input}`.trim();
            if (!text) return;
            setSends((prev) => [...prev, text]);
            clearAndAdvanceSession();
            if (!oscillationEnabled) return;
            const newThreadKey = -Date.now();
            setComposerDraftKey(newThreadKey);
            timersRef.current.push(
              window.setTimeout(() => setComposerDraftKey(0), 80),
              window.setTimeout(() => setComposerDraftKey(newThreadKey), 220),
            );
          }}
          submitMentionsRef={{ current: undefined }}
          hasInput={hasInput}
          isSelectedThreadAI={false}
          combinedFeedSelected={false}
          composerTargetKey={null}
          threads={[]}
          selectedThread={null}
          onComposerTargetChange={() => undefined}
          onComposerFocusChange={() => undefined}
        />
      </div>
    </FrameContext.Provider>
  );
}

function Harness(): React.JSX.Element {
  const params =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const mode = params.get("mode") ?? "input";
  const editorMode = params.get("editorMode");
  if (editorMode === "markdown" || editorMode === "editor") {
    try {
      window.localStorage.setItem("markdown-editor-mode", editorMode);
    } catch {
      // ignore in harness
    }
  }
  if (mode === "composer") {
    return <ComposerHarness />;
  }
  return (
    <InputHarness
      fixedMode={editorMode === "editor" || editorMode === "markdown" ? editorMode : "markdown"}
    />
  );
}

function start() {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("missing #root");
  }
  window.__chatHarnessBootError = undefined;
  window.addEventListener("error", (event) => {
    window.__chatHarnessBootError = event.error?.message ?? event.message;
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    window.__chatHarnessBootError =
      typeof reason === "string" ? reason : reason?.message ?? String(reason);
  });
  ReactDOM.createRoot(root).render(<Harness />);
}

start();
