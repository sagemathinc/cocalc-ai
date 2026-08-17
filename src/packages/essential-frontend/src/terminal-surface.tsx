/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  terminalClient,
  type TerminalClient,
} from "@cocalc/conat/project/terminal";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { COLORS } from "@cocalc/util/theme";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { UltraliteSession } from "./session";
import { useEssentialTheme } from "./theme-context";
import type { ResolvedEssentialTheme } from "./theme";
import "./terminal-surface.css";
import {
  markUltraliteBackend,
  recordUltraliteFailure,
  recordUltraliteOutcome,
  recordUltraliteSurfaceReady,
} from "./telemetry";
import { InlineAlert, LoadingState, SurfaceHeader } from "./ui";
import { fullProjectUrl } from "./urls";

type ConnectionState =
  | "checking"
  | "idle"
  | "starting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "exited";

const SPAWN_TIMEOUT_MS = 15_000;
const DEFAULT_HISTORY_LIMIT = 128 * 1024;
const MAX_AUTO_RESPONSE_BUFFER = 4_096;
const MOBILE_TERMINAL_KEYS = [
  { data: "\u001b", label: "Esc", name: "Escape" },
  { data: "\t", label: "Tab", name: "Tab" },
  { data: "\u0003", label: "^C", name: "Control+C" },
  { data: "`", label: "`", name: "Backtick" },
  { data: "\u001b[D", label: "\u2190", name: "Left arrow" },
  { data: "\u001b[A", label: "\u2191", name: "Up arrow" },
  { data: "\u001b[B", label: "\u2193", name: "Down arrow" },
  { data: "\u001b[C", label: "\u2192", name: "Right arrow" },
];

export function terminalThemeFor(theme: ResolvedEssentialTheme): ITheme {
  if (theme === "dark") {
    return {
      background: COLORS.GRAY_DD,
      black: COLORS.GRAY_DD,
      blue: COLORS.BLUE_L,
      brightBlack: COLORS.GRAY,
      brightBlue: COLORS.BLUE_LL,
      brightCyan: COLORS.FEATURE_TEAL,
      brightGreen: COLORS.ANTD_GREEN,
      brightMagenta: COLORS.FEATURE_JULIA_PURPLE,
      brightRed: COLORS.ANTD_BG_RED_M,
      brightWhite: COLORS.TOP_BAR.ACTIVE,
      brightYellow: COLORS.YELL_L,
      cursor: COLORS.BLUE_L,
      cyan: COLORS.FEATURE_TEAL,
      foreground: COLORS.GRAY_LL,
      green: COLORS.ANTD_GREEN,
      magenta: COLORS.FEATURE_JULIA_PURPLE,
      red: COLORS.ANTD_BG_RED_M,
      selectionBackground: COLORS.BLUE_DD,
      white: COLORS.GRAY_LL,
      yellow: COLORS.YELL_L,
    };
  }
  return {
    background: COLORS.TOP_BAR.ACTIVE,
    black: COLORS.GRAY_DD,
    blue: COLORS.BLUE_DD,
    brightBlack: COLORS.GRAY_M,
    brightBlue: COLORS.BLUE_D,
    brightCyan: COLORS.FEATURE_TEAL,
    brightGreen: COLORS.ANTD_GREEN_D,
    brightMagenta: COLORS.FEATURE_JULIA_PURPLE,
    brightRed: COLORS.BS_RED,
    brightWhite: COLORS.GRAY_DD,
    brightYellow: COLORS.YELL_D,
    cursor: COLORS.BLUE_DD,
    cyan: COLORS.FEATURE_TEAL,
    foreground: COLORS.GRAY_DD,
    green: COLORS.ANTD_GREEN_D,
    magenta: COLORS.FEATURE_PURPLE,
    red: COLORS.FG_RED,
    selectionBackground: COLORS.BLUE_LLL,
    white: COLORS.GRAY_M,
    yellow: COLORS.YELL_D,
  };
}

