import React, { useCallback, useState } from "react";
import type { BaseEditor, Descendant, Path, Range } from "slate";
import {
  Editable as UpstreamEditable,
  Slate as UpstreamSlate,
  DefaultPlaceholder,
  defaultScrollSelectionIntoView,
  useEditor,
  useSlateStatic,
  useFocused,
  useReadOnly,
  useSelected,
  useSlate,
  useSlateSelection as upstreamUseSlateSelection,
  ReactEditor as UpstreamReactEditor,
  withReact as upstreamWithReact,
} from "slate-react";
import type {
  RenderElementProps,
  RenderLeafProps,
  RenderChunkProps,
  RenderPlaceholderProps,
} from "slate-react";
import { ensurePoint, ensureRange } from "./slate-util";

type ExtraEditorFields = {
  windowedListRef: { current: any };
  scrollCaretAfterNextScroll?: boolean;
  collapsedSections: WeakMap<object, true>;
  updateHiddenChildren: () => void;
  forceUpdate: () => void;
  ticks: number;
  updateDOMSelection?: () => void;
  setIgnoreSelection: (value: boolean) => void;
  getIgnoreSelection: () => boolean;
  scrollIntoDOM: (index: number) => boolean;
  scrollCaretIntoView: (options?: { middle?: boolean }) => void;
};

export type ReactEditor = UpstreamReactEditor & ExtraEditorFields;

const baseToSlatePoint = UpstreamReactEditor.toSlatePoint;
const baseToSlateRange = UpstreamReactEditor.toSlateRange;

const ensureEditorExtras = (editor: UpstreamReactEditor): ReactEditor => {
  const e = editor as ReactEditor;
  if (e.windowedListRef == null) {
    e.windowedListRef = { current: null };
  }
  if (e.collapsedSections == null) {
    e.collapsedSections = new WeakMap<object, true>();
  }
  if (e.updateHiddenChildren == null) {
    e.updateHiddenChildren = () => undefined;
  }
  if (e.forceUpdate == null) {
    e.forceUpdate = () => undefined;
  }
  if (e.ticks == null) {
    e.ticks = 0;
  }
  if (e.setIgnoreSelection == null) {
    e.setIgnoreSelection = (value: boolean) => {
      (e as any).__ignoreSelection = value;
    };
  }
  if (e.getIgnoreSelection == null) {
    e.getIgnoreSelection = () => Boolean((e as any).__ignoreSelection);
  }
  if (e.scrollIntoDOM == null) {
    e.scrollIntoDOM = () => false;
  }
  if (e.scrollCaretIntoView == null) {
    e.scrollCaretIntoView = (_options?: { middle?: boolean }) => {
      if (!e.selection) return;
      try {
        const domRange = UpstreamReactEditor.toDOMRange(
          e,
          e.selection as Range,
        );
        defaultScrollSelectionIntoView(e, domRange);
      } catch {
        // ignore failures to resolve DOM range
      }
    };
  }
  return e;
};

export const ReactEditor = Object.assign(UpstreamReactEditor, {
  toSlatePoint(
    editor: ReactEditor,
    domPoint: Parameters<typeof UpstreamReactEditor.toSlatePoint>[1],
    options?: Parameters<typeof UpstreamReactEditor.toSlatePoint>[2],
  ) {
    const point = baseToSlatePoint(editor, domPoint, {
      exactMatch: false,
      suppressThrow: false,
      ...options,
    });
    return ensurePoint(editor, point);
  },
  toSlateRange(
    editor: ReactEditor,
    domRange: Parameters<typeof UpstreamReactEditor.toSlateRange>[1],
    options?: Parameters<typeof UpstreamReactEditor.toSlateRange>[2],
  ): Range | null {
    if (editor.getIgnoreSelection?.()) {
      return editor.selection ?? null;
    }
    const range = baseToSlateRange(editor, domRange, {
      exactMatch: false,
      suppressThrow: true,
      ...options,
    });
    if (range) return ensureRange(editor, range);
    const fallback = (editor as any).__autoformatSelection as Range | null;
    if (fallback) return ensureRange(editor, fallback);
    return null;
  },
  isUsingWindowing(editor: ReactEditor): boolean {
    return !!editor.windowedListRef?.current;
  },
  selectionIsInDOM(editor: ReactEditor): boolean {
    const { selection } = editor;
    if (selection == null) return true;
    const visibleRange = editor.windowedListRef?.current?.visibleRange;
    if (visibleRange == null) return true;
    const { startIndex, endIndex } = visibleRange;
    if (
      selection.anchor.path[0] < startIndex ||
      selection.anchor.path[0] > endIndex
    ) {
      return false;
    }
    if (
      selection.focus.path[0] < startIndex ||
      selection.focus.path[0] > endIndex
    ) {
      return false;
    }
    return true;
  },
  scrollIntoDOM(editor: ReactEditor, path: Path): boolean {
    return editor.scrollIntoDOM?.(path[0]) ?? false;
  },
  forceUpdate(editor: ReactEditor): void {
    editor.forceUpdate?.();
  },
});

