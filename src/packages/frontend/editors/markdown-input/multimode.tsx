/*
Edit with either plain text input **or** WYSIWYG slate-based input.
*/

import { Popover, Radio } from "antd";
import { fromJS } from "immutable";
import LRU from "lru-cache";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";
import { COLORS } from "@cocalc/util/theme";
import { MarkdownTextAdapter, SlateRichTextAdapter } from "./adapters";
import { BLURED_STYLE, FOCUSED_STYLE } from "./component";
import type {
  MarkdownPosition,
  Mode,
  MultiMarkdownInputProps,
  SelectionController,
} from "./types";

// NOTE: on mobile there is very little suppport for "editor" = "slate", but
// very good support for "markdown", hence the default below.

interface MultimodeState {
  mode?: Mode;
  markdown?: any;
  editor?: any;
}

const multimodeStateCache = new LRU<string, MultimodeState>({ max: 500 });

// markdown uses codemirror
// editor uses slate.  TODO: this should be "text", not "editor".  Oops.
// UI equivalent:
// editor = "Text" = Slate/wysiwyg
// markdown = "Markdown"
const Modes = ["markdown", "editor"] as const;

const LOCAL_STORAGE_KEY = "markdown-editor-mode";

function getLocalStorageMode(): Mode | undefined {
  const m = get_local_storage(LOCAL_STORAGE_KEY);
  if (typeof m === "string" && Modes.includes(m as any)) {
    return m as Mode;
  }
}

