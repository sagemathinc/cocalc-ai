/*
Edit with either plain text input **or** WYSIWYG slate-based input.
*/

import { Popover, Radio } from "antd";
import { fromJS } from "immutable";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { COLORS } from "@cocalc/util/theme";
import { MarkdownTextAdapter, SlateRichTextAdapter } from "./adapters";
import { BLURED_STYLE, FOCUSED_STYLE } from "./component";
import { useMultimodeModeState } from "./use-multimode-mode-state";
import { useMultimodeSelection } from "./use-multimode-selection";
import type {
  Mode,
  MultiMarkdownInputProps,
} from "./types";

// NOTE: on mobile there is very little suppport for "editor" = "slate", but
// very good support for "markdown", hence the default below.

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
  const mountedRef = useRef<boolean>(true);

  const editBar2 = useRef<React.JSX.Element | undefined>(undefined);

  const isAutoGrow = autoGrow ?? height === "auto";
  const internalControlRef = useRef<any>(null);
  const slateControlRef = controlRef ?? internalControlRef;
  const { activeModeRef, mode, setMode, getCachedSelection, saveCachedSelection } =
    useMultimodeModeState({
      cacheId,
      projectId: project_id,
      path,
      defaultMode,
      fixedMode,
      fallbackMode: IS_MOBILE ? "markdown" : "editor",
      onModeChange,
    });

  const [editBarPopover, setEditBarPopover] = useState<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  activeCacheIdRef.current = cacheId;

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

  const { selectionRef, rememberPendingSelection, getMarkdownPositionForSelection } =
    useMultimodeSelection({
      cacheId,
      mode,
      getCachedSelection,
      saveCachedSelection,
      richTextControlRef: slateControlRef,
    });

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
              rememberPendingSelection("editor", pos);
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
            const pos = getMarkdownPositionForSelection();
            if (pos) {
              rememberPendingSelection("markdown", pos);
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
