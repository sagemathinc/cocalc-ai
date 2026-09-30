/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A single terminal frame.

import { Button } from "antd";
import $ from "jquery";
import "@xterm/xterm/css/xterm.css";
import { Map } from "immutable";
import { throttle } from "lodash";
import {
  CSS,
  React,
  Rendered,
  useEffect,
  useIsMountedRef,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import {
  isLikelyStaleChunkError,
  reloadForFrontendBuild,
} from "@cocalc/frontend/app/frontend-build-monitor";
import { Tooltip } from "@cocalc/frontend/components";
import { getLogger } from "@cocalc/frontend/logger";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { set_buffer } from "@cocalc/frontend/copy-paste-buffer";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { effectiveTerminalColorScheme } from "@cocalc/frontend/project/workspaces/terminal-theme";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import { MobileTerminalToolbar } from "./mobile-terminal-toolbar";
import type { Terminal } from "./connected-terminal";
import { background_color } from "./themes";
import useResizeObserver from "use-resize-observer";

interface Props {
  actions: any;
  id: string;
  path: string;
  project_id: string;
  font_size: number;
  editor_state: any;
  is_current: boolean;
  terminal?: Map<string, any>;
  desc: Map<string, any>;
  resize: number;
  is_visible: boolean;
  tab_is_visible?: boolean;
  name: string;
  onFocus?: () => void;
}

const COMMAND_STYLE = {
  borderBottom: "1px solid grey",
  paddingLeft: "5px",
  background: "rgb(248, 248, 248)",
  height: "20px",
  overflow: "hidden",
} as CSS;

const LOAD_ERROR_STYLE = {
  padding: "8px",
  background: UI_COLORS.dangerBg,
  color: UI_COLORS.danger,
  borderBottom: `1px solid ${UI_COLORS.border}`,
} as CSS;

const logger = getLogger("terminal-editor");

interface NativeTouchTap {
  x: number;
  y: number;
  time: number;
}

const NATIVE_TOUCH_TAP_MAX_MS = 450;
const NATIVE_TOUCH_TAP_MAX_DISTANCE = 12;

export const TerminalFrame: React.FC<Props> = React.memo((props: Props) => {
  const { workspaces } = useProjectContext();
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const terminalDOMRef = useRef<any>(null);
  const terminalParentRef = useRef<HTMLElement | null>(null);
  const terminalLoadTokenRef = useRef(0);
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const nativeTouchTapRef = useRef<NativeTouchTap | null>(null);
  const [showMobileToolbar, setShowMobileToolbar] = useState(false);
  // Opening can fail (e.g., the terminal code chunk does not load). Without
  // this the frame stays blank with no way to recover but reloading the page.
  const [loadError, setLoadError] = useState<unknown>(undefined);
  const [manuallyRetried, setManuallyRetried] = useState(false);
  const resize = useResizeObserver({ ref: terminalDOMRef });
  const isMountedRef = useIsMountedRef();
  const student_project_functionality = useStudentProjectFunctionality(
    props.project_id,
  );
  const workspaceRecord = workspaces.resolveWorkspaceForPath(props.path);
  const { resolved } = useAppearance();
  const terminalColorScheme = effectiveTerminalColorScheme(
    props.terminal,
    workspaceRecord,
    resolved,
  );

  useEffect(() => {
    setShowMobileToolbar(false);
    setLoadError(undefined);
    setManuallyRetried(false);
    if (props.is_visible && props.tab_is_visible !== false)
      void init_terminal();
    return delete_terminal;
  }, [props.is_visible, props.tab_is_visible, props.actions, props.id]);

  function retryInitTerminal(): void {
    delete_terminal();
    setManuallyRetried(true);
    setLoadError(undefined);
    void init_terminal();
  }

  useEffect(() => {
    if (props.is_current && ownsTerminal()) {
      terminalRef.current?.focus();
    }
  }, [props.is_current]);

  useEffect(() => {
    if (!ownsTerminal()) return;
    terminalRef.current?.set_terminal_theme_override(
      workspaceRecord?.terminal_theme,
    );
  }, [workspaceRecord?.terminal_theme]);

  useEffect(() => {
    measureSize();
  }, [props.resize, resize]);

  function delete_terminal(): void {
    terminalLoadTokenRef.current += 1;
    if (
      terminalRef.current != null &&
      terminalRef.current.element?.parentElement === terminalParentRef.current
    ) {
      terminalRef.current.element.remove();
      terminalRef.current.is_visible = false;
    }
    terminalParentRef.current?.remove();
    terminalParentRef.current = null;
    terminalRef.current = undefined;
  }

  function ownsTerminal(): boolean {
    return (
      latestPropsRef.current.is_visible &&
      latestPropsRef.current.tab_is_visible !== false &&
      terminalRef.current != null &&
      terminalRef.current.element?.parentElement === terminalParentRef.current
    );
  }

  async function init_terminal(): Promise<void> {
    if (!props.is_visible || props.tab_is_visible === false) return;
    const container = terminalDOMRef.current;
    if (container == null) {
      // happens, e.g., when terminals are disabled.
      return;
    }
    // A distinct parent per request makes stale cleanup safe even if the same
    // view hides/reopens (or changes session) before an earlier load resolves.
    const node = document.createElement("div");
    node.className = "smc-vfill";
    container.appendChild(node);
    terminalParentRef.current = node;
    const token = ++terminalLoadTokenRef.current;
    const isCurrent = () =>
      isMountedRef.current &&
      terminalLoadTokenRef.current === token &&
      terminalDOMRef.current === container &&
      terminalParentRef.current === node &&
      latestPropsRef.current.is_visible &&
      latestPropsRef.current.tab_is_visible !== false &&
      latestPropsRef.current.id === props.id &&
      latestPropsRef.current.actions === props.actions;
    let terminal: Terminal | undefined;
    try {
      terminal = await props.actions._get_terminal(
        props.id,
        node,
        workspaceRecord?.terminal_theme,
        isCurrent,
      );
    } catch (err) {
      if (!isCurrent()) return;
      logger.warn("terminal: failed to open", {
        path: props.path,
        id: props.id,
        err,
      });
      setLoadError(err);
      return;
    }
    if (terminal == null && isCurrent()) {
      // Nothing superseded this view, yet no terminal was produced.
      logger.warn("terminal: open returned no terminal", {
        path: props.path,
        id: props.id,
        actionsClosed: props.actions?.isClosed?.(),
      });
      setLoadError(new Error("The terminal did not start."));
      return;
    }
    if (terminal == null || !isCurrent()) {
      // A later load/view may already own this shared terminal. Stale cleanup
      // must not remove that view's element or mark its live terminal hidden.
      if (terminal != null && terminal.element?.parentElement === node) {
        terminal.element.remove();
        terminal.is_visible = false;
      }
      return;
    }
    // Another live view may have claimed the shared terminal while we awaited.
    // It alone may update visibility/focus. A foreground transition reclaims it.
    if (terminal.element?.parentElement !== node) return;
    terminalRef.current = terminal;
    terminal.is_visible = true;
    setShowMobileToolbar(terminal.usesNativeTouchSelection());
    set_font_size();
    measureSize();
    if (latestPropsRef.current.is_current) {
      terminal.focus();
    }
    $(node).off("contextmenu");
    if (!terminal.usesNativeTouchSelection()) {
      // Get rid of the browser context menu, which makes no sense on a canvas.
      $(node).on("contextmenu.cocalc-terminal", function () {
        return false;
      });
    }

    // terminalRef.current.scroll_to_bottom();
  }

  const set_font_size = throttle(() => {
    if (
      !ownsTerminal() ||
      terminalRef.current == null ||
      !isMountedRef.current
    ) {
      return;
    }
    const fontSize = latestPropsRef.current.font_size;
    if (terminalRef.current.getOption("fontSize") !== fontSize) {
      terminalRef.current.set_font_size(fontSize);
      measureSize();
    }
  }, 200);

  useEffect(set_font_size, [props.font_size]);

  function measureSize(): void {
    if (isMountedRef.current && ownsTerminal()) {
      terminalRef.current?.measureSize();
    }
  }

  function focusTerminal(): void {
    if (!ownsTerminal()) return;
    props.onFocus?.();
    terminalRef.current?.focus();
  }

  function sendData(data: string): void {
    if (!ownsTerminal()) return;
    terminalRef.current?.conn_write(data);
  }

  function pasteData(text?: string): void {
    if (!ownsTerminal()) return;
    if (text != null) {
      set_buffer(text);
    }
    terminalRef.current?.paste();
  }

  function focusTerminalAfterDefault(): void {
    focusTerminal();
    requestAnimationFrame(focusTerminal);
    setTimeout(focusTerminal, 0);
  }

  function hasNativeSelection(): boolean {
    const selection = window.getSelection?.();
    return selection != null && !selection.isCollapsed;
  }

  function isNativeTouchRowsTarget(target: EventTarget | null): boolean {
    return (
      terminalRef.current?.usesNativeTouchSelection() === true &&
      target instanceof Element &&
      target.closest(".xterm-rows") != null
    );
  }

  function handleTouchStart(event: React.TouchEvent<HTMLDivElement>): void {
    if (!isNativeTouchRowsTarget(event.target) || event.touches.length !== 1) {
      nativeTouchTapRef.current = null;
      return;
    }
    const touch = event.touches[0];
    nativeTouchTapRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  }

  function handleTouchEnd(event: React.TouchEvent<HTMLDivElement>): void {
    const tap = nativeTouchTapRef.current;
    nativeTouchTapRef.current = null;
    if (
      tap == null ||
      !isNativeTouchRowsTarget(event.target) ||
      event.changedTouches.length !== 1
    ) {
      return;
    }
    const touch = event.changedTouches[0];
    const distance = Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y);
    if (
      Date.now() - tap.time > NATIVE_TOUCH_TAP_MAX_MS ||
      distance > NATIVE_TOUCH_TAP_MAX_DISTANCE ||
      hasNativeSelection()
    ) {
      return;
    }
    event.preventDefault();
    focusTerminal();
  }

  function render_command(): Rendered {
    const command = props.desc.get("command");
    if (!command || command.endsWith("bash")) return;
    const args: string[] = props.desc.get("args") ?? [];
    // Quote if args have spaces:
    for (let i = 0; i < args.length; i++) {
      if (/\s/.test(args[i])) {
        // has whitespace -- this is not bulletproof, since
        // args[i] could have a " in it. But this is just for
        // display purposes, so it doesn't have to be bulletproof.
        args[i] = `"${args[i]}"`;
      }
    }
    return (
      <div style={COMMAND_STYLE}>
        {command} {args.join(" ")}
        <Tooltip
          title={`Exit ${command} -- back to terminal`}
          placement="bottom"
        >
          <Button
            size="small"
            type="text"
            style={{ float: "right", paddingBottom: "2.5px" }}
            onClick={() => {
              props.actions.shell(props.id, { command: "bash" });
            }}
          >
            Exit
          </Button>
        </Tooltip>
      </div>
    );
  }

  function renderLoadError(): Rendered {
    const stale = isLikelyStaleChunkError(loadError);
    return (
      <div role="alert" style={LOAD_ERROR_STYLE}>
        {stale
          ? "Terminal code failed to load. Retry the terminal without reloading this page."
          : `Terminal failed to open: ${
              (loadError as any)?.message ?? `${loadError}`
            }`}
        <Button
          size="small"
          style={{ marginLeft: "8px" }}
          onClick={(event) => {
            event.stopPropagation();
            retryInitTerminal();
          }}
        >
          Retry
        </Button>
        {stale && manuallyRetried && (
          <Button
            size="small"
            style={{ marginLeft: "8px" }}
            onClick={(event) => {
              event.stopPropagation();
              reloadForFrontendBuild();
            }}
          >
            Reload page
          </Button>
        )}
      </div>
    );
  }

  if (student_project_functionality.disableTerminals) {
    return (
      <b style={{ margin: "auto", fontSize: "14pt", padding: "15px" }}>
        Terminals are currently disabled in this project. Please contact your
        instructor if you have questions.
      </b>
    );
  }

  const backgroundColor = background_color(terminalColorScheme);
  /* 4px padding is consistent with CodeMirror */

  return (
    <div className={"smc-vfill"} onFocusCapture={props.onFocus}>
      {render_command()}
      <div
        className={"smc-vfill"}
        style={{ backgroundColor, padding: "0 0 0 4px" }}
        onTouchCancel={() => {
          nativeTouchTapRef.current = null;
        }}
        onTouchEnd={handleTouchEnd}
        onTouchStart={handleTouchStart}
        onClick={(event) => {
          // Focus on click, since otherwise, clicking right outside term de-focusses,
          // which is confusing.
          if (
            terminalRef.current?.usesNativeTouchSelection() &&
            (event.target as Element).closest(".xterm-rows")
          ) {
            if (!hasNativeSelection()) {
              focusTerminalAfterDefault();
            }
            return;
          }
          focusTerminal();
        }}
      >
        {loadError != null && renderLoadError()}
        {showMobileToolbar && (
          <MobileTerminalToolbar
            onFocus={focusTerminal}
            onPaste={pasteData}
            onSendData={sendData}
          />
        )}
        <div className={"smc-vfill cocalc-xtermjs"} ref={terminalDOMRef} />
      </div>
    </div>
  );
});
