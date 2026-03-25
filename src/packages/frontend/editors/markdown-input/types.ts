import type { Map as ImmutableMap } from "immutable";
import type {
  CSSProperties,
  MutableRefObject,
  ReactNode,
  RefObject,
} from "react";
import type { SubmitMentionsRef } from "@cocalc/frontend/chat/types";

export interface EditorFunctions {
  set_cursor: (pos: { x?: number; y?: number }) => void;
  get_cursor: () => { x: number; y: number };
}

export type Mode = "markdown" | "editor";

export interface MarkdownPosition {
  line: number;
  ch: number;
}

export interface SelectionController {
  setSelection: (selection: any) => void;
  getSelection: () => any;
  isSelectionReady?: () => boolean;
  focus?: () => boolean;
}

export type SelectionReadyCallback = () => void;
export type SubscribeSelectionReady = (
  callback: SelectionReadyCallback,
) => () => void;

export interface RichTextSelectionBridgeControl {
  getMarkdownPositionForSelection?: () => MarkdownPosition | null | undefined;
  setSelectionFromMarkdownPosition?: (pos: MarkdownPosition) => boolean;
  isSelectionReady?: () => boolean;
  focus?: () => boolean;
}

export type UndoMode = "auto" | "local" | "external";

export interface MultiMarkdownInputProps {
  account_id?: string;
  cacheId?: string;
  value?: string;
  defaultMode?: Mode;
  fixedMode?: Mode;
  onChange: (value: string) => void;
  getValueRef?: MutableRefObject<() => string>;
  onModeChange?: (mode: Mode) => void;
  onShiftEnter?: (value: string) => void;
  placeholder?: string;
  fontSize?: number;
  height?: string;
  autoGrow?: boolean;
  autoGrowMaxHeight?: number;
  clampAutoGrowToHost?: boolean;
  style?: CSSProperties;
  modeSwitchStyle?: CSSProperties;
  modeSwitchPlacement?: "float" | "toolbar";
  modeSwitchRightContent?: ReactNode;
  autoFocus?: boolean;
  enableMentions?: boolean;
  enableUpload?: boolean;
  onUploadStart?: () => void;
  onUploadEnd?: () => void;
  submitMentionsRef?: SubmitMentionsRef;
  extraHelp?: ReactNode;
  hideHelp?: boolean;
  hideModeSwitch?: boolean;
  saveDebounceMs?: number;
  onBlur?: () => void;
  onFocus?: () => void;
  minimal?: boolean;
  editBarStyle?: CSSProperties;
  onCursors?: (cursors: { x: number; y: number }[]) => void;
  cursors?: ImmutableMap<string, any>;
  noVfill?: boolean;
  editorDivRef?: RefObject<HTMLDivElement>;
  cmOptions?: { [key: string]: any };
  onUndo?: () => void;
  onRedo?: () => void;
  undoMode?: UndoMode;
  redoMode?: UndoMode;
  onSave?: () => void;
  compact?: boolean;
  onCursorTop?: () => void;
  onCursorBottom?: () => void;
  isFocused?: boolean;
  registerEditor?: (editor: EditorFunctions) => void;
  unregisterEditor?: () => void;
  refresh?: any;
  disableBlockEditor?: boolean;
  overflowEllipsis?: boolean;
  dirtyRef?: MutableRefObject<boolean>;
  controlRef?: MutableRefObject<RichTextSelectionBridgeControl | any>;
  preserveBlankLines?: boolean;
  slateExternalMultilinePasteAsCodeBlock?: boolean;
}
