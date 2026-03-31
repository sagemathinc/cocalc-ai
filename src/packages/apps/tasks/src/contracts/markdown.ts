export type MarkdownValueGetter = () => string;
export type MarkdownStyleValue = string | number | undefined;
export type MarkdownStyle = Readonly<Record<string, MarkdownStyleValue>>;
export type TasksSurfaceComponent<Props> = (props: Props) => unknown;

export type MutableRefBox<T> = { current: T } | { current?: T | undefined };

export interface TasksMarkdownEditorProps {
  saveDebounceMs?: number;
  cacheId?: string;
  value: string;
  onChange: (value: string) => void;
  getValueRef?: MutableRefBox<MarkdownValueGetter>;
  fontSize?: number;
  onShiftEnter?: () => void;
  onBlur?: (value: string) => void;
  onFocus?: () => void;
  enableUpload?: boolean;
  enableMentions?: boolean;
  height?: number | string;
  autoGrow?: boolean;
  autoGrowMaxHeight?: number;
  placeholder?: string;
  autoFocus?: boolean;
  onSave?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  minimal?: boolean;
  disableBlockEditor?: boolean;
  modeSwitchStyle?: MarkdownStyle;
}

export interface TasksStaticMarkdownProps {
  value: string;
  style?: MarkdownStyle;
}

export interface TasksMostlyStaticMarkdownProps {
  value: string;
  searchWords?: readonly string[];
  onChange?: (value: string) => void;
  selectedHashtags?: Set<string>;
  toggleHashtag?: (tag: string) => void;
}

export interface TasksMarkdownSurface {
  MarkdownEditor: TasksSurfaceComponent<TasksMarkdownEditorProps>;
  StaticMarkdown: TasksSurfaceComponent<TasksStaticMarkdownProps>;
  MostlyStaticMarkdown: TasksSurfaceComponent<TasksMostlyStaticMarkdownProps>;
}
