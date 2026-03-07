import type { Map as ImmutableMap } from "immutable";
import type { MutableRefObject, ReactNode, RefObject } from "react";
import { EditableMarkdown } from "@cocalc/frontend/editors/slate/editable-markdown";
import { MarkdownInput } from "./component";
import type {
  EditorFunctions,
  MarkdownPosition,
  SelectionController,
} from "./types";

const MIN_INPUT_HEIGHT = 38;
const MAX_INPUT_HEIGHT = "50vh";

interface MarkdownTextAdapterProps {
  editorDivRef?: RefObject<HTMLDivElement>;
  selectionRef: MutableRefObject<SelectionController | null>;
  value?: string;
  onChange: (value: string) => void;
  saveDebounceMs: number;
  getValueRef?: MutableRefObject<() => string>;
  project_id?: string;
  path?: string;
  enableUpload?: boolean;
  onUploadStart?: () => void;
  onUploadEnd?: () => void;
  enableMentions?: boolean;
  onShiftEnter?: (value: string) => void;
  onAltEnter: (value: string, pos: MarkdownPosition) => void;
  placeholder?: string;
  fontSize?: number;
  cmOptions?: { [key: string]: any };
  height?: string;
  autoGrow?: boolean;
  autoGrowMaxHeight?: number;
  style?: React.CSSProperties;
  autoFocus: boolean;
  submitMentionsRef?: any;
  extraHelp?: ReactNode;
  hideHelp?: boolean;
  onBlur?: (value: string) => void;
  onFocus?: () => void;
  onSave?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCursors?: (cursors: { x: number; y: number }[]) => void;
  cursors?: ImmutableMap<string, any>;
  onCursorTop?: () => void;
  onCursorBottom?: () => void;
  isFocused?: boolean;
  registerEditor?: (editor: EditorFunctions) => void;
  unregisterEditor?: () => void;
  refresh?: any;
  compact?: boolean;
  dirtyRef?: MutableRefObject<boolean>;
}

export function MarkdownTextAdapter({
  editorDivRef,
  selectionRef,
  value,
  onChange,
  saveDebounceMs,
  getValueRef,
  project_id,
  path,
  enableUpload,
  onUploadStart,
  onUploadEnd,
  enableMentions,
  onShiftEnter,
  onAltEnter,
  placeholder,
  fontSize,
  cmOptions,
  height,
  autoGrow,
  autoGrowMaxHeight,
  style,
  autoFocus,
  submitMentionsRef,
  extraHelp,
  hideHelp,
  onBlur,
  onFocus,
  onSave,
  onUndo,
  onRedo,
  onCursors,
  cursors,
  onCursorTop,
  onCursorBottom,
  isFocused,
  registerEditor,
  unregisterEditor,
  refresh,
  compact,
  dirtyRef,
}: MarkdownTextAdapterProps) {
  return (
    <MarkdownInput
      divRef={editorDivRef}
      selectionRef={selectionRef}
      value={value}
      onChange={onChange}
      saveDebounceMs={saveDebounceMs}
      getValueRef={getValueRef}
      project_id={project_id}
      path={path}
      enableUpload={enableUpload}
      onUploadStart={onUploadStart}
      onUploadEnd={onUploadEnd}
      enableMentions={enableMentions}
      onShiftEnter={onShiftEnter}
      onAltEnter={onAltEnter}
      placeholder={placeholder ?? "Type markdown..."}
      fontSize={fontSize}
      cmOptions={cmOptions}
      height={height}
      autoGrow={autoGrow ?? height === "auto"}
      autoGrowMaxHeight={autoGrowMaxHeight}
      style={style}
      autoFocus={autoFocus}
      submitMentionsRef={submitMentionsRef}
      extraHelp={extraHelp}
      hideHelp={hideHelp}
      onBlur={onBlur}
      onFocus={onFocus}
      onSave={onSave}
      onUndo={onUndo}
      onRedo={onRedo}
      onCursors={onCursors}
      cursors={cursors}
      onCursorTop={onCursorTop}
      onCursorBottom={onCursorBottom}
      isFocused={isFocused}
      registerEditor={registerEditor}
      unregisterEditor={unregisterEditor}
      refresh={refresh}
      compact={compact}
      dirtyRef={dirtyRef}
    />
  );
}

