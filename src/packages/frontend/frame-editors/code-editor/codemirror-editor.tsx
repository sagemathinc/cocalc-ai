/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*

The code defines a React component called CodemirrorEditor that wraps a single
instance of the codemirror text editor. It also defines several functions for
initializing and updating the codemirror editor, using useEffect hooks to
trigger actions when certain props change. This manages the state of a single
codemirror editor instance mainly for use in a frame tree.
*/

import * as CodeMirror from "codemirror";
import { InputNumber, Modal, Slider, Switch } from "antd";
import { Map, Set } from "immutable";
import {
  CSS,
  React,
  Rendered,
  useEffect,
  useIsMountedRef,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { initFold, saveFold } from "@cocalc/frontend/codemirror/util";
import { Cursors } from "@cocalc/frontend/jupyter/cursors";
import { debounce, isEqual, throttle } from "lodash";
import { cm_options } from "../codemirror/cm-options";
import { get_state, set_state } from "../codemirror/codemirror-state";
import { init_style_hacks } from "../codemirror/util";
import { Path } from "../frame-tree/path";
import { EditorState } from "../frame-tree/types";
import { Actions } from "./actions";
import { GutterMarkers } from "./codemirror-gutter-markers";
import { SAVE_DEBOUNCE_MS } from "./const";
import { get_linked_doc, has_doc, set_doc } from "./doc";
import { AccountState } from "../../account/types";
import { attachSyncListeners } from "./cm-adapter";
import {
  clampCodeMirrorMinimapWidth,
  CODEMIRROR_MINIMAP_MAX_WIDTH,
  CODEMIRROR_MINIMAP_MIN_WIDTH,
  CODEMIRROR_MINIMAP_OPEN_SETTINGS_EVENT,
  CODEMIRROR_MINIMAP_SETTINGS_CHANGED_EVENT,
  readCodeMirrorMinimapSettings,
  setCodeMirrorMinimapEnabled,
  setCodeMirrorMinimapWidth,
} from "./minimap-settings";

const STYLE: CSS = {
  width: "100%",
  overflow: "auto",
  // marginbottom: "1ex",
  // minheight: "2em",
  border: "0px",
  background: "#fff",
} as const;

const CODEMIRROR_MINIMAP_MAX_TRACK_HEIGHT = 32_000;
const CODEMIRROR_MINIMAP_MAX_SAMPLED_LINES = 8_000;
const CODEMIRROR_MINIMAP_BASE_LINE_SCALE = 1.45;

const CODEMIRROR_MINIMAP_TOKEN_RE =
  /(#.*$)|(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b(?:abstract|and|as|assert|async|await|break|case|catch|class|const|continue|def|default|del|elif|else|enum|except|export|extends|False|finally|for|from|function|global|if|implements|import|in|interface|is|lambda|let|new|None|nonlocal|not|null|or|package|pass|private|protected|public|raise|return|static|switch|this|throw|True|try|type|typeof|var|void|while|with|yield)\b)/g;

function getCodeMirrorMinimapTextMetrics(width: number): {
  fontSize: number;
  lineHeight: number;
  leftPadding: number;
  rightPadding: number;
} {
  if (width >= 190) {
    return { fontSize: 8.2, lineHeight: 9.2, leftPadding: 5, rightPadding: 5 };
  }
  if (width >= 160) {
    return { fontSize: 7.2, lineHeight: 8.2, leftPadding: 5, rightPadding: 5 };
  }
  if (width >= 132) {
    return { fontSize: 6.2, lineHeight: 7.2, leftPadding: 5, rightPadding: 5 };
  }
  if (width >= 108) {
    return { fontSize: 5.2, lineHeight: 6.2, leftPadding: 4, rightPadding: 4 };
  }
  if (width >= 84) {
    return { fontSize: 4.4, lineHeight: 5.4, leftPadding: 4, rightPadding: 4 };
  }
  return { fontSize: 3.9, lineHeight: 4.8, leftPadding: 3, rightPadding: 3 };
}

function drawCodeMirrorMinimapTextLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  charWidth: number,
  maxChars: number,
): void {
  const line = text.slice(0, maxChars);
  if (line.length === 0) return;
  ctx.fillStyle = "rgba(15,23,42,0.9)";
  ctx.fillText(line, x, y);

  CODEMIRROR_MINIMAP_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = CODEMIRROR_MINIMAP_TOKEN_RE.exec(line);
  while (match != null) {
    let color = "";
    if (match[1] || match[2]) {
      color = "rgba(21,128,61,0.96)";
    } else if (match[3]) {
      color = "rgba(180,83,9,0.96)";
    } else if (match[4]) {
      color = "rgba(37,99,235,0.96)";
    } else if (match[5]) {
      color = "rgba(79,70,229,0.96)";
    }
    if (color.length > 0) {
      const index = match.index ?? 0;
      ctx.fillStyle = color;
      ctx.fillText(match[0], x + index * charWidth, y);
    }
    match = CODEMIRROR_MINIMAP_TOKEN_RE.exec(line);
  }
}

interface CodeMirrorMinimapProps {
  cm: CodeMirror.Editor;
  isCurrent: boolean;
}

const CodeMirrorMinimap: React.FC<CodeMirrorMinimapProps> = React.memo(
  ({ cm, isCurrent }: CodeMirrorMinimapProps) => {
    const [minimapSettings, setMinimapSettings] = useState(() =>
      readCodeMirrorMinimapSettings(),
    );
    const [showMinimapSettingsModal, setShowMinimapSettingsModal] = useState(false);
    const [minimapDraftEnabled, setMinimapDraftEnabled] = useState(
      minimapSettings.enabled,
    );
    const [minimapDraftWidth, setMinimapDraftWidth] = useState(
      minimapSettings.width,
    );
    const minimapEnabled = minimapSettings.enabled;

    const railRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawRafRef = useRef<number | null>(null);
    const viewportRafRef = useRef<number | null>(null);

    const drawNow = () => {
      const scroller = cm.getScrollerElement() as HTMLElement | null;
      const rail = railRef.current;
      const track = trackRef.current;
      const canvas = canvasRef.current;
      if (scroller == null || rail == null || track == null || canvas == null) return;

      const lineCount = Math.max(1, cm.lineCount());
      const cssWidth = Math.max(1, track.clientWidth || rail.clientWidth);
      const metrics = getCodeMirrorMinimapTextMetrics(cssWidth);
      const lineScale = Math.max(1.5, metrics.lineHeight);
      const railHeight = Math.max(160, scroller.clientHeight - 10);
      // Keep short files compact; expanding them to rail height makes rows look
      // unnaturally far apart.
      const naturalTrackHeight = Math.max(
        24,
        lineCount * Math.max(CODEMIRROR_MINIMAP_BASE_LINE_SCALE, lineScale),
      );
      const trackHeight = Math.max(
        1,
        Math.min(CODEMIRROR_MINIMAP_MAX_TRACK_HEIGHT, naturalTrackHeight),
      );
      track.style.height = `${trackHeight}px`;
      rail.style.height = `${railHeight}px`;

      const cssHeight = Math.max(1, trackHeight);
      const dpr =
        typeof window === "undefined"
          ? 1
          : Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
      const targetHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;

      const ctx = canvas.getContext("2d");
      if (ctx == null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      ctx.fillStyle = "rgba(248,250,252,0.96)";
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      ctx.font = `${metrics.fontSize}px Menlo, Monaco, "Courier New", monospace`;
      ctx.textBaseline = "top";
      ctx.imageSmoothingEnabled = false;
      const charWidth = Math.max(1, ctx.measureText("M").width);
      const maxChars = Math.max(
        8,
        Math.floor((cssWidth - metrics.leftPadding - metrics.rightPadding) / charWidth),
      );

      const scrollInfo = cm.getScrollInfo();
      const editorContentHeight = Math.max(1, scrollInfo.height);
      const firstLine = cm.firstLine();
      const lastLine = cm.lastLine();
      const sampledRows = Math.max(
        1,
        Math.min(
          lineCount,
          CODEMIRROR_MINIMAP_MAX_SAMPLED_LINES,
          Math.ceil(cssHeight / Math.max(1, metrics.lineHeight * 0.85)),
        ),
      );
      const rowHeight = cssHeight / sampledRows;
      let lastDrawnLineNo: number | null = null;
      for (let i = 0; i < sampledRows; i += 1) {
        const y = i * rowHeight;
        const editorY = (y / Math.max(1, cssHeight)) * editorContentHeight;
        const lineNo = Math.min(
          lastLine,
          Math.max(firstLine, cm.lineAtHeight(editorY, "local")),
        );
        if (lineNo === lastDrawnLineNo) continue;
        lastDrawnLineNo = lineNo;
        const text = cm.getLine(lineNo) ?? "";
        drawCodeMirrorMinimapTextLine(
          ctx,
          text,
          metrics.leftPadding,
          y,
          charWidth,
          maxChars,
        );
      }

      const currentLine = cm.getDoc().getCursor().line;
      const currentLineTopPx = Math.max(0, cm.heightAtLine(currentLine, "local"));
      const currentLineBottomPx =
        currentLine + 1 < lineCount
          ? Math.max(currentLineTopPx + 1, cm.heightAtLine(currentLine + 1, "local"))
          : editorContentHeight;
      const currentY = Math.max(
        0,
        Math.min(cssHeight, (currentLineTopPx / editorContentHeight) * cssHeight),
      );
      const currentH = Math.max(
        1.5,
        ((currentLineBottomPx - currentLineTopPx) / editorContentHeight) * cssHeight,
      );
      ctx.fillStyle = "rgba(59,130,246,0.28)";
      ctx.fillRect(0, currentY, cssWidth, currentH);
    };

    const updateViewportNow = () => {
      const scroller = cm.getScrollerElement() as HTMLElement | null;
      const rail = railRef.current;
      const scroll = scrollRef.current;
      const track = trackRef.current;
      const viewport = viewportRef.current;
      if (
        scroller == null ||
        rail == null ||
        scroll == null ||
        track == null ||
        viewport == null
      ) {
        return;
      }

      const railHeight = Math.max(1, rail.clientHeight);
      const contentHeight = Math.max(1, track.scrollHeight);
      const scrollInfo = cm.getScrollInfo();
      const editorContentHeight = Math.max(1, scrollInfo.height);
      const editorClientHeight = Math.max(1, scrollInfo.clientHeight);
      const maxEditorScroll = Math.max(1, editorContentHeight - editorClientHeight);
      const clampedEditorScroll = Math.min(
        Math.max(0, scrollInfo.top),
        maxEditorScroll,
      );
      const editorRatio = clampedEditorScroll / maxEditorScroll;

      const maxMiniScroll = Math.max(0, contentHeight - railHeight);
      const miniScrollTop = editorRatio * maxMiniScroll;
      scroll.scrollTop = miniScrollTop;

      const viewportTopInTrack =
        (clampedEditorScroll / editorContentHeight) * contentHeight;
      const viewportHeightInTrack = Math.min(
        contentHeight,
        (editorClientHeight / editorContentHeight) * contentHeight,
      );
      const thumbHeight = Math.min(railHeight, viewportHeightInTrack);
      const thumbTop = Math.min(
        Math.max(0, viewportTopInTrack - miniScrollTop),
        Math.max(0, railHeight - thumbHeight),
      );
      viewport.style.top = `${thumbTop}px`;
      viewport.style.height = `${thumbHeight}px`;
    };

    const scheduleDraw = () => {
      if (typeof window === "undefined") {
        drawNow();
        updateViewportNow();
        return;
      }
      if (drawRafRef.current != null) return;
      drawRafRef.current = window.requestAnimationFrame(() => {
        drawRafRef.current = null;
        drawNow();
        updateViewportNow();
      });
    };

    const scheduleViewport = () => {
      if (typeof window === "undefined") {
        updateViewportNow();
        return;
      }
      if (viewportRafRef.current != null) return;
      viewportRafRef.current = window.requestAnimationFrame(() => {
        viewportRafRef.current = null;
        updateViewportNow();
      });
    };

    useEffect(() => {
      if (typeof window === "undefined") return;
      const syncSettings = () =>
        setMinimapSettings(readCodeMirrorMinimapSettings());
      const onWindowOpenMinimapSettings = () => {
        if (!isCurrent) return;
        const current = readCodeMirrorMinimapSettings();
        setMinimapSettings(current);
        setMinimapDraftEnabled(current.enabled);
        setMinimapDraftWidth(current.width);
        setShowMinimapSettingsModal(true);
      };
      window.addEventListener(
        CODEMIRROR_MINIMAP_SETTINGS_CHANGED_EVENT,
        syncSettings,
      );
      window.addEventListener(
        CODEMIRROR_MINIMAP_OPEN_SETTINGS_EVENT,
        onWindowOpenMinimapSettings,
      );
      return () => {
        window.removeEventListener(
          CODEMIRROR_MINIMAP_SETTINGS_CHANGED_EVENT,
          syncSettings,
        );
        window.removeEventListener(
          CODEMIRROR_MINIMAP_OPEN_SETTINGS_EVENT,
          onWindowOpenMinimapSettings,
        );
      };
    }, [isCurrent]);

    useEffect(() => {
      setMinimapDraftEnabled(minimapSettings.enabled);
      setMinimapDraftWidth(minimapSettings.width);
    }, [minimapSettings.enabled, minimapSettings.width]);

    useEffect(() => {
      if (!minimapEnabled) return;
      if (typeof window === "undefined") {
        drawNow();
        updateViewportNow();
        return;
      }
      const raf = window.requestAnimationFrame(() => {
        cm.refresh();
        drawNow();
        updateViewportNow();
      });
      return () => window.cancelAnimationFrame(raf);
    }, [cm, minimapEnabled, minimapSettings.width]);

    useEffect(() => {
      const onScroll = () => scheduleViewport();
      const onChange = throttle(() => scheduleDraw(), 120, {
        leading: true,
        trailing: true,
      });
      const onCursorActivity = throttle(() => scheduleDraw(), 120, {
        leading: true,
        trailing: true,
      });
      const onRefresh = () => scheduleDraw();

      cm.on("scroll", onScroll as any);
      cm.on("change", onChange as any);
      cm.on("cursorActivity", onCursorActivity as any);
      cm.on("refresh", onRefresh as any);
      cm.refresh();
      scheduleDraw();
      scheduleViewport();

      return () => {
        cm.off("scroll", onScroll as any);
        cm.off("change", onChange as any);
        cm.off("cursorActivity", onCursorActivity as any);
        cm.off("refresh", onRefresh as any);
        onChange.cancel();
        onCursorActivity.cancel();
        if (typeof window !== "undefined") {
          if (drawRafRef.current != null) {
            window.cancelAnimationFrame(drawRafRef.current);
            drawRafRef.current = null;
          }
          if (viewportRafRef.current != null) {
            window.cancelAnimationFrame(viewportRafRef.current);
            viewportRafRef.current = null;
          }
        }
      };
    }, [cm]);

    const onRailMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
      const scroller = cm.getScrollerElement() as HTMLElement | null;
      const rail = railRef.current;
      const scroll = scrollRef.current;
      const track = trackRef.current;
      if (scroller == null || rail == null || scroll == null || track == null) return;
      const rect = rail.getBoundingClientRect();
      if (rect.height <= 0) return;
      const y = Math.min(Math.max(0, e.clientY - rect.top), rect.height);
      const yContent = Math.max(0, Math.min(track.scrollHeight, scroll.scrollTop + y));
      const ratio = yContent / Math.max(1, track.scrollHeight);
      const maxEditorScroll = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      cm.scrollTo(null, ratio * maxEditorScroll);
      scheduleViewport();
      e.preventDefault();
    };

    const closeMinimapSettingsModal = () => {
      setShowMinimapSettingsModal(false);
      setMinimapDraftEnabled(minimapSettings.enabled);
      setMinimapDraftWidth(minimapSettings.width);
    };

    const applyMinimapSettings = () => {
      setCodeMirrorMinimapEnabled(minimapDraftEnabled);
      setCodeMirrorMinimapWidth(minimapDraftWidth);
      setShowMinimapSettingsModal(false);
    };

    const settingsModal = (
      <Modal
        title="Code Minimap"
        open={showMinimapSettingsModal}
        okText="Apply"
        onOk={applyMinimapSettings}
        onCancel={closeMinimapSettingsModal}
      >
        <div style={{ display: "grid", rowGap: "14px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>Show minimap</span>
            <Switch
              checked={minimapDraftEnabled}
              onChange={(checked) => setMinimapDraftEnabled(checked)}
            />
          </div>
          <div style={{ display: "grid", rowGap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Minimap width</span>
              <InputNumber
                min={CODEMIRROR_MINIMAP_MIN_WIDTH}
                max={CODEMIRROR_MINIMAP_MAX_WIDTH}
                value={minimapDraftWidth}
                onChange={(value) => {
                  if (typeof value !== "number" || !Number.isFinite(value)) return;
                  setMinimapDraftWidth(clampCodeMirrorMinimapWidth(value));
                }}
              />
            </div>
            <Slider
              min={CODEMIRROR_MINIMAP_MIN_WIDTH}
              max={CODEMIRROR_MINIMAP_MAX_WIDTH}
              value={minimapDraftWidth}
              onChange={(value) =>
                setMinimapDraftWidth(clampCodeMirrorMinimapWidth(Number(value)))
              }
            />
          </div>
        </div>
      </Modal>
    );

    if (!minimapEnabled) return settingsModal;

    return (
      <>
        <div
          style={{
            width: `${minimapSettings.width}px`,
            flex: `0 0 ${minimapSettings.width}px`,
            marginLeft: "8px",
            marginRight: "6px",
            display: "flex",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            ref={railRef}
            onMouseDown={onRailMouseDown}
            style={{
              position: "relative",
              width: "100%",
              borderRadius: "4px",
              background: "rgba(255,255,255,0.92)",
              border: "1px solid rgba(148,163,184,0.68)",
              cursor: "pointer",
              overflow: "hidden",
            }}
          >
            <div
              ref={scrollRef}
              style={{
                position: "absolute",
                inset: 0,
                overflowY: "auto",
                overflowX: "hidden",
                // Keep the scrollbar in a dedicated gutter, not over the text.
                scrollbarGutter: "stable",
                boxSizing: "border-box",
              }}
            >
              <div
                ref={trackRef}
                style={{
                  position: "relative",
                  width: "100%",
                  height: "100%",
                }}
              >
                <canvas
                  ref={canvasRef}
                  style={{
                    display: "block",
                    width: "100%",
                    height: "100%",
                  }}
                />
              </div>
            </div>
            <div
              ref={viewportRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                height: "10px",
                border: "1px solid rgba(37,99,235,0.75)",
                background: "rgba(59,130,246,0.12)",
                borderRadius: "3px",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>
        {settingsModal}
      </>
    );
  },
);

export interface Props {
  id: string;
  actions: any;
  path: string;
  // Optional path used only for syntax highlighting mode detection.
  mode_path?: string;
  project_id: string;
  font_size: number;
  cursors?: Map<string, any>;
  editor_state: EditorState;
  read_only: boolean;
  is_current: boolean;
  // value if defined, use this static value and editor is read-only
  value?: string | (() => string);
  misspelled_words?: Set<string> | string; // **or** show these words as not spelled correctly
  resize: number;
  gutters?: string[];
  gutter_markers?: Map<string, any>;
  editor_settings: AccountState["editor_settings"];
  is_subframe?: boolean;
  placeholder?: string;
}

export const CodemirrorEditor: React.FC<Props> = React.memo((props: Props) => {
  const [has_cm, set_has_cm] = useState<boolean>(false);

  const cmRef = useRef<CodeMirror.Editor | undefined>(undefined);
  const propsRef = useRef<Props>(props);
  propsRef.current = props;
  const styleActiveLineRef = useRef<boolean>(false);
  const textareaRef = useRef<any>(null);
  const divRef = useRef<any>(null);
  const isMountedRef = useIsMountedRef();
  const detachSyncListenersRef = useRef<(() => void) | null>(null);

  function editor_actions(): Actions | undefined {
    if (props.is_subframe && props.actions != null) {
      // in this case props.actions is the frame tree actions, not the actions for the particular file.
      const actions = props.actions.get_code_editor(props.id)?.get_actions();
      if (actions == null) return;
      // The actions we just got are for the frame with given id.  It's possible
      // (e.g., see #5779) that the frame id has not changed, but the actions have
      // changed to be for a different file.  If this is the case, return null:
      if (actions.path != props.path) return;
      return actions;
    } else {
      // in this case props.actions is the actions for the particular file we're editing.
      return props.actions;
    }
  }

  useEffect(() => {
    cm_destroy();
    init_codemirror(props);
    return () => {
      // clean up because unmounting.
      if (cmRef.current != null) {
        save_editor_state(cmRef.current);
        const actions = editor_actions();
        if (actions != null) {
          // We can't just use save_syncstring(), since if this is
          // the last editor, then editor_actions()._cm may already be empty.
          editor_actions()?.set_value(cmRef.current.getValue());
          editor_actions()?.syncstring_commit();
        }
        cm_destroy();
      }
    };
  }, [props.path]);

  useEffect(cm_update_font_size, [props.font_size]);

  useEffect(() => {
    if (cmRef.current == null) return;
    if (typeof props.value !== "function") return;
    // Live editors are synchronized through sync/merge actions; mirroring
    // string-valued Redux snapshots here can clobber fresh local edits.
    // Function-valued props.value is used by static external views (e.g. time travel).
    const value = props.value() ?? "";
    if (cmRef.current.getValue() !== value) {
      cmRef.current.setValue(value);
    }
  }, [props.value]);

  useEffect(() => {
    if (cmRef.current != null) {
      cmRef.current.setOption("readOnly", props.read_only);
    }
  }, [props.read_only]);

  useEffect(cm_highlight_misspelled_words, [props.misspelled_words]);
  useEffect(cm_refresh, [props.resize]);
  useEffect(update_codemirror, [props.editor_settings]);

  function cm_refresh(): void {
    if (cmRef.current == null) return;
    cmRef.current.refresh();
  }

  function cm_highlight_misspelled_words(): void {
    const words = props.misspelled_words;
    if (cmRef.current == null || words == null) return;
    if (words == "browser") {
      // just ensure browser spellcheck is enabled
      cmRef.current.setOption("spellcheck", true);
      (cmRef.current as any).spellcheck_highlight([]);
      return;
    }
    if (words == "disabled") {
      // disabled
      cmRef.current.setOption("spellcheck", false);
      (cmRef.current as any).spellcheck_highlight([]);
      return;
    }
    if (typeof words == "string") {
      // not supported yet
      console.warn("unsupported words option", words);
      return;
    }
    cmRef.current.setOption("spellcheck", false);
    (cmRef.current as any).spellcheck_highlight(words.toJS());
  }

  const firstFontSizeUpdateRef = useRef<boolean>(true);
  function cm_update_font_size(): void {
    if (firstFontSizeUpdateRef.current) {
      // Do not update the first time, since that conflicts
      // with restoring the editor state.  See
      //   https://github.com/sagemathinc/cocalc/issues/5211
      firstFontSizeUpdateRef.current = false;
      return;
    }
    if (cmRef.current == null) return;
    // It's important to move the scroll position upon zooming -- otherwise the cursor line
    // move UP/DOWN after zoom, which is very annoying.
    const state = get_state(cmRef.current);
    // actual restore happens in next refresh cycle after render.
    if (state != null) set_state(cmRef.current, state);
  }

  function cm_undo(): void {
    editor_actions()?.undo(props.id);
  }

  function cm_redo(): void {
    editor_actions()?.redo(props.id);
  }

  function cm_destroy(): void {
    if (cmRef.current == null) {
      return;
    }
    detachSyncListenersRef.current?.();
    detachSyncListenersRef.current = null;
    // remove from DOM -- "Remove this from your tree to delete an editor instance."
    // NOTE: there is still potentially a reference to the cm in actions._cm[id];
    // that's how we can bring back this frame (with given id) very efficiently.
    $(cmRef.current.getWrapperElement()).remove();
    cmRef.current = undefined;
    set_has_cm(false);
  }

  // Save the UI state of the CM (not the actual content) -- scroll position, selections, etc.
  function save_editor_state(cm): void {
    const state = get_state(cm);
    if (state != null) {
      props.actions.save_editor_state(props.id, state);
    }
  }

  // Save the underlying syncstring content.
  function save_syncstring(): void {
    editor_actions()?.syncstring_commit();
  }

  async function init_codemirror(props: Props): Promise<void> {
    const node: HTMLTextAreaElement = textareaRef.current;
    if (node == null) {
      return;
    }

    const options: any = cm_options(
      props.mode_path ?? props.path,
      props.editor_settings,
      props.gutters,
      editor_actions(),
      props.actions,
      props.id,
    );
    if (options == null) throw Error("bug"); // make typescript happy.

    // we will explicitly enable and disable styleActiveLine depending focus
    styleActiveLineRef.current = options.styleActiveLine;
    options.styleActiveLine = false;

    if (props.read_only) {
      options.readOnly = true;
    }

    if (options.extraKeys == null) {
      options.extraKeys = {};
    }

    options.extraKeys["Tab"] = tab_key;
    options.extraKeys["Cmd-/"] = "toggleComment";
    options.extraKeys["Ctrl-/"] = "toggleComment";

    const cm: CodeMirror.Editor = (editor_actions() as any)._cm[props.id];
    if (cm != undefined) {
      // Reuse existing codemirror editor, rather
      // than creating a new one -- faster and preserves
      // state such as code folding.
      if (!cmRef.current) {
        cmRef.current = cm;
        if (!node.parentNode) {
          // this never happens, but is needed for typescript.
          return;
        }
        node.parentNode.insertBefore(cm.getWrapperElement(), node.nextSibling);
        update_codemirror(options);
      }
    } else {
      cmRef.current = CodeMirror.fromTextArea(node, options);
      // We explicitly re-add all the extraKeys due to weird precedence.
      cmRef.current.addKeyMap(options.extraKeys);
      init_new_codemirror();
    }

    if (props.editor_state != null) {
      set_state(cmRef.current, props.editor_state.toJS() as any);
    }

    cm_highlight_misspelled_words();

    set_has_cm(true);

    if (props.is_current) {
      cmRef.current.focus();
    }
    cmRef.current.setOption("readOnly", props.read_only);
    cm_refresh();

    const foldKey = `${props.path}\\${props.id}`;
    const saveFoldState = () => {
      if (cmRef.current != null) {
        saveFold(cmRef.current, foldKey);
      }
    };
    cmRef.current.on("fold" as any, saveFoldState);
    cmRef.current.on("unfold" as any, saveFoldState);
    initFold(cmRef.current, foldKey);
  }

  function init_new_codemirror(): void {
    const cm = cmRef.current;
    if (cm == null) return;
    (cm as any)._actions = editor_actions();

    if (props.value == null) {
      if (!has_doc(props.project_id, props.path)) {
        // save it to cache so can be used by other components/editors
        set_doc(props.project_id, props.path, cm);
      } else {
        // has it already, so use that.
        cm.swapDoc(get_linked_doc(props.project_id, props.path));
      }
    } else {
      const value =
        typeof props.value == "function" ? props.value() ?? "" : props.value;
      cm.setValue(value);
    }

    const throttled_save_editor_state = throttle(save_editor_state, 150);
    cm.on("scroll", () => throttled_save_editor_state(cm));
    init_style_hacks(cm);

    editor_actions()?.set_cm(props.id, cm);

    // After this only stuff that we use for live editing.
    const save_syncstring_debounce = debounce(
      save_syncstring,
      SAVE_DEBOUNCE_MS,
      { leading: false, trailing: true },
    );

    cm.on("beforeChange", (_, changeObj) => {
      if (changeObj.origin == "paste") {
        // See https://github.com/sagemathinc/cocalc/issues/5110
        save_syncstring();
      }
    });

    cm.on("change", save_syncstring_debounce);

    detachSyncListenersRef.current = attachSyncListeners(cm, {
      onChangeDebounced: save_syncstring_debounce,
      onExitUndo: () => editor_actions()?.exit_undo_mode(),
    });

    cm.on("focus", () => {
      if (!isMountedRef.current) return;
      props.actions.set_active_id(props.id);
      if (styleActiveLineRef.current && cm) {
        // any because the typing doesn't recognize extensions
        cm.setOption("styleActiveLine" as any, true);
      }
    });

    cm.on("blur", () => {
      if (styleActiveLineRef.current && cm) {
        cm.setOption("styleActiveLine" as any, false);
      }
      if (cm?.state.vim != null) {
        // We exit insert mode whenever blurring the editor.  This isn't
        // necessarily the *right* thing to do with vim; however, not doing
        // this seriously confuses the editor state.  See
        //    https://github.com/sagemathinc/cocalc/issues/5324
        // @ts-ignore
        CodeMirror.Vim?.exitInsertMode(cm);
      }
      save_syncstring();
    });

    cm.on("cursorActivity", (cm) => {
      if (!propsRef.current.is_current) {
        // not in focus, so any cursor movement is not to be broadcast.
        return;
      }
      // side_effect is whether or not the cursor move is being
      // caused by an  external setValueNoJump, so just a side
      // effect of something another user did.
      const side_effect = (cm as any)._setValueNoJump;
      if (side_effect) {
        // cursor movement is a side effect of upstream change, so ignore.
        return;
      }
      const locs = cm
        .getDoc()
        .listSelections()
        .map((c) => ({ x: c.anchor.ch, y: c.anchor.line }));

      const actions = editor_actions();
      actions?.set_cursor_locs(locs);
      throttled_save_editor_state(cm);
    });

    // replace undo/redo by our sync aware versions
    (cm as any).undo = cm_undo;
    (cm as any).redo = cm_redo;
  }

  function update_codemirror(options?): void {
    if (cmRef.current == null) return;
    if (!options) {
      options = cm_options(
        props.mode_path ?? props.path,
        props.editor_settings,
        props.gutters,
        editor_actions(),
        props.actions,
        props.id,
      );
    }
    const cm = cmRef.current;
    for (const key in options) {
      const opt = options[key];
      if (!isEqual(cm.options[key], opt)) {
        if (opt != null) {
          cm.setOption(key as any, opt);
          if (key == "extraKeys") {
            cm.addKeyMap(options.extraKeys);
          }
        }
      }
    }
  }

  function tab_nothing_selected(): void {
    if (cmRef.current == null) return;
    const cursor = cmRef.current.getDoc().getCursor();
    if (
      cursor.ch === 0 ||
      /\s/.test(cmRef.current.getDoc().getLine(cursor.line)[cursor.ch - 1])
    ) {
      // whitespace before cursor -- just do normal tab
      if (cmRef.current.options.indentWithTabs) {
        (CodeMirror.commands as any).defaultTab(cmRef.current);
      } else {
        (cmRef.current as any).tab_as_space();
      }
      return;
    }
    // Do completion at cursor.
    complete_at_cursor();
  }

  function tab_key(): void {
    if (cmRef.current == null) return;
    if ((cmRef.current as any).somethingSelected()) {
      (CodeMirror as any).commands.defaultTab(cmRef.current);
    } else {
      tab_nothing_selected();
    }
  }

  // Do completion at the current cursor position -- this uses
  // the codemirror plugin, which can be configured with lots of
  // ways of completing -- see "show-hint.js" at
  // https://codemirror.net/doc/manual.html#addons
  function complete_at_cursor(): void {
    if (cmRef.current == null) return;
    cmRef.current.execCommand("autocomplete");
  }

  function render_cursors(): Rendered {
    if (props.cursors != null && cmRef.current != null && has_cm) {
      // Very important not to render without cm defined, because that renders
      // to static Codemirror instead.
      return <Cursors cursors={props.cursors} codemirror={cmRef.current} />;
    }
  }

  function render_gutter_markers(): Rendered {
    if (!has_cm || props.gutter_markers == null || cmRef.current == null) {
      return;
    }
    return (
      <GutterMarkers
        gutter_markers={props.gutter_markers}
        codemirror={cmRef.current}
        set_handle={(id, handle) =>
          props.actions._set_gutter_handle(id, handle)
        }
      />
    );
  }

  return (
    <div className="smc-vfill cocalc-editor-div" ref={divRef}>
      <Path
        project_id={props.project_id}
        path={props.path}
        is_current={props.is_current}
      />
      <div
        style={{
          ...STYLE,
          fontSize: `${props.font_size}px`,
          display: "flex",
          flexDirection: "row",
          alignItems: "stretch",
          minHeight: 0,
          overflow: "hidden",
        }}
        className="smc-vfill"
      >
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }} className="smc-vfill">
          {render_cursors()}
          {render_gutter_markers()}
          <textarea
            ref={textareaRef}
            style={{ display: "none" }}
            placeholder={props.placeholder}
          />
        </div>
        {has_cm && cmRef.current != null ? (
          <CodeMirrorMinimap cm={cmRef.current} isCurrent={props.is_current} />
        ) : null}
      </div>
    </div>
  );
});

// Needed e.g., for vim ":w" support; this is global,
// so be careful.
if ((CodeMirror as any).commands.save == null) {
  (CodeMirror as any).commands.save = (cm: any) => {
    const f = cm.cocalc_actions?.save;
    if (typeof f == "function") {
      f(true);
    }
  };
}