export default function MultiMarkdownInput({
  autoFocus,
  cacheId,
  cmOptions,
  compact,
  cursors,
  defaultMode,
  dirtyRef,
  editBarStyle,
  editorDivRef,
  enableMentions,
  enableUpload = true,
  extraHelp,
  fixedMode,
  fontSize,
  autoGrowMaxHeight,
  getValueRef,
  height = "auto",
  autoGrow,
  hideHelp,
  hideModeSwitch,
  isFocused,
  minimal,
  modeSwitchStyle,
  noVfill,
  onBlur,
  onChange,
  onCursorBottom,
  onCursors,
  onCursorTop,
  onFocus,
  onModeChange,
  onRedo,
  onSave,
  onShiftEnter,
  onUndo,
  onUploadEnd,
  onUploadStart,
  overflowEllipsis = true,
  placeholder,
  refresh,
  registerEditor,
  saveDebounceMs = SAVE_DEBOUNCE_MS,
  style,
  submitMentionsRef,
  unregisterEditor,
  value,
  controlRef,
  preserveBlankLines = true,
  disableBlockEditor = true,
  slateExternalMultilinePasteAsCodeBlock = false,
}: MultiMarkdownInputProps) {
  const {
    isFocused: isFocusedFrame,
    isVisible,
    project_id,
    path,
  } = useFrameContext();

  // We use refs for shiftEnter and onChange to be absolutely
  // 100% certain that if either of these functions is changed,
  // then the new function is used, even if the components
  // implementing our markdown editor mess up somehow and hang on.
  const onShiftEnterRef = useRef<any>(onShiftEnter);
  useEffect(() => {
    onShiftEnterRef.current = onShiftEnter;
  }, [onShiftEnter]);
  const onChangeRef = useRef<any>(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const activeCacheIdRef = useRef<string | undefined>(cacheId);
  const activeModeRef = useRef<Mode>("markdown");
  const reportedModeRef = useRef<Mode | null>(null);
  const mountedRef = useRef<boolean>(true);

  const editBar2 = useRef<React.JSX.Element | undefined>(undefined);

  const isAutoGrow = autoGrow ?? height === "auto";
  const internalControlRef = useRef<any>(null);
  const slateControlRef = controlRef ?? internalControlRef;
  const pendingModeSelectionRef = useRef<{
    to: Mode;
    pos: { line: number; ch: number };
  } | null>(null);

  const getKey = () => `${project_id}${path}:${cacheId}`;

  function getCache() {
    return cacheId == null ? undefined : multimodeStateCache.get(getKey());
  }

  const [mode, setMode0] = useState<Mode>(
    fixedMode ??
      getCache()?.mode ??
      defaultMode ??
      getLocalStorageMode() ??
      (IS_MOBILE ? "markdown" : "editor"),
  );

  const [editBarPopover, setEditBarPopover] = useState<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep active callback identity synchronous with render. If we wait for
  // useEffect, stale editor callbacks can fire in-between and pass guards.
  activeCacheIdRef.current = cacheId;
  activeModeRef.current = mode;

  function isActiveCallback(sourceMode: Mode): boolean {
    if (!mountedRef.current) {
      return false;
    }
    const activeCacheId = activeCacheIdRef.current;
    const activeMode = activeModeRef.current;
    if (cacheId !== activeCacheId || sourceMode !== activeMode) {
      return false;
    }
    return true;
  }

  useEffect(() => {
    if (reportedModeRef.current === mode) {
      return;
    }
    reportedModeRef.current = mode;
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  const setMode = (nextMode: Mode) => {
    if (activeModeRef.current === nextMode) {
      return;
    }
    set_local_storage(LOCAL_STORAGE_KEY, nextMode);
    setMode0(nextMode);
    if (cacheId !== undefined) {
      multimodeStateCache.set(`${project_id}${path}:${cacheId}`, {
        ...getCache(),
        mode: nextMode,
      });
    }
  };
  const [focused, setFocused] = useState<boolean>(!!autoFocus);
  const internalInteractionRef = useRef<"mode-switch" | null>(null);

  function beginModeSwitchInteraction() {
    internalInteractionRef.current = "mode-switch";
  }

  function endModeSwitchInteraction() {
    if (internalInteractionRef.current === "mode-switch") {
      internalInteractionRef.current = null;
    }
  }

  function shouldSuppressBlur() {
    return internalInteractionRef.current != null;
  }

  const cursorsMap = useMemo(() => {
    return cursors == null ? undefined : fromJS(cursors);
  }, [cursors]);

  const selectionRef = useRef<{
    getSelection: Function;
    setSelection: Function;
  } | null>(null) as MutableRefObject<SelectionController | null>;

  const applyMarkdownSelection = (pos: MarkdownPosition) => {
    const selection = selectionRef.current;
    if (selection?.setSelection == null) return false;
    selection.setSelection([{ anchor: pos, head: pos }]);
    return true;
  };

  useEffect(() => {
    const pending = pendingModeSelectionRef.current;
    if (!pending || pending.to !== mode) return;
    if (mode === "editor") {
      let attempts = 0;
      const tryApply = () => {
        attempts += 1;
        const applied =
          slateControlRef.current?.setSelectionFromMarkdownPosition?.(
            pending.pos,
          ) ?? false;
        if (applied) {
          pendingModeSelectionRef.current = null;
          return;
        }
        if (attempts < 5) {
          setTimeout(tryApply, 30);
        }
      };
      tryApply();
      return;
    }
    if (mode === "markdown") {
      let attempts = 0;
      const tryApply = () => {
        attempts += 1;
        if (applyMarkdownSelection(pending.pos)) {
          pendingModeSelectionRef.current = null;
          return;
        }
        if (attempts < 5) {
          setTimeout(tryApply, 30);
        }
      };
      tryApply();
    }
  }, [mode, slateControlRef]);

  useEffect(() => {
    if (cacheId == null) {
      return;
    }
    const cache = getCache();
    if (cache?.[mode] != null && selectionRef.current != null) {
      // restore selection on mount.
      try {
        selectionRef.current.setSelection(cache?.[mode]);
      } catch (_err) {
        // it might just be that the document isn't initialized yet
        setTimeout(() => {
          try {
            selectionRef.current?.setSelection(cache?.[mode]);
          } catch (_err2) {
            //  console.warn(_err2); // definitely don't need this.
            // This is expected to fail, since the selection from last
            // use will be invalid now if another user changed the
            // document, etc., or you did in a different mode, possibly.
          }
        }, 100);
      }
    }
    return () => {
      if (selectionRef.current == null || cacheId == null) {
        return;
      }
      const selection = selectionRef.current.getSelection();
      multimodeStateCache.set(getKey(), {
        ...getCache(),
        [mode]: selection,
      });
    };
  }, [mode]);

  function toggleEditBarPopover() {
    setEditBarPopover(!editBarPopover);
  }

  function renderEditBarEllipsis() {
    return (
      <span style={{ fontWeight: 400 }}>
        {"\u22EF"}
        <Popover
          open={isFocusedFrame && isVisible && editBarPopover}
          content={
            <div style={{ display: "flex" }}>
              {editBar2.current}
              <Icon
                onClick={() => setEditBarPopover(false)}
                name="times"
                style={{
                  color: COLORS.GRAY_M,
                  marginTop: "5px",
                }}
              />
            </div>
          }
        />
      </span>
    );
  }

  const showModeSwitch = !fixedMode && !hideModeSwitch;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        ...(minimal
          ? undefined
          : {
              overflow: "hidden",
              background: "white",
              color: "black",
              ...(focused ? FOCUSED_STYLE : BLURED_STYLE),
            }),
      }}
    >
      <div
        onMouseDown={beginModeSwitchInteraction}
        onMouseUp={endModeSwitchInteraction}
        onTouchStart={beginModeSwitchInteraction}
        onTouchEnd={endModeSwitchInteraction}
        onTouchCancel={endModeSwitchInteraction}
      >
        {showModeSwitch && (
          <div
            style={{
              background: "white",
              color: COLORS.GRAY_M,
              ...(mode == "editor" || hideHelp
                ? {
                    float: "right",
                    position: "relative",
                    zIndex: 1,
                  }
                : { float: "right" }),
              ...modeSwitchStyle,
            }}
          >
            <Radio.Group
              options={[
                ...(overflowEllipsis && mode == "editor"
                  ? [
                      {
                        label: renderEditBarEllipsis(),
                        value: "menu",
                        style: {
                          backgroundColor: editBarPopover
                            ? COLORS.GRAY_L
                            : "white",
                          paddingLeft: 10,
                          paddingRight: 10,
                        },
                      },
                    ]
                  : []),
                // fontWeight is needed to undo a stupid conflict with bootstrap css, which will go away when we get rid of that ancient nonsense.
                {
                  label: <span style={{ fontWeight: 400 }}>Rich Text</span>,
                  value: "editor",
                },
                {
                  label: <span style={{ fontWeight: 400 }}>Markdown</span>,
                  value: "markdown",
                },
              ]}
              onChange={(e) => {
                const mode = e.target.value;
                if (mode === "menu") {
                  toggleEditBarPopover();
                } else {
                  setMode(mode as Mode);
                }
                queueMicrotask(endModeSwitchInteraction);
              }}
              value={mode}
              optionType="button"
              size="small"
              buttonStyle="solid"
              style={{ display: "block" }}
            />
          </div>
        )}
      </div>
      {mode === "markdown" ? (
        <MarkdownTextAdapter
          editorDivRef={editorDivRef}
          selectionRef={selectionRef}
          value={value}
          onChange={(value) => {
            if (!isActiveCallback("markdown")) return;
            onChangeRef.current?.(value);
          }}
          saveDebounceMs={saveDebounceMs}
          getValueRef={getValueRef}
          project_id={project_id}
          path={path}
          enableUpload={enableUpload}
          onUploadStart={onUploadStart}
          onUploadEnd={onUploadEnd}
          enableMentions={enableMentions}
          onShiftEnter={(value) => {
            if (!isActiveCallback("markdown")) return;
            onShiftEnterRef.current?.(value);
          }}
          onAltEnter={(value, pos) => {
            onChangeRef.current?.(value);
            if (pos) {
              pendingModeSelectionRef.current = { to: "editor", pos };
            }
            setMode("editor");
          }}
          placeholder={placeholder ?? "Type markdown..."}
          fontSize={fontSize}
          cmOptions={cmOptions}
          height={height}
          autoGrow={autoGrow ?? height === "auto"}
          autoGrowMaxHeight={autoGrowMaxHeight}
          style={style}
          autoFocus={focused}
          submitMentionsRef={submitMentionsRef}
          extraHelp={extraHelp}
          hideHelp={hideHelp}
          onBlur={(value) => {
            onChangeRef.current?.(value);
            if (!shouldSuppressBlur()) {
              onBlur?.();
            }
          }}
          onFocus={onFocus}
          onSave={onSave}
          onUndo={onUndo}
          onRedo={onRedo}
          onCursors={onCursors}
          cursors={cursorsMap}
          onCursorTop={onCursorTop}
          onCursorBottom={onCursorBottom}
          isFocused={isFocused}
          registerEditor={registerEditor}
          unregisterEditor={unregisterEditor}
          refresh={refresh}
          compact={compact}
          dirtyRef={dirtyRef}
        />
      ) : undefined}
      {mode === "editor" ? (
        <SlateRichTextAdapter
          selectionRef={selectionRef}
          editorDivRef={editorDivRef}
          noVfill={noVfill}
          value={value}
          minimal={minimal}
          height={height}
          saveDebounceMs={saveDebounceMs}
          getValueRef={getValueRef}
          onChange={(value) => {
            if (!isActiveCallback("editor")) return;
            onChangeRef.current?.(value);
          }}
          onShiftEnter={(value) => {
            if (!isActiveCallback("editor")) return;
            onChangeRef.current?.(value);
            onShiftEnterRef.current?.(value);
          }}
          onAltEnter={(value) => {
            onChangeRef.current?.(value);
            const pos =
              slateControlRef.current?.getMarkdownPositionForSelection?.();
            if (pos) {
              pendingModeSelectionRef.current = { to: "markdown", pos };
            }
            setMode("markdown");
          }}
          onCursors={onCursors}
          onUndo={onUndo}
          onRedo={onRedo}
          onSave={onSave}
          cursors={cursorsMap}
          fontSize={fontSize}
          autoFocus={focused}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            if (!shouldSuppressBlur()) {
              onBlur?.();
            }
          }}
          onCursorTop={onCursorTop}
          onCursorBottom={onCursorBottom}
          isFocused={isFocused}
          registerEditor={registerEditor}
          unregisterEditor={unregisterEditor}
          disableBlockEditor={disableBlockEditor}
          placeholder={placeholder}
          submitMentionsRef={submitMentionsRef}
          editBar2={editBar2}
          dirtyRef={dirtyRef}
          controlRef={slateControlRef}
          preserveBlankLines={preserveBlankLines}
          externalMultilinePasteAsCodeBlock={
            slateExternalMultilinePasteAsCodeBlock
          }
          style={style}
          editBarStyle={editBarStyle}
          autoGrow={isAutoGrow}
        />
      ) : undefined}
    </div>
  );
}
