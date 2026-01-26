/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React, {
  CSSProperties,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { Editor as SlateEditor, Element, Path, Transforms } from "slate";
import { ReactEditor } from "../slate-react";
import { fromTextArea, Editor as CMEditor, commands } from "codemirror";
import {
  DARK_GREY_BORDER,
  CODE_FOCUSED_COLOR,
  CODE_FOCUSED_BACKGROUND,
  SELECTED_COLOR,
} from "../util";
import { useFocused, useSelected, useSlate, useCollapsed } from "./hooks";
import {
  moveCursorToBeginningOfBlock,
  moveCursorUp,
  moveCursorDown,
} from "../control";
import { selectAll } from "../keyboard/select-all";
import infoToMode from "./code-block/info-to-mode";
import { file_associations } from "@cocalc/frontend/file-associations";
import { useRedux } from "@cocalc/frontend/app-framework";
import { isEqual } from "lodash";
import { logSlateDebug } from "../slate-utils/slate-debug";
import { setGapCursor } from "../gap-cursor";

const STYLE = {
  width: "100%",
  overflow: "auto",
  overflowX: "hidden",
  border: "1px solid #dfdfdf",
  borderRadius: "8px",
  lineHeight: "1.21429em",
} as CSSProperties;

interface Props {
  onChange?: (string) => void;
  info?: string;
  value: string;
  onShiftEnter?: () => void;
  onEscape?: () => void;
  onBlur?: () => void;
  onFocus?: () => void;
  options?: { [option: string]: any };
  isInline?: boolean; // impacts how cursor moves out of codemirror.
  focusOnSelect?: boolean;
  elementPath?: Path;
  onRequestGapCursor?: (side: "before" | "after") => void;
  style?: CSSProperties;
  addonBefore?: ReactNode;
  addonAfter?: ReactNode;
  collapsed?: boolean;
  collapseLines?: number;
}

export const SlateCodeMirror: React.FC<Props> = React.memo(
  ({
    info,
    value,
    onChange,
    onShiftEnter,
    onEscape,
    onBlur,
    onFocus,
    options: cmOptions,
    isInline,
    focusOnSelect,
    elementPath,
    onRequestGapCursor,
    style,
    addonBefore,
    addonAfter,
    collapsed,
    collapseLines,
  }) => {
    const focused = useFocused();
    const selected = useSelected();
    const editor = useSlate();
    const selectionCollapsed = useCollapsed();
    const { actions } = useFrameContext();
    const { id } = useFrameContext();
    const cmRef = useRef<CMEditor | undefined>(undefined);
    const [isFocused, setIsFocused] = useState<boolean>(!!cmOptions?.autofocus);
    const textareaRef = useRef<any>(null);
    const previewRef = useRef<HTMLPreElement | null>(null);
    const isCollapsed = !!collapsed;
    const previewLineCount = collapseLines ?? 6;
    const previewText = useMemo(() => {
      if (!isCollapsed) return "";
      const lines = value.split("\n");
      return lines.slice(0, previewLineCount).join("\n");
    }, [isCollapsed, previewLineCount, value]);

    const editor_settings = useRedux(["account", "editor_settings"]);
    const options = useMemo(() => {
      const selectAllKeyboard = (cm) => {
        if (cm.getSelection() != cm.getValue()) {
          // not everything is selected (or editor is empty), so
          // select everything.
          commands.selectAll(cm);
        } else {
          // everything selected, so now select all editor content.
          // NOTE that this only makes sense if we change focus
          // to the enclosing select editor, thus losing the
          // cm editor focus, which is a bit weird.
          ReactEditor.focus(editor);
          selectAll(editor);
        }
      };

      const bindings = editor_settings.get("bindings");
      return {
        ...cmOptions,
        autoCloseBrackets: editor_settings.get("auto_close_brackets", false),
        lineWrapping: editor_settings.get("line_wrapping", true),
        lineNumbers: false, // editor_settings.get("line_numbers", false), // disabled since breaks when scaling in whiteboard, etc. and is kind of weird in edit mode only.
        matchBrackets: editor_settings.get("match_brackets", false),
        theme: editor_settings.get("theme", "default"),
        keyMap:
          bindings == null || bindings == "standard" ? "default" : bindings,
        // The two lines below MUST match with the useEffect above that reacts to changing info.
        mode: cmOptions?.mode ?? infoToMode(info),
        indentUnit:
          cmOptions?.indentUnit ??
          file_associations[info ?? ""]?.opts.indent_unit ??
          4,

        // NOTE: Using the inputStyle of "contenteditable" is challenging
        // because we have to take care that copy doesn't end up being handled
        // by slate and being wrong.  In contrast, textarea does work fine for
        // copy.  However, textarea does NOT work when any CSS transforms
        // are involved, and we use such transforms extensively in the whiteboard.

        inputStyle: "contenteditable" as "contenteditable", // can't change because of whiteboard usage!
        extraKeys: {
          ...cmOptions?.extraKeys,
          "Shift-Enter": () => {
            editor.setIgnoreSelection(false);
            Transforms.move(editor, { distance: 1, unit: "line" });
            ReactEditor.focus(editor);
            onShiftEnter?.();
          },
          // We make it so doing select all when not everything is
          // selected selects everything in this local Codemirror.
          // Doing it *again* then selects the entire external slate editor.
          "Cmd-A": selectAllKeyboard,
          "Ctrl-A": selectAllKeyboard,
          ...(onEscape != null ? { Esc: onEscape } : undefined),
        },
      };
    }, [editor_settings, cmOptions]);

    const setCSS = useCallback(
      (css) => {
        if (cmRef.current == null) return;
        $(cmRef.current.getWrapperElement()).css(css);
      },
      [cmRef],
    );

    const focusEditor = useCallback(
      (forceCollapsed?) => {
        if (editor.getIgnoreSelection()) return;
        const cm = cmRef.current;
        if (cm == null) return;
        if (forceCollapsed || selectionCollapsed) {
          // selectionCollapsed = single cursor, rather than a selection range.
          // focus the CodeMirror editor
          // It is critical to blur the Slate editor
          // itself after focusing codemirror, since otherwise we
          // get stuck in an infinite
          // loop since slate is confused about whether or not it is
          // blurring or getting focused, since codemirror is a contenteditable
          // inside of the slate DOM tree.  Hence this ReactEditor.blur:
          cm.refresh();
          cm.focus();
          ReactEditor.blur(editor);
        }
      },
      [selectionCollapsed, options.theme],
    );

    useEffect(() => {
      if (isCollapsed) return;
      if (!focused || !selected || isFocused) return;
      if (editor.selection == null || elementPath == null) return;
      if (!selectionCollapsed && !focusOnSelect) return;
      if ((editor as any).gapCursor) return;
      if ((editor as any).blockGapCursor) return;

      const { anchor, focus } = editor.selection;
      const isPathPrefix = (path: Path, other: Path): boolean => {
        if (other.length < path.length) return false;
        for (let i = 0; i < path.length; i++) {
          if (other[i] !== path[i]) return false;
        }
        return true;
      };
      if (
        !isPathPrefix(elementPath, anchor.path) ||
        !isPathPrefix(elementPath, focus.path)
      ) {
        return;
      }

      focusEditor(focusOnSelect);
    }, [
      selected,
      focused,
      isFocused,
      focusOnSelect,
      elementPath,
      selectionCollapsed,
    ]);

    useLayoutEffect(() => {
      if (isCollapsed) return;
      const pending = (editor as any).pendingCodeBlockFocusPath;
      if (!pending || !elementPath) return;
      if (!Path.equals(pending, elementPath)) return;
      if (!cmRef.current) return;
      const selection = editor.selection;
      if (selection) {
        const inElement =
          Path.isAncestor(elementPath, selection.anchor.path) &&
          Path.isAncestor(elementPath, selection.focus.path);
        if (!inElement) {
          (editor as any).pendingCodeBlockFocusPath = null;
          return;
        }
      }
      (editor as any).pendingCodeBlockFocusPath = null;
      focusEditor(true);
    }, [editor, elementPath, focusEditor]);

    useEffect(() => {
      const handlePointerDown = (event: MouseEvent) => {
        const cm = cmRef.current;
        if (!cm) return;
        const wrapper = cm.getWrapperElement?.();
        if (!wrapper) return;
        const hasFocus = cm.hasFocus?.() ?? isFocused;
        if (!hasFocus) return;
        if (event.target instanceof Node && wrapper.contains(event.target)) {
          return;
        }
        editor.setIgnoreSelection(false);
        setIsFocused(false);
        const input = cm.getInputField?.();
        if (input?.blur) {
          input.blur();
        } else {
          (wrapper as any)?.blur?.();
        }
        if (event.target instanceof Node && ReactEditor.hasTarget(editor, event.target)) {
          queueMicrotask(() => {
            try {
              ReactEditor.focus(editor);
            } catch {
              // ignore focus failures
            }
          });
        }
      };
      document.addEventListener("pointerdown", handlePointerDown, true);
      return () => {
        document.removeEventListener("pointerdown", handlePointerDown, true);
      };
    }, [editor, isFocused]);

    // If the info line changes update the mode.
    useEffect(() => {
      if (isCollapsed) return;
      const cm = cmRef.current;
      if (cm == null) return;
      cm.setOption("mode", infoToMode(info));
      const indentUnit = file_associations[info ?? ""]?.opts.indent_unit ?? 4;
      cm.setOption("indentUnit", indentUnit);
    }, [info, isCollapsed]);

    useEffect(() => {
      if (isCollapsed) {
        if (cmRef.current) {
          $(cmRef.current.getWrapperElement()).remove();
          cmRef.current = undefined;
        }
        return;
      }
      const node: HTMLTextAreaElement = textareaRef.current;
      if (node == null) return;

      const cm = (cmRef.current = fromTextArea(node, options));

      // The Up/Down/Left/Right key handlers are potentially already
      // taken by a keymap, so we have to add them explicitly using
      // addKeyMap, so that they have top precedence. Otherwise, somewhat
      // randomly, things will seem to "hang" and you get stuck, which
      // is super annoying.
      cm.addKeyMap(
        cursorHandlers(editor, isInline, elementPath, onRequestGapCursor),
      );

      cm.on("change", (_, _changeObj) => {
        if (onChange != null) {
          onChange(cm.getValue());
        }
      });

      if (onBlur != null) {
        cm.on("blur", onBlur);
      }

      if (onFocus != null) {
        cm.on("focus", onFocus);
      }

      cm.on("blur", () => {
        setIsFocused(false);
        editor.setIgnoreSelection(false);
        logSlateDebug("codemirror:blur", {
          selection: editor.selection ?? null,
        });
      });

      cm.on("focus", () => {
        setIsFocused(true);
        focusEditor(true);
        editor.setIgnoreSelection(true);
        logSlateDebug("codemirror:focus", {
          selection: editor.selection ?? null,
        });
      });

      cm.on("copy", (_, event) => {
        // We tell slate to ignore this event.
        // I couldn't find any way to get codemirror to allow the copy to happen,
        // but at the same time to not let the event propogate.  It seems like
        // codemirror also would ignore the event, which isn't useful.
        // @ts-ignore
        event.slateIgnore = true;
      });

      (cm as any).undo = () => {
        actions.undo(id);
      };
      (cm as any).redo = () => {
        actions.redo(id);
      };
      // This enables other functionality (e.g., save).
      (cm as any).cocalc_actions = actions;

      // Make it so editor height matches text.
      const css: any = {
        height: "auto",
        padding: "5px 15px",
      };
      setCSS(css);
      cm.refresh();

      const pending = (editor as any).pendingCodeBlockFocusPath;
      if (pending && elementPath && Path.equals(pending, elementPath)) {
        (editor as any).pendingCodeBlockFocusPath = null;
        focusEditor(true);
        if (cm.hasFocus?.()) {
          setIsFocused(true);
        }
      }

      return () => {
        if (cmRef.current == null) return;
        $(cmRef.current.getWrapperElement()).remove();
        cmRef.current = undefined;
      };
    }, [isCollapsed]);

    useEffect(() => {
      if (isCollapsed) return;
      const cm = cmRef.current;
      if (cm == null) return;
      for (const key in options) {
        const opt = options[key];
        if (!isEqual(cm.options[key], opt)) {
          if (opt != null) {
            cm.setOption(key as any, opt);
          }
        }
      }
    }, [editor_settings, isCollapsed]);

    useEffect(() => {
      if (isCollapsed) return;
      cmRef.current?.setValueNoJump(value);
    }, [isCollapsed, value]);

    const borderColor = isFocused
      ? CODE_FOCUSED_COLOR
      : selected
        ? SELECTED_COLOR
        : DARK_GREY_BORDER;
    return (
      <div
        contentEditable={false}
        style={{
          ...STYLE,
          ...{
            border: `1px solid ${borderColor}`,
            borderRadius: "8px",
          },
          ...style,
          position: "relative",
        }}
        className="smc-vfill"
      >
        {!isFocused && selected && !selectionCollapsed && (
          <div
            style={{
              background: CODE_FOCUSED_BACKGROUND,
              position: "absolute",
              opacity: 0.5,
              zIndex: 1,
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          ></div>
        )}
        {addonBefore}
        <div
          style={{
            borderLeft: `3px solid ${
              isFocused ? CODE_FOCUSED_COLOR : borderColor
            }`,
            position: "relative",
          }}
        >
          {isCollapsed ? (
            <div
              style={{
                cursor: "default",
                padding: "6px 12px",
                background: "white",
              }}
            >
              <pre
                ref={previewRef}
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "break-word",
                  fontFamily: "monospace",
                  fontSize: "13px",
                  color: "#444",
                }}
              >
                {previewText}
              </pre>
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "12px",
                  color: "#666",
                }}
              >
                {value.split("\n").length} lines (collapsed)
              </div>
            </div>
          ) : (
            <textarea ref={textareaRef} defaultValue={value}></textarea>
          )}
        </div>
        {addonAfter}
      </div>
    );
  },
);