export function extractTerminalAutoResponses(buffer: string): {
  remaining: string;
  responses: string[];
} {
  const responses: string[] = [];
  while (buffer.length > 0) {
    const escapeIndex = buffer.indexOf("\u001b");
    if (escapeIndex === -1) {
      buffer = "";
      break;
    }
    if (escapeIndex > 0) {
      buffer = buffer.slice(escapeIndex);
    }
    if (buffer.length < 2) break;

    const prefix = buffer[1];
    let consumed = 0;
    if (prefix === "[") {
      const match = buffer.match(/^\u001b\[[0-9:;<=>?]*[ -/]*[@-~]/);
      if (match) {
        consumed = match[0].length;
        responses.push(match[0]);
      }
    } else if (prefix === "]") {
      const bellIndex = buffer.indexOf("\u0007", 2);
      const stringTerminatorIndex = buffer.indexOf("\u001b\\", 2);
      let endIndex = -1;
      if (
        bellIndex !== -1 &&
        (stringTerminatorIndex === -1 || bellIndex < stringTerminatorIndex)
      ) {
        endIndex = bellIndex + 1;
      } else if (stringTerminatorIndex !== -1) {
        endIndex = stringTerminatorIndex + 2;
      }
      if (endIndex !== -1) {
        consumed = endIndex;
        responses.push(buffer.slice(0, endIndex));
      }
    } else if (prefix === "P" || prefix === "^" || prefix === "_") {
      const stringTerminatorIndex = buffer.indexOf("\u001b\\", 2);
      if (stringTerminatorIndex !== -1) {
        consumed = stringTerminatorIndex + 2;
        responses.push(buffer.slice(0, consumed));
      }
    } else {
      const charCode = prefix.charCodeAt(0);
      if (charCode >= 0x20 && charCode <= 0x2f) {
        if (buffer.length >= 3) {
          const match = buffer.match(/^\u001b[ -/]+[0-~]/);
          if (match) {
            consumed = match[0].length;
            responses.push(match[0]);
          }
        }
      } else if (charCode >= 0x40 && charCode <= 0x7e) {
        consumed = 2;
        responses.push(buffer.slice(0, consumed));
      }
    }
    if (consumed === 0) break;
    buffer = buffer.slice(consumed);
  }
  return { remaining: buffer, responses };
}

export function writeTerminalInput(
  terminal: TerminalClient | undefined,
  data: string,
  kind: "auto" | "user" = "user",
): void {
  if (terminal?.socket.state === "ready") {
    terminal.socket.write({ data, kind });
  }
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "checking":
      return "Checking project state";
    case "idle":
      return "Not connected";
    case "starting":
      return "Starting project";
    case "connecting":
      return "Connecting terminal";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Connection interrupted";
    case "exited":
      return "Shell exited";
  }
}