interface SlateRichTextAdapterProps {
  selectionRef: MutableRefObject<SelectionController | null>;
  editorDivRef?: RefObject<HTMLDivElement>;
  noVfill?: boolean;
  value?: string;
  minimal?: boolean;
  height?: string;
  saveDebounceMs: number;
  getValueRef?: MutableRefObject<() => string>;
  onChange: (value: string) => void;
  onShiftEnter?: (value: string) => void;
  onAltEnter: (value: string) => void;
  onCursors?: (cursors: { x: number; y: number }[]) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  cursors?: ImmutableMap<string, any>;
  fontSize?: number;
  autoFocus: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  onCursorTop?: () => void;
  onCursorBottom?: () => void;
  isFocused?: boolean;
  registerEditor?: (editor: EditorFunctions) => void;
  unregisterEditor?: () => void;
  disableBlockEditor?: boolean;
  placeholder?: string;
  submitMentionsRef?: any;
  editBar2: MutableRefObject<any>;
  dirtyRef?: MutableRefObject<boolean>;
  controlRef: MutableRefObject<any>;
  preserveBlankLines: boolean;
  externalMultilinePasteAsCodeBlock: boolean;
  style?: React.CSSProperties;
  editBarStyle?: React.CSSProperties;
  autoGrow?: boolean;
}

export function SlateRichTextAdapter({
  selectionRef,
  editorDivRef,
  noVfill,
  value,
  minimal,
  height,
  saveDebounceMs,
  getValueRef,
  onChange,
  onShiftEnter,
  onAltEnter,
  onCursors,
  onUndo,
  onRedo,
  onSave,
  cursors,
  fontSize,
  autoFocus,
  onFocus,
  onBlur,
  onCursorTop,
  onCursorBottom,
  isFocused,
  registerEditor,
  unregisterEditor,
  disableBlockEditor = true,
  placeholder,
  submitMentionsRef,
  editBar2,
  dirtyRef,
  controlRef,
  preserveBlankLines,
  externalMultilinePasteAsCodeBlock,
  style,
  editBarStyle,
  autoGrow,
}: SlateRichTextAdapterProps) {
  const hasFixedHeight = height != null && height !== "auto";
  const maxHeight = hasFixedHeight ? height : MAX_INPUT_HEIGHT;

  return (
    <div
      style={{
        height: hasFixedHeight ? height : undefined,
        minHeight: `${MIN_INPUT_HEIGHT}px`,
        maxHeight: maxHeight,
        overflowY: "auto",
        width: "100%",
        fontSize: "14px",
        ...style,
      }}
      className={height != "auto" ? "smc-vfill" : undefined}
    >
      <EditableMarkdown
        selectionRef={selectionRef}
        divRef={editorDivRef}
        noVfill={noVfill}
        value={value}
        is_current={true}
        hidePath
        disableWindowing={true}
        style={
          minimal
            ? {
                background: undefined,
                backgroundColor: undefined,
              }
            : undefined
        }
        pageStyle={
          minimal
            ? {
                background: undefined,
                padding: 0,
                minHeight: autoGrow ? `${MIN_INPUT_HEIGHT}px` : undefined,
              }
            : {
                padding: "5px 15px",
                minHeight: autoGrow ? `${MIN_INPUT_HEIGHT}px` : undefined,
              }
        }
        minimal={minimal}
        height={height}
        editBarStyle={{
          paddingRight: "127px",
          ...editBarStyle,
        }}
        saveDebounceMs={saveDebounceMs}
        getValueRef={getValueRef}
        actions={{
          set_value: onChange,
          shiftEnter: (value) => {
            onChange(value);
            onShiftEnter?.(value);
          },
          altEnter: onAltEnter,
          set_cursor_locs: onCursors,
          undo: onUndo,
          redo: onRedo,
          save: onSave as any,
        }}
        cursors={cursors}
        font_size={fontSize}
        autoFocus={autoFocus}
        onFocus={onFocus}
        onBlur={onBlur}
        hideSearch
        onCursorTop={onCursorTop}
        onCursorBottom={onCursorBottom}
        isFocused={isFocused}
        registerEditor={registerEditor}
        unregisterEditor={unregisterEditor}
        disableBlockEditor={disableBlockEditor}
        placeholder={placeholder ?? "Type text..."}
        submitMentionsRef={submitMentionsRef}
        editBar2={editBar2}
        dirtyRef={dirtyRef}
        controlRef={controlRef}
        preserveBlankLines={preserveBlankLines}
        externalMultilinePasteAsCodeBlock={externalMultilinePasteAsCodeBlock}
      />
    </div>
  );
}