// TODO: vim version of this...

function cursorHandlers(
  editor,
  isInline: boolean | undefined,
  elementPath?: Path,
  onRequestGapCursor?: (side: "before" | "after") => void,
) {
  const hasVoidSibling = (side: "before" | "after"): boolean => {
    if (!elementPath) return false;
    const siblingIndex =
      elementPath[0] + (side === "after" ? 1 : -1);
    if (siblingIndex < 0 || siblingIndex >= editor.children.length) {
      return false;
    }
    try {
      const [node] = SlateEditor.node(editor, [siblingIndex]);
      return Element.isElement(node) && SlateEditor.isVoid(editor, node);
    } catch {
      return false;
    }
  };

  const requestGapCursor = (side: "before" | "after"): boolean => {
    editor.setIgnoreSelection(false);
    if (onRequestGapCursor) {
      onRequestGapCursor(side);
      ReactEditor.focus(editor);
      return true;
    }
    if (elementPath) {
      setGapCursor(editor, { path: elementPath, side });
      ReactEditor.focus(editor);
      return true;
    }
    return false;
  };

  const blurCodeMirror = (cm) => {
    const input = cm.getInputField?.();
    if (input?.blur) {
      input.blur();
    } else {
      (cm.getWrapperElement?.() as any)?.blur?.();
    }
  };

  const exitDown = (cm) => {
    const cur = cm.getCursor();
    const n = cm.lastLine();
    const cur_line = cur?.line;
    const cur_ch = cur?.ch;
    const line = cm.getLine(n);
    const line_length = line?.length;
    if (cur_line === n && cur_ch === line_length) {
      if (hasVoidSibling("after")) {
        const moved = requestGapCursor("after");
        if (moved) {
          blurCodeMirror(cm);
        }
        return moved;
      }
      editor.setIgnoreSelection(false);
      const before = editor.selection?.focus;
      moveCursorDown(editor, true);
      const after = editor.selection?.focus;
      if (before && after && !isEqual(before, after)) {
        ReactEditor.focus(editor);
        return true;
      }
      const moved = requestGapCursor("after");
      if (moved) {
        blurCodeMirror(cm);
      }
      return moved;
    }
    return false;
  };

  return {
    Up: (cm) => {
      const cur = cm.getCursor();
      if (cur?.line === cm.firstLine() && cur?.ch == 0) {
        if (hasVoidSibling("before")) {
          const moved = requestGapCursor("before");
          if (moved) {
            blurCodeMirror(cm);
          }
          return;
        }
        editor.setIgnoreSelection(false);
        const before = editor.selection?.focus;
        moveCursorUp(editor, true);
        const after = editor.selection?.focus;
        if (before && after && !isEqual(before, after)) {
          if (!isInline) {
            moveCursorToBeginningOfBlock(editor);
          }
          ReactEditor.focus(editor);
          return;
        }
        const moved = requestGapCursor("before");
        if (moved) {
          blurCodeMirror(cm);
        }
      } else {
        commands.goLineUp(cm);
      }
    },
    Left: (cm) => {
      const cur = cm.getCursor();
      if (cur?.line === cm.firstLine() && cur?.ch == 0) {
        editor.setIgnoreSelection(false);
        Transforms.move(editor, { distance: 1, unit: "line", reverse: true });
        ReactEditor.focus(editor);
      } else {
        commands.goCharLeft(cm);
      }
    },
    Right: (cm) => {
      if (!exitDown(cm)) {
        commands.goCharRight(cm);
      }
    },
    Down: (cm) => {
      if (!exitDown(cm)) {
        commands.goLineDown(cm);
      }
    },
  };
}
