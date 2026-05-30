/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A single terminal frame.

import { Button } from "antd";
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
import { Tooltip } from "@cocalc/frontend/components";
import { set_buffer } from "@cocalc/frontend/copy-paste-buffer";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { effectiveTerminalColorScheme } from "@cocalc/frontend/project/workspaces/terminal-theme";
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
  const terminalLoadTokenRef = useRef(0);
  const nativeTouchTapRef = useRef<NativeTouchTap | null>(null);
  const [showMobileToolbar, setShowMobileToolbar] = useState(false);
  const resize = useResizeObserver({ ref: terminalDOMRef });
  const isMountedRef = useIsMountedRef();
  const student_project_functionality = useStudentProjectFunctionality(
    props.project_id,
  );
  const workspaceRecord = workspaces.resolveWorkspaceForPath(props.path);
  const terminalColorScheme = effectiveTerminalColorScheme(
    props.terminal,
    workspaceRecord,
  );

  useEffect(() => {
    return delete_terminal; // clean up on unmount
  }, []);

  useEffect(() => {
    if (terminalRef.current != null) {
      terminalRef.current.is_visible = props.is_visible;
    }
    // We *only* init the terminal if it is visible
    // or switches to being visible and was not initialized.
    // See https://github.com/sagemathinc/cocalc/issues/5133
    if (terminalRef.current != null || !props.is_visible) return;
    void init_terminal();
  }, [props.is_visible]);

  useEffect(() => {
    // yes, this can change!! -- see https://github.com/sagemathinc/cocalc/issues/3819
    if (terminalRef.current == null) return;
    delete_terminal();
    void init_terminal();
  }, [props.id]);

  useEffect(() => {
    if (props.is_current) {
      terminalRef.current?.focus();
    }
  }, [props.is_current]);

  useEffect(() => {
    terminalRef.current?.set_terminal_theme_override(
      workspaceRecord?.terminal_theme,
    );
  }, [workspaceRecord?.terminal_theme]);

  useEffect(() => {
    measureSize();
  }, [props.resize, resize]);

  function delete_terminal(): void {
    terminalLoadTokenRef.current += 1;
    if (terminalRef.current == null) return; // already deleted or never created
    terminalRef.current.element?.remove();
    terminalRef.current.is_visible = false;
    terminalRef.current = undefined;
    setShowMobileToolbar(false);
  }

  async function init_terminal(): Promise<void> {
    if (!props.is_visible) return;
    const node: any = terminalDOMRef.current;
    if (node == null) {
      // happens, e.g., when terminals are disabled.
      return;
    }
    const token = ++terminalLoadTokenRef.current;
    const terminal = await props.actions._get_terminal(
      props.id,
      node,
      workspaceRecord?.terminal_theme,
    );
    if (
      terminal == null ||
      !isMountedRef.current ||
      terminalLoadTokenRef.current !== token ||
      terminalDOMRef.current !== node
    ) {
      terminal?.element?.remove();
      if (terminal != null) {
        terminal.is_visible = false;
      }
      return;
    }
    terminalRef.current = terminal;
    terminal.is_visible = true;
    setShowMobileToolbar(terminal.usesNativeTouchSelection());
    set_font_size();
    measureSize();
    if (props.is_current) {
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
    if (terminalRef.current == null || !isMountedRef.current) {
      return;
    }
    if (terminalRef.current.getOption("fontSize") !== props.font_size) {
      terminalRef.current.set_font_size(props.font_size);
      measureSize();
    }
  }, 200);

  useEffect(set_font_size, [props.font_size]);

  function measureSize(): void {
    if (isMountedRef.current) {
      terminalRef.current?.measureSize();
    }
  }

  function focusTerminal(): void {
    props.onFocus?.();
    terminalRef.current?.focus();
  }

  function sendData(data: string): void {
    terminalRef.current?.conn_write(data);
  }

  function pasteData(text?: string): void {
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