export default function TerminalSurface({
  project,
  session,
}: {
  project: AccountProjectListWindowRow;
  session: UltraliteSession;
}) {
  const { resolved: colorTheme } = useEssentialTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermTerminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const ptyRef = useRef<TerminalClient | undefined>(undefined);
  const connectGeneration = useRef(0);
  const autoResponseBuffer = useRef("");
  const historyReplayDepth = useRef(0);
  const programmaticUserInputDepth = useRef(0);
  const renderingOutput = useRef(0);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [projectRunning, setProjectRunning] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [historyOmitted, setHistoryOmitted] = useState(false);
  const autoConnectAttempted = useRef(false);
  const connectTerminalRef = useRef<() => Promise<void>>(async () => {});

  const sessionId = `ultralite-${session.accountId}`;

  const writeTerminalOutput = (data: string, fromHistory = false) => {
    const xterm = xtermRef.current;
    if (!xterm || !data) return;
    renderingOutput.current += 1;
    if (fromHistory) historyReplayDepth.current += 1;
    xterm.write(data, () => {
      setTimeout(() => {
        renderingOutput.current = Math.max(0, renderingOutput.current - 1);
        if (fromHistory) {
          historyReplayDepth.current = Math.max(
            0,
            historyReplayDepth.current - 1,
          );
        }
      }, 0);
    });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xterm = new XtermTerminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5_000,
      theme: terminalThemeFor(colorTheme),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    xtermRef.current = xterm;
    fitRef.current = fit;

    const fitAndResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const pty = ptyRef.current;
      if (!pty || pty.socket.state !== "ready") return;
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        if (xterm.cols > 0 && xterm.rows > 0) {
          void pty.resize({ cols: xterm.cols, rows: xterm.rows });
        }
      }, 80);
    };
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(host);
    const input = xterm.onData((data) => {
      if (
        renderingOutput.current === 0 ||
        programmaticUserInputDepth.current > 0
      ) {
        autoResponseBuffer.current = "";
        writeTerminalInput(ptyRef.current, data, "user");
        return;
      }
      if (historyReplayDepth.current > 0) {
        autoResponseBuffer.current = "";
        return;
      }
      if (
        !data.includes("\u001b") &&
        !autoResponseBuffer.current.includes("\u001b")
      ) {
        return;
      }
      autoResponseBuffer.current += data;
      if (autoResponseBuffer.current.length > MAX_AUTO_RESPONSE_BUFFER) {
        autoResponseBuffer.current = autoResponseBuffer.current.slice(
          -MAX_AUTO_RESPONSE_BUFFER,
        );
      }
      const { remaining, responses } = extractTerminalAutoResponses(
        autoResponseBuffer.current,
      );
      autoResponseBuffer.current = remaining;
      for (const response of responses) {
        writeTerminalInput(ptyRef.current, response, "auto");
      }
    });
    const key = xterm.onKey(({ key }) => {
      if (renderingOutput.current > 0) {
        writeTerminalInput(ptyRef.current, key, "user");
      }
    });
    fitAndResize();

    return () => {
      connectGeneration.current += 1;
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      observer.disconnect();
      input.dispose();
      key.dispose();
      ptyRef.current?.close();
      ptyRef.current = undefined;
      xterm.dispose();
      autoResponseBuffer.current = "";
      historyReplayDepth.current = 0;
      programmaticUserInputDepth.current = 0;
      renderingOutput.current = 0;
      xtermRef.current = undefined;
      fitRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (xterm) xterm.options.theme = terminalThemeFor(colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    let active = true;
    autoConnectAttempted.current = false;
    const check = async () => {
      markUltraliteBackend("terminal", "start");
      try {
        const state = await session.getProjectState(project.project_id);
        if (!active) return;
        const running = state.state === "running";
        setProjectRunning(running);
        setConnection("idle");
        markUltraliteBackend("terminal", "end");
        recordUltraliteSurfaceReady("terminal");
      } catch (err) {
        if (!active) return;
        markUltraliteBackend("terminal", "end");
        recordUltraliteFailure("terminal", err);
        setConnection("idle");
        setError(err instanceof Error ? err.message : `${err}`);
      }
    };
    void check();
    return () => {
      active = false;
    };
  }, [project.project_id, session]);

  useEffect(() => {
    if (
      projectRunning &&
      connection === "idle" &&
      !autoConnectAttempted.current
    ) {
      autoConnectAttempted.current = true;
      void connectTerminalRef.current();
    }
  }, [connection, projectRunning]);

  const disconnect = () => {
    connectGeneration.current += 1;
    ptyRef.current?.close();
    ptyRef.current = undefined;
    setConnection("idle");
    setProgress(undefined);
    setHistoryOmitted(false);
  };

  const sendMobileKey = (data: string) => {
    writeTerminalInput(ptyRef.current, data, "user");
    xtermRef.current?.focus();
  };

  const pasteFromClipboard = async () => {
    const xterm = xtermRef.current;
    if (!xterm || !connected) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      programmaticUserInputDepth.current += 1;
      try {
        xterm.paste(text);
      } finally {
        programmaticUserInputDepth.current = Math.max(
          0,
          programmaticUserInputDepth.current - 1,
        );
      }
      xterm.focus();
    } catch {
      xterm.focus();
      setError(
        "Clipboard access was denied. Focus the terminal and use the system Paste command instead.",
      );
    }
  };

  const connectTerminal = async () => {
    if (["starting", "connecting", "connected"].includes(connection)) return;
    const generation = ++connectGeneration.current;
    let backendTimingActive = false;
    const finishBackendTiming = () => {
      if (!backendTimingActive) return;
      markUltraliteBackend("terminal", "end");
      backendTimingActive = false;
    };
    setError(undefined);
    setProgress(undefined);
    try {
      const state = await session.getProjectState(project.project_id);
      if (state.error) throw new Error(state.error);
      if (state.state !== "running") {
        if (
          !window.confirm(
            "Start this project and open a terminal? Project compute charges may apply.",
          )
        ) {
          return;
        }
        markUltraliteBackend("terminal", "start");
        backendTimingActive = true;
        setConnection("starting");
        await session.ensureProjectRunning(project.project_id, setProgress);
        if (generation !== connectGeneration.current) {
          finishBackendTiming();
          return;
        }
        setProjectRunning(true);
      }
      setConnection("connecting");
      setProgress("Opening a direct connection to the project host...");
      if (!backendTimingActive) {
        markUltraliteBackend("terminal", "start");
        backendTimingActive = true;
      }
      ptyRef.current?.close();
      const lease = await session.openProjectHost(
        project.project_id,
        project.host_id!,
      );
      const terminal = terminalClient({
        client: lease.client,
        getSize: () => {
          const xterm = xtermRef.current;
          return xterm && xterm.cols > 0 && xterm.rows > 0
            ? { cols: xterm.cols, rows: xterm.rows }
            : undefined;
        },
        project_id: project.project_id,
        reconnection: true,
      });
      if (generation !== connectGeneration.current) {
        terminal.close();
        finishBackendTiming();
        return;
      }
      ptyRef.current = terminal;
      terminal.socket.on("data", (data) => {
        if (generation === connectGeneration.current) {
          writeTerminalOutput(typeof data === "string" ? data : `${data}`);
        }
      });
      terminal.socket.on("disconnected", () => {
        if (generation === connectGeneration.current) {
          setConnection("disconnected");
        }
      });
      terminal.socket.on("closed", () => {
        if (generation === connectGeneration.current) {
          setConnection("disconnected");
        }
      });
      terminal.socket.on("recovered", () => {
        if (generation === connectGeneration.current) {
          setConnection("connected");
          setProgress(undefined);
        }
      });
      terminal.on("exit", () => {
        if (generation !== connectGeneration.current) return;
        writeTerminalOutput("\r\n[Shell exited]\r\n");
        setConnection("exited");
      });
      const history = await terminal.spawn("bash", [], {
        cwd: "/home/user",
        env0: {
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
        },
        id: sessionId,
        historyLimit: DEFAULT_HISTORY_LIMIT,
        timeout: SPAWN_TIMEOUT_MS,
      });
      if (generation !== connectGeneration.current) {
        terminal.close();
        finishBackendTiming();
        return;
      }
      if (history) {
        xtermRef.current?.reset();
        if (terminal.historyOmitted) {
          writeTerminalOutput(
            "\r\n[Older terminal output omitted. Use Load more history to retrieve it.]\r\n",
            true,
          );
        }
        writeTerminalOutput(history, true);
      }
      setHistoryOmitted(terminal.historyOmitted);
      try {
        fitRef.current?.fit();
      } catch {
        // A zero-sized host will be fitted by ResizeObserver when visible.
      }
      if (xtermRef.current?.cols && xtermRef.current.rows) {
        await terminal.resize({
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        });
      }
      finishBackendTiming();
      recordUltraliteOutcome("terminal", "terminal_connect");
      setConnection("connected");
      setProgress(undefined);
      xtermRef.current?.focus();
    } catch (err) {
      if (generation !== connectGeneration.current) return;
      finishBackendTiming();
      recordUltraliteFailure("terminal", err);
      ptyRef.current?.close();
      ptyRef.current = undefined;
      setConnection("disconnected");
      setProgress(undefined);
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };
  connectTerminalRef.current = connectTerminal;

  const loadFullHistory = async () => {
    const terminal = ptyRef.current;
    if (!terminal || terminal.socket.state !== "ready") return;
    setError(undefined);
    setProgress("Loading retained terminal history...");
    try {
      const history = await terminal.history(sessionId);
      xtermRef.current?.reset();
      if (history) writeTerminalOutput(history, true);
      setHistoryOmitted(false);
      setProgress(undefined);
      xtermRef.current?.focus();
    } catch (err) {
      setProgress(undefined);
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };

  const resetDisplay = () => {
    xtermRef.current?.reset();
    autoResponseBuffer.current = "";
    xtermRef.current?.focus();
  };

  const busy =
    connection === "checking" ||
    connection === "starting" ||
    connection === "connecting";
  const connected = connection === "connected";

  return (
    <main className="ul-page ul-terminal-page" id="main-content">
      <SurfaceHeader
        actions={
          <>
            {connected ? (
              <>
                {historyOmitted ? (
                  <button
                    className="ul-button ul-button-secondary"
                    onClick={() => void loadFullHistory()}
                    type="button"
                  >
                    Load more history
                  </button>
                ) : null}
                <button
                  className="ul-button ul-button-secondary"
                  onClick={resetDisplay}
                  type="button"
                >
                  Reset display
                </button>
                <button
                  className="ul-button ul-button-secondary"
                  onClick={disconnect}
                  type="button"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                className="ul-button"
                disabled={busy}
                onClick={() => void connectTerminal()}
                type="button"
              >
                {connection === "starting"
                  ? "Starting project..."
                  : connection === "connecting"
                    ? "Connecting..."
                    : connection === "exited"
                      ? "Restart shell"
                      : "Connect terminal"}
              </button>
            )}
            <a
              className="ul-link-button ul-link-button-subtle"
              data-ul-full-cocalc
              href={fullProjectUrl({ projectId: project.project_id })}
            >
              Full CoCalc
            </a>
          </>
        }
        eyebrow="Project compute"
        title="Terminal"
      />
      {!projectRunning && connection === "idle" ? (
        <InlineAlert>
          This project is stopped. Viewing this page does not start compute;
          connecting will ask before starting the project.
        </InlineAlert>
      ) : null}
      {projectRunning &&
      (connection === "checking" || connection === "idle") ? (
        <InlineAlert>
          Connecting to the retained project terminal...
        </InlineAlert>
      ) : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {busy ? (
        <LoadingState label={progress ?? connectionLabel(connection)} />
      ) : null}
      <div className="ul-terminal-meta" role="status" aria-live="polite">
        {connectionLabel(connection)}. The shell session is retained when this
        browser disconnects.
      </div>
      {connected ? (
        <div
          aria-label="Mobile terminal controls"
          className="ul-terminal-mobile-toolbar"
          onTouchStart={(event) => event.stopPropagation()}
          role="toolbar"
        >
          <button
            aria-label="Paste"
            onClick={() => void pasteFromClipboard()}
            title="Paste"
            type="button"
          >
            Paste
          </button>
          {MOBILE_TERMINAL_KEYS.map(({ data, label, name }) => (
            <button
              aria-label={name}
              key={name}
              onClick={() => sendMobileKey(data)}
              title={name}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        aria-label="Project terminal"
        className="ul-terminal-host"
        onClick={() => xtermRef.current?.focus()}
        ref={hostRef}
        role="application"
      />
      <p className="ul-muted">
        Terminal input and output travel directly between this browser and the
        project host. Use the browser or operating-system copy and paste
        shortcuts.
      </p>
    </main>
  );
}