export const useSlateSelection = upstreamUseSlateSelection;

export const withReact = <T extends BaseEditor>(editor: T): T & ReactEditor => {
  const e = upstreamWithReact(editor) as T & UpstreamReactEditor;
  return ensureEditorExtras(e) as T & ReactEditor;
};

type SlateProps = {
  editor: ReactEditor;
  value: Descendant[];
  children: React.ReactNode;
  onChange: (value: Descendant[]) => void;
};

export const Slate = (props: SlateProps) => {
  const { editor, value, onChange, children, ...rest } = props;
  const [ticks, setTicks] = useState(0);

  const handleChange = useCallback(
    (nextValue: Descendant[]) => {
      onChange(nextValue);
      setTicks((prev) => prev + 1);
    },
    [onChange],
  );

  const editorWithExtras = ensureEditorExtras(editor);
  editorWithExtras.children = value;
  editorWithExtras.ticks = ticks;
  editorWithExtras.forceUpdate = () => {
    setTicks((prev) => prev + 1);
  };
  Object.assign(editorWithExtras, rest);

  return React.createElement(UpstreamSlate, {
    editor: editorWithExtras,
    initialValue: value,
    onChange: handleChange,
    children,
  });
};

type EditableProps = React.ComponentProps<typeof UpstreamEditable> & {
  windowing?: unknown;
  divref?: React.Ref<HTMLDivElement>;
};

export const Editable = React.forwardRef<HTMLDivElement, EditableProps>(
  (props, forwardedRef) => {
    const {
      windowing: _windowing,
      divref,
      style,
      onCopy,
      onCut,
      ...rest
    } = props;
    const ref = divref ?? forwardedRef;

    const shouldIgnoreSlateClipboard = useCallback(
      (event: React.ClipboardEvent<HTMLDivElement>): boolean => {
        const nativeEvent = event.nativeEvent as ClipboardEvent & {
          slateIgnore?: boolean;
          target?: EventTarget | null;
        };
        if ((event as any).slateIgnore || nativeEvent?.slateIgnore) {
          return true;
        }
        const target =
          (event.target as EventTarget | null) ?? nativeEvent?.target ?? null;
        if (target && target instanceof Element) {
          return !!target.closest(".CodeMirror, .cm-editor");
        }
        return false;
      },
      [],
    );

    const handleCopy = useCallback(
      (event: React.ClipboardEvent<HTMLDivElement>) => {
        if (shouldIgnoreSlateClipboard(event)) {
          return true;
        }
        return onCopy?.(event);
      },
      [onCopy, shouldIgnoreSlateClipboard],
    );

    const handleCut = useCallback(
      (event: React.ClipboardEvent<HTMLDivElement>) => {
        if (shouldIgnoreSlateClipboard(event)) {
          return true;
        }
        return onCut?.(event);
      },
      [onCut, shouldIgnoreSlateClipboard],
    );

    return React.createElement(UpstreamEditable, {
      ref,
      ...rest,
      onCopy: handleCopy,
      onCut: handleCut,
      style: {
        ...style,
        outline: "none",
      },
    });
  },
);

export type {
  RenderElementProps,
  RenderLeafProps,
  RenderChunkProps,
  RenderPlaceholderProps,
};
export {
  DefaultPlaceholder,
  defaultScrollSelectionIntoView,
  useEditor,
  useSlateStatic,
  useFocused,
  useReadOnly,
  useSelected,
  useSlate,
};
