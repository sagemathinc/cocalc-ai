/*
Edit with either plain text input **or** WYSIWYG slate-based input.
*/

import { fromJS } from "immutable";
import { useEffect, useMemo, useRef } from "react";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { MarkdownTextAdapter, SlateRichTextAdapter } from "./adapters";
import { BLURED_STYLE, FOCUSED_STYLE } from "./component";
import { MarkdownInputModeSwitch } from "./mode-switch";
import { useMultimodeFocusInteraction } from "./use-multimode-focus-interaction";
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
  modeSwitchPlacement = "float",
  modeSwitchRightContent,
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
  redoMode,
  undoMode,
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
  const internalGetValueRef = useRef<() => string>(() => `${value ?? ""}`);
  useEffect(() => {
    if (getValueRef != null) {
      getValueRef.current = () => internalGetValueRef.current();
    }
  }, [getValueRef]);
  const activeCacheIdRef = useRef<string | undefined>(cacheId);
  const mountedRef = useRef<boolean>(true);

  const editBar2 = useRef<React.JSX.Element | undefined>(undefined);

  const isAutoGrow = autoGrow ?? height === "auto";
  const internalControlRef = useRef<any>(null);
  const slateControlRef = controlRef ?? internalControlRef;
  const showToolbarModeSwitch =
    modeSwitchPlacement === "toolbar" && !fixedMode && !hideModeSwitch;
  const toolbarInset = showToolbarModeSwitch ? 28 : 0;
  const editorHeight =
    showToolbarModeSwitch && height != null && height !== "auto"
      ? `calc(${height} - ${toolbarInset}px)`
      : height;
  const shellHeight =
    showToolbarModeSwitch && height != null && height !== "auto"
      ? height
      : "100%";
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
  const {
    focused,
    beginModeSwitchInteraction,
    endModeSwitchInteraction,
    handleMarkdownBlur,
    handleRichTextFocus,
    handleRichTextBlur,
  } = useMultimodeFocusInteraction({
    autoFocus,
    onFocus,
    onBlur,
  });

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

  function syncLiveValueBeforeModeSwitch() {
    const liveValue = internalGetValueRef.current?.();
    if (liveValue != null && liveValue !== value) {
      onChangeRef.current?.(liveValue);
    }
  }

  const cursorsMap = useMemo(() => {
    return cursors == null ? undefined : fromJS(cursors);
  }, [cursors]);

  const {
    selectionRef,
    rememberPendingSelection,
    captureModeSwitchSelection,
    clearModeSwitchSelection,
    rememberSelectionForModeSwitch,
    getMarkdownPositionForSelection,
    notifyMarkdownSelectionReady,
    notifyRichTextSelectionReady,
  } = useMultimodeSelection({
    cacheId,
    mode,
    getCachedSelection,
    saveCachedSelection,
    richTextControlRef: slateControlRef,
  });

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: shellHeight,
        display: showToolbarModeSwitch ? "flex" : undefined,
        flexDirection: showToolbarModeSwitch ? "column" : undefined,
        minHeight: showToolbarModeSwitch ? 0 : undefined,
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
      {showToolbarModeSwitch ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: `${toolbarInset}px`,
            paddingBottom: "4px",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flexShrink: 0,
            }}
          >
            {modeSwitchRightContent}
            <MarkdownInputModeSwitch
              mode={mode}
              layout="inline"
              isFocusedFrame={isFocusedFrame}
              isVisible={isVisible}
              hideHelp={hideHelp}
              hidden={false}
              overflowEllipsis={overflowEllipsis}
              style={modeSwitchStyle}
              editBarContentRef={editBar2}
              onSelectMode={(nextMode) => {
                if (nextMode !== mode) {
                  syncLiveValueBeforeModeSwitch();
                  rememberSelectionForModeSwitch(nextMode);
                  setMode(nextMode);
                }
              }}
              onInteractionStart={() => {
                captureModeSwitchSelection();
                beginModeSwitchInteraction();
              }}
              onInteractionEnd={() => {
                clearModeSwitchSelection();
                endModeSwitchInteraction();
              }}
            />
          </div>
        </div>
      ) : (
        <MarkdownInputModeSwitch
          mode={mode}
          isFocusedFrame={isFocusedFrame}
          isVisible={isVisible}
          hideHelp={hideHelp}
          hidden={!!fixedMode || !!hideModeSwitch}
          overflowEllipsis={overflowEllipsis}
          style={modeSwitchStyle}
          editBarContentRef={editBar2}
          onSelectMode={(nextMode) => {
            if (nextMode !== mode) {
              syncLiveValueBeforeModeSwitch();
              rememberSelectionForModeSwitch(nextMode);
              setMode(nextMode);
            }
          }}
          onInteractionStart={() => {
            captureModeSwitchSelection();
            beginModeSwitchInteraction();
          }}
          onInteractionEnd={() => {
            clearModeSwitchSelection();
            endModeSwitchInteraction();
          }}
        />
      )}
      <div
        style={
          showToolbarModeSwitch
            ? {
                flex: "1 1 auto",
                minHeight: 0,
                position: "relative",
              }
            : undefined
        }
      >
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
          getValueRef={internalGetValueRef}
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
          height={editorHeight}
          autoGrow={autoGrow ?? height === "auto"}
          autoGrowMaxHeight={autoGrowMaxHeight}
          style={style}
          autoFocus={focused}
          submitMentionsRef={submitMentionsRef}
          extraHelp={extraHelp}
          hideHelp={hideHelp}
          onBlur={(value) => {
            onChangeRef.current?.(value);
            handleMarkdownBlur();
          }}
          onFocus={onFocus}
          onSelectionReady={notifyMarkdownSelectionReady}
          onSave={onSave}
          onUndo={onUndo}
          onRedo={onRedo}
          undoMode={undoMode}
          redoMode={redoMode}
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
          height={editorHeight}
          saveDebounceMs={saveDebounceMs}
          getValueRef={internalGetValueRef}
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
          undoMode={undoMode}
          redoMode={redoMode}
          onSave={onSave}
          cursors={cursorsMap}
          fontSize={fontSize}
          autoFocus={focused}
          onFocus={handleRichTextFocus}
          onBlur={handleRichTextBlur}
          onSelectionReady={notifyRichTextSelectionReady}
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
    </div>
  );
}
