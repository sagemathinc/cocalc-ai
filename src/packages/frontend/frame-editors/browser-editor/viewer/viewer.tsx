/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The shared browser viewer: a browser window (tabs, address bar, who
// drives) around the screen of a browser running in the project, which an
// agent and humans use together.  Connected over conat like a terminal (see
// ./connection.ts), so only collaborators reach it, and only through
// CoCalc's own pages.

import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { SharedBrowserRunsOn } from "@cocalc/util/shared-browser";
import type {
  SharedBrowserState,
  SharedBrowserTab,
  ViewQuality,
} from "@cocalc/util/shared-browser-protocol";

import { type ConnectionStatus, SharedBrowserConnection } from "./connection";
import { useIcon } from "./icons";
import { isApple, nextZoom } from "./input";
import { BrowserScreen, type ScreenHost } from "./screen";
import { StartPage } from "./start-page";
import { installViewerCss } from "./styles";

export interface SharedBrowserRemote {
  runsOn: SharedBrowserRunsOn | null;
  connection: "connected" | "waiting";
  connectCommand: string | null;
}

export interface SharedBrowserControl {
  setRunsOn(value: SharedBrowserRunsOn): void;
}

export interface SharedBrowserViewerProps {
  project_id: string;
  appId: string;
  // The place showing it: "frame:<id>" (an editor frame), "card:<id>".
  view?: string;
  // The page around it draws the "waiting for your computer" panel.
  hostPanel?: boolean;
  // It shows the page (or a start page): the start screen can go.
  onReady?: () => void;
  // A small picture of it now and then, to start from next time.
  onPicture?: (picture: string) => void;
  // Where a .browser file's browser runs, and whether it is there.
  onRemote?: (remote: SharedBrowserRemote) => void;
  onAskAgent?: (text: string) => void;
  onShutdown?: () => void;
  onForget?: () => void;
  controlRef?: MutableRefObject<SharedBrowserControl | null>;
}

const QUALITY_KEY = "cocalc-browser-quality";

function loadQuality(): ViewQuality {
  try {
    const value = localStorage.getItem(QUALITY_KEY);
    if (value === "sharp" || value === "fast") return value;
  } catch {}
  return "balanced";
}

const preview = (state?: SharedBrowserState) => state?.runsOn === "computer";
const human = (state?: SharedBrowserState) =>
  state?.driver === "human" && !preview(state);

function blankTab(state?: SharedBrowserState): boolean {
  const tab = state?.tabs.find((t) => t.id === state.active);
  return !!tab && (!tab.url || tab.url === "about:blank");
}

export function SharedBrowserViewer(props: SharedBrowserViewerProps) {
  installViewerCss();
  const { project_id, appId, view, hostPanel } = props;
  const [state, setState] = useState<SharedBrowserState>();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [selection, setSelection] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [notDriving, setNotDriving] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [quality, setQuality] = useState<ViewQuality>(loadQuality);
  const [askedZoom, setAskedZoom] = useState<number | null>(null);
  const [connection, setConnection] = useState<SharedBrowserConnection | null>(
    null,
  );
  const [url, setUrl] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [filePath, setFilePath] = useState("");

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const screenRef = useRef<BrowserScreen | null>(null);
  const connectionRef = useRef<SharedBrowserConnection | null>(null);
  const stateRef = useRef<SharedBrowserState | undefined>(undefined);
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const propsRef = useRef(props);
  propsRef.current = props;
  const pointerRef = useRef({ x: 20, y: 20 });
  const zoomRef = useRef({ asked: 1, at: 0 });
  const readyRef = useRef(false);
  const pictureRef = useRef<{
    at: number;
    timer?: ReturnType<typeof setTimeout>;
  }>({
    at: 0,
  });
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const later = (name: string, ms: number, f: () => void) => {
    clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(f, ms);
  };

  const flash = useCallback((text: string) => {
    setHint(text);
    later("hint", 2500, () => setHint(null));
  }, []);

  const send = (msg: Parameters<SharedBrowserConnection["send"]>[0]) =>
    connectionRef.current?.send(msg);

  // Using the browser without driving does nothing: say why, right where
  // the user looked, with the way out.
  const showNotDriving = useCallback(() => {
    const current = stateRef.current;
    setNotDriving(
      preview(current)
        ? "This browser runs in Chrome on your computer: use that window. This is a preview."
        : current?.agents
          ? "The agent is driving this browser, so your clicks and typing are ignored."
          : "Take over to use this browser.",
    );
    later("notDriving", 5000, () => setNotDriving(null));
  }, []);

  const ready = () => {
    if (readyRef.current) return;
    readyRef.current = true;
    propsRef.current.onReady?.();
  };

  const postPicture = () => {
    const picture = pictureRef.current;
    clearTimeout(picture.timer);
    picture.timer = undefined;
    const current = stateRef.current;
    if (!current || blankTab(current) || preview(current)) return;
    const data = screenRef.current?.picture();
    if (!data) return;
    picture.at = Date.now();
    propsRef.current.onPicture?.(data);
  };
  const schedulePicture = () => {
    const picture = pictureRef.current;
    if (picture.timer || !propsRef.current.onPicture) return;
    picture.timer = setTimeout(
      postPicture,
      Math.max(0, picture.at + 5000 - Date.now()),
    );
  };

  const zoomStep = (direction: -1 | 0 | 1) => {
    const current = stateRef.current;
    if (!current || preview(current)) return;
    // Repeats (a held key, a pinch) step from what was asked, not yet shown.
    const from =
      Date.now() - zoomRef.current.at < 600
        ? zoomRef.current.asked
        : current.zoom || 1;
    const next = nextZoom(from, direction);
    zoomRef.current = { asked: next, at: Date.now() };
    setAskedZoom(next);
    send({ type: "zoom", zoom: next });
    flash(`Zoom ${Math.round(next * 100)}%`);
  };

  // The page copied something (its copy button): to the clipboard, or, where
  // that needs a click of the user's own (Safari), offer one.
  const pageCopied = (text: string) => {
    const screen = screenRef.current;
    if (!text || !screen) return;
    if (text === screen.lastCopy.text && Date.now() - screen.lastCopy.at < 3000)
      return;
    if (!document.hasFocus()) return;
    screen.lastCopy = { text, at: Date.now() };
    const offer = () => {
      setCopied(text);
      later("copied", 15000, () => setCopied(null));
    };
    if (navigator.clipboard?.writeText)
      navigator.clipboard.writeText(text).then(() => flash("Copied"), offer);
    else offer();
  };

  // The screen first: the connection tells it when it is live.
  useEffect(() => {
    const host: ScreenHost = {
      send: (msg) => connectionRef.current?.send(msg),
      state: () => stateRef.current,
      human: () => human(stateRef.current),
      quality: () => qualityRef.current,
      notDriving: showNotDriving,
      zoomStep: (direction) => zoomStep(direction),
      pointer: (p) => (pointerRef.current = p),
    };
    const screen = new BrowserScreen(
      stageRef.current!,
      canvasRef.current!,
      keysRef.current!,
      host,
    );
    screenRef.current = screen;
    const hidden = () => {
      if (document.hidden) postPicture();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      postPicture();
      document.removeEventListener("visibilitychange", hidden);
      screen.destroy();
      screenRef.current = null;
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    readyRef.current = false;
    const conn = new SharedBrowserConnection(project_id, appId, {
      view,
      client: webapp_client.browser_id,
      site: window.location.origin,
    });
    connectionRef.current = conn;
    setConnection(conn);
    let drawing: Promise<void> = Promise.resolve();
    conn.on("status", (value: ConnectionStatus) => {
      setStatus(value);
      if (value === "live") screenRef.current?.connected();
    });
    conn.on("state", (value: SharedBrowserState) => {
      stateRef.current = value;
      setState(value);
    });
    conn.on("selection", (text: string) => {
      setSelection(text);
      screenRef.current?.setSelection(text);
    });
    conn.on("copied", pageCopied);
    conn.on("error", (message: string) => flash(message));
    conn.on("frame", (bytes: Uint8Array, done: () => void) => {
      // In order, each drawn before it is acknowledged.
      drawing = drawing.then(async () => {
        try {
          const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
          screenRef.current?.drawFrame(bitmap);
          ready();
          schedulePicture();
        } catch {}
        done();
      });
    });
    return () => {
      conn.close();
      connectionRef.current = null;
    };
  }, [project_id, appId, view]);

  useEffect(() => {
    if (!props.controlRef) return;
    props.controlRef.current = {
      setRunsOn: (value) =>
        connectionRef.current?.send({ type: "runsOn", value }),
    };
    return () => {
      if (props.controlRef) props.controlRef.current = null;
    };
  }, [props.controlRef]);

  // What the page around it needs to know, and what follows from the state.
  useEffect(() => {
    if (!state) return;
    propsRef.current.onRemote?.({
      runsOn: state.runsOn,
      connection: state.connection,
      connectCommand: state.connectCommand,
    });
    if (state.connection === "waiting") screenRef.current?.clear();
    if (state.connection === "waiting" && state.runsOn === "computer") ready();
    if (
      state.zoom === zoomRef.current.asked ||
      Date.now() - zoomRef.current.at > 600
    )
      setAskedZoom(null);
  }, [state]);

  // A dialog or file chooser answered elsewhere (by the agent, another
  // viewer) leaves nothing behind for the next one.
  useEffect(() => {
    if (!state?.dialog) setPrompt(null);
    if (!state?.fileChooser) setFilePath("");
  }, [state?.dialog, state?.fileChooser]);

  const driving = human(state);
  const isPreview = preview(state);
  const showStart =
    !!state &&
    blankTab(state) &&
    !isPreview &&
    state.connection === "connected";
  useEffect(() => {
    if (showStart) ready();
  }, [showStart]);
  const active = state?.tabs.find((t) => t.id === state.active);
  const activeUrl = active && active.url !== "about:blank" ? active.url : "";
  const zoom = askedZoom ?? state?.zoom ?? 1;
  const waitingForComputer =
    state?.connection === "waiting" && state.runsOn === "computer";

  let driverClass = "";
  let driverMessage = "";
  let driverButton = "Take over";
  if (state) {
    driverClass = driving
      ? state.agentWaiting
        ? "cc-sbv-waiting"
        : ""
      : state.ask
        ? "cc-sbv-ask"
        : state.agents
          ? "cc-sbv-agent"
          : "";
    if (isPreview) {
      driverMessage =
        "Running in Chrome on your computer: use that window. This is a preview." +
        (state.driver === "human"
          ? " The agent waits until you hand back."
          : state.agents
            ? " The agent is using it."
            : "");
      driverButton =
        state.driver === "human" ? "Hand back to agent" : "Pause the agent";
    } else if (driving) {
      driverMessage = state.agentWaiting
        ? "You are driving. The agent is waiting to use the browser."
        : "You are driving." +
          (state.agents ? " The agent waits until you hand back." : "");
      driverButton = "Hand back to agent";
    } else {
      driverMessage = state.ask
        ? `The agent asks you to take over: ${state.ask.message}`
        : state.agents
          ? "The agent is driving."
          : "No agent connected. Take over to use the browser.";
    }
  }

  const go = (text: string) => {
    if (!human(stateRef.current)) {
      showNotDriving();
      return;
    }
    send({ type: "navigate", url: text });
    screenRef.current?.focus();
  };
  const navButton =
    (msg: Parameters<SharedBrowserConnection["send"]>[0]) => () =>
      human(stateRef.current) ? send(msg) : showNotDriving();

  const apple = isApple();
  const select = state?.select && driving ? state.select : null;
  const stageRect = stageRef.current?.getBoundingClientRect();

  return (
    <div className="cc-sbv">
      <div className="cc-sbv-tabs">
        {state?.tabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            active={tab.id === state.active}
            closable={driving}
            connection={connection}
            onShow={() => send({ type: "tab", id: tab.id })}
            onClose={() => send({ type: "closeTab", id: tab.id })}
          />
        ))}
        {driving && (
          <button
            className="cc-sbv-newtab"
            title="New tab"
            onClick={() => send({ type: "newTab" })}
          >
            +
          </button>
        )}
      </div>
      <div className="cc-sbv-nav">
        <button
          title="Back"
          className={driving ? "" : "cc-sbv-off"}
          onClick={navButton({ type: "history", delta: -1 })}
        >
          &#8592;
        </button>
        <button
          title="Forward"
          className={driving ? "" : "cc-sbv-off"}
          onClick={navButton({ type: "history", delta: 1 })}
        >
          &#8594;
        </button>
        <button
          title="Reload"
          className={driving ? "" : "cc-sbv-off"}
          onClick={navButton({ type: "reload" })}
        >
          &#8635;
        </button>
        <input
          className="cc-sbv-url"
          spellCheck={false}
          placeholder="Address or search"
          readOnly={!driving}
          value={url ?? activeUrl}
          onFocus={() => setUrl(activeUrl)}
          onBlur={() => setUrl(null)}
          onChange={(e) => setUrl(e.target.value)}
          onMouseDown={() => {
            if (!driving) showNotDriving();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              send({ type: "navigate", url: url ?? "" });
              screenRef.current?.focus();
            }
          }}
        />
        {state?.runsOn && (
          <select
            title="Where this browser runs"
            value={state.runsOn}
            onChange={(e) =>
              send({
                type: "runsOn",
                value: e.target.value as SharedBrowserRunsOn,
              })
            }
          >
            <option value="project">Runs in the project</option>
            <option value="computer">Runs on my computer</option>
          </select>
        )}
        {/* Zoom is the user's own Chrome's, on their computer. */}
        {!isPreview && (
          <span
            className={`cc-sbv-zoom${Math.abs(zoom - 1) > 0.001 ? " cc-sbv-zoomed" : ""}`}
          >
            <button
              title="Zoom out"
              onClick={() => {
                zoomStep(-1);
                screenRef.current?.focus();
              }}
            >
              &#8722;
            </button>
            <button
              className="cc-sbv-zoomlevel"
              title="Page zoom: click to reset to 100%"
              onClick={() => {
                zoomStep(0);
                screenRef.current?.focus();
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              title="Zoom in"
              onClick={() => {
                zoomStep(1);
                screenRef.current?.focus();
              }}
            >
              +
            </button>
          </span>
        )}
        {!isPreview && (
          <select
            title="Picture quality: Sharp sends crisp text once the page is still; Fast uses less bandwidth"
            value={quality}
            onChange={(e) => {
              const value = e.target.value as ViewQuality;
              try {
                localStorage.setItem(QUALITY_KEY, value);
              } catch {}
              setQuality(value);
              qualityRef.current = value;
              screenRef.current?.sendSize(true);
              screenRef.current?.focus();
            }}
          >
            <option value="sharp">Sharp</option>
            <option value="balanced">Balanced</option>
            <option value="fast">Fast</option>
          </select>
        )}
        {selection && !isPreview && (
          <button
            title="Copy the selected text to your clipboard"
            onClick={() => {
              screenRef.current?.copy(selection).then(
                () => flash("Copied"),
                () =>
                  flash(`Could not copy: press ${apple ? "Cmd" : "Ctrl"}+C`),
              );
              screenRef.current?.focus();
            }}
          >
            Copy
          </button>
        )}
        {/* On the user's computer, sign-ins are that Chrome's own business. */}
        {props.onForget && !isPreview && (
          <button
            title="Sign every web browser in this project out of all websites"
            onClick={props.onForget}
          >
            Forget sign-ins
          </button>
        )}
        {props.onShutdown && (
          <button
            className="cc-sbv-shutdown"
            title="Shut down this browser (agents cannot use it until it is started again)"
            onClick={props.onShutdown}
          >
            Shut down
          </button>
        )}
      </div>
      <div className={`cc-sbv-driver ${driverClass}`}>
        <span className="cc-sbv-msg">{driverMessage}</span>
        {state && (
          <button
            onClick={() =>
              send({ type: state.driver === "human" ? "handback" : "takeover" })
            }
          >
            {driverButton}
          </button>
        )}
      </div>
      <div className="cc-sbv-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className={`cc-sbv-screen${driving ? "" : " cc-sbv-view-only"}`}
        />
        <textarea
          ref={keysRef}
          className="cc-sbv-keys"
          tabIndex={-1}
          aria-hidden="true"
          inputMode="none"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {showStart && connection && (
          <StartPage
            connection={connection}
            name={state?.title || "Web browser"}
            driving={driving}
            canRunOnComputer={!!state?.runsOn}
            go={go}
            onAskAgent={props.onAskAgent}
            flash={flash}
          />
        )}
        {hint && <div className="cc-sbv-hint">{hint}</div>}
        {notDriving && (
          <div className="cc-sbv-overlay cc-sbv-notdriving">
            <p>{notDriving}</p>
            {!isPreview && (
              <button
                onClick={() => {
                  setNotDriving(null);
                  send({ type: "takeover" });
                  screenRef.current?.focus();
                }}
              >
                Take over
              </button>
            )}
          </div>
        )}
        {waitingForComputer && !hostPanel && (
          <div className="cc-sbv-overlay cc-sbv-waiting">
            <p>
              <b>Waiting for your computer.</b> This browser runs in Chrome on
              your computer, so sites see your network and your logins. Run this
              there (it needs the CoCalc CLI); a Chrome window opens, and stays
              connected while it runs:
            </p>
            <pre>{state?.connectCommand ?? ""}</pre>
            <div className="cc-sbv-row">
              <button
                onClick={() => send({ type: "runsOn", value: "project" })}
              >
                Run it in the project instead
              </button>
              <button
                className="cc-sbv-primary"
                onClick={() => {
                  const text = stateRef.current?.connectCommand ?? "";
                  if (navigator.clipboard)
                    navigator.clipboard.writeText(text).then(
                      () =>
                        flash("Copied. Run it in a terminal on your computer."),
                      () => flash("Select the command and copy it."),
                    );
                  else flash("Select the command and copy it.");
                }}
              >
                Copy command
              </button>
            </div>
          </div>
        )}
        {state?.dialog && driving && (
          <div className="cc-sbv-overlay cc-sbv-dialog">
            <pre>{state.dialog.message}</pre>
            {state.dialog.type === "prompt" && (
              <input
                value={prompt ?? state.dialog.defaultPrompt ?? ""}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
            <div className="cc-sbv-row">
              {state.dialog.type !== "alert" && (
                <button
                  onClick={() => {
                    send({ type: "dialog", accept: false });
                    setPrompt(null);
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => {
                  send({
                    type: "dialog",
                    accept: true,
                    promptText:
                      prompt ?? state.dialog?.defaultPrompt ?? undefined,
                  });
                  setPrompt(null);
                }}
              >
                OK
              </button>
            </div>
          </div>
        )}
        {select && (
          <SelectPopup
            select={select}
            left={Math.min(
              pointerRef.current.x,
              (stageRect?.width ?? 400) - 180,
            )}
            top={Math.min(
              pointerRef.current.y + 8,
              (stageRect?.height ?? 300) - 80,
            )}
            onPick={(index) => send({ type: "select", index })}
          />
        )}
        {state?.fileChooser && driving && (
          <div className="cc-sbv-overlay cc-sbv-filechooser">
            <div style={{ marginBottom: 6 }}>
              Upload a project file (path relative to your home directory):
            </div>
            <input
              placeholder="e.g. Documents/report.pdf"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="cc-sbv-row">
              <button
                onClick={() => {
                  send({ type: "file", paths: [] });
                  setFilePath("");
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const value = filePath.trim();
                  send({
                    type: "file",
                    paths: value ? value.split(",").map((s) => s.trim()) : [],
                  });
                  setFilePath("");
                }}
              >
                Upload
              </button>
            </div>
          </div>
        )}
        {copied && (
          <div className="cc-sbv-overlay cc-sbv-copied">
            <p>The page copied text.</p>
            <div className="cc-sbv-row">
              <button
                onClick={() => {
                  setCopied(null);
                  screenRef.current?.focus();
                }}
              >
                Dismiss
              </button>
              <button
                onClick={() => {
                  const text = copied;
                  setCopied(null);
                  screenRef.current?.copy(text).then(
                    () => flash("Copied"),
                    () => flash("Could not copy"),
                  );
                  screenRef.current?.focus();
                }}
              >
                Copy it
              </button>
            </div>
          </div>
        )}
        <div className="cc-sbv-status">
          {status === "live"
            ? "live"
            : status === "connecting"
              ? "connecting..."
              : "reconnecting..."}
        </div>
      </div>
    </div>
  );
}

function Tab({
  tab,
  active,
  closable,
  connection,
  onShow,
  onClose,
}: {
  tab: SharedBrowserTab;
  active: boolean;
  closable: boolean;
  connection: SharedBrowserConnection | null;
  onShow: () => void;
  onClose: () => void;
}) {
  const icon = useIcon(connection, tab.icon);
  const blank = !tab.url || tab.url === "about:blank";
  return (
    <div
      className={`cc-sbv-tab${active ? " cc-sbv-active" : ""}`}
      title={blank ? "New tab" : tab.url}
      onClick={onShow}
    >
      {icon && <img src={icon} alt="" />}
      <span>{blank ? "New tab" : tab.title || tab.url}</span>
      {closable && (
        <button
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          &times;
        </button>
      )}
    </div>
  );
}

function SelectPopup({
  select,
  left,
  top,
  onPick,
}: {
  select: NonNullable<SharedBrowserState["select"]>;
  left: number;
  top: number;
  onPick: (index: number) => void;
}) {
  const items: React.ReactNode[] = [];
  let group: string | undefined;
  select.options.forEach((option, i) => {
    if (option.group && option.group !== group) {
      group = option.group;
      items.push(
        <div key={`g${i}`} className="cc-sbv-grp">
          {group}
        </div>,
      );
    }
    items.push(
      <div
        key={i}
        className={`${i === select.selected ? "cc-sbv-sel " : ""}${option.disabled ? "cc-sbv-dis" : ""}`}
        onClick={option.disabled ? undefined : () => onPick(i)}
      >
        {option.label}
      </div>,
    );
  });
  return (
    <div
      className="cc-sbv-overlay cc-sbv-select"
      style={{ left: Math.max(0, left), top: Math.max(0, top) }}
    >
      {items}
    </div>
  );
}
