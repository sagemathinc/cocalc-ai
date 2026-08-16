/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  Compartment,
  EditorState,
  Text,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { loadCodeMirrorLanguage } from "./codemirror-languages";
import {
  CodeMirrorEditJournal,
  type CodeMirrorJournalBatch,
} from "./edit-journal";
import type { UltraliteLanguage } from "./prism-languages";

export interface CodeMirrorEditorHandle {
  acknowledgeJournal(value: string): void;
  focus(): void;
  getJournalBatch(): CodeMirrorJournalBatch | undefined;
  getValue(): string;
  markClean(): void;
  rebaseValue(base: string, value: string): void;
  replaceValue(value: string): void;
}

export interface CodeMirrorShortcut {
  key: string;
  run: () => void;
}

interface Props {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  initialValue: string;
  language?: UltraliteLanguage;
  onChange?: (value: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onCursorChange: (position: string) => void;
  onLanguageError: (message?: string) => void;
  onSave: () => void;
  path: string;
  readOnly?: boolean;
  shortcuts?: CodeMirrorShortcut[];
  spellCheck?: boolean;
  wrap: boolean;
}

function cursorPosition(view: EditorView): string {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return `Ln ${line.number}, Col ${head - line.from + 1}`;
}

const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, Props>(
  function CodeMirrorEditor(
    {
      ariaLabel,
      autoFocus = true,
      className,
      initialValue,
      language,
      onChange,
      onDirtyChange,
      onCursorChange,
      onLanguageError,
      onSave,
      path,
      readOnly = false,
      shortcuts = [],
      spellCheck = false,
      wrap,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | undefined>(undefined);
    const initialValueRef = useRef(initialValue);
    const cleanDocumentRef = useRef<Text | undefined>(undefined);
    const suppressJournalRef = useRef(false);
    const journalRef = useRef(new CodeMirrorEditJournal(initialValue));
    const languageCompartmentRef = useRef(new Compartment());
    const readOnlyCompartmentRef = useRef(new Compartment());
    const wrapCompartmentRef = useRef(new Compartment());
    const callbacksRef = useRef({
      onDirtyChange,
      onChange,
      onCursorChange,
      onLanguageError,
      onSave,
      shortcuts,
    });
    callbacksRef.current = {
      onDirtyChange,
      onChange,
      onCursorChange,
      onLanguageError,
      onSave,
      shortcuts,
    };

    useImperativeHandle(
      ref,
      () => ({
        acknowledgeJournal: (value) => {
          const view = viewRef.current;
          if (view && view.state.doc.toString() !== value) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: value },
            });
          }
          journalRef.current.reset(value);
          if (view) cleanDocumentRef.current = view.state.doc;
          callbacksRef.current.onDirtyChange(false);
        },
        focus: () => viewRef.current?.focus(),
        getJournalBatch: () => journalRef.current.getBatch(),
        getValue: () =>
          viewRef.current?.state.doc.toString() ?? initialValueRef.current,
        markClean: () => {
          const view = viewRef.current;
          if (!view) return;
          cleanDocumentRef.current = view.state.doc;
          journalRef.current.reset(view.state.doc.toString());
          callbacksRef.current.onDirtyChange(false);
        },
        rebaseValue: (base, value) => {
          const view = viewRef.current;
          initialValueRef.current = value;
          if (view && view.state.doc.toString() !== value) {
            suppressJournalRef.current = true;
            try {
              view.dispatch({
                annotations: Transaction.addToHistory.of(false),
                changes: {
                  from: 0,
                  to: view.state.doc.length,
                  insert: value,
                },
              });
            } finally {
              suppressJournalRef.current = false;
            }
          }
          journalRef.current.rebase(base, value);
          cleanDocumentRef.current = Text.of(base.split("\n"));
          callbacksRef.current.onDirtyChange(base !== value);
        },
        replaceValue: (value) => {
          const view = viewRef.current;
          if (!view || view.state.doc.toString() === value) return;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
          });
        },
      }),
      [initialValue],
    );

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const saveBinding = {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          callbacksRef.current.onSave();
          return true;
        },
      };
      const shortcutBindings = shortcuts.map((shortcut, index) => ({
        key: shortcut.key,
        preventDefault: true,
        run: () => {
          callbacksRef.current.shortcuts[index]?.run();
          return true;
        },
      }));
      const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        search(),
        highlightSelectionMatches(),
        keymap.of([
          ...shortcutBindings,
          saveBinding,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel,
          "aria-multiline": "true",
          autocapitalize: "off",
          autocomplete: "off",
          autocorrect: "off",
          spellcheck: spellCheck ? "true" : "false",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressJournalRef.current) {
            journalRef.current.record(update.changes);
            callbacksRef.current.onChange?.(update.state.doc.toString());
            callbacksRef.current.onDirtyChange(
              !cleanDocumentRef.current?.eq(update.state.doc),
            );
          }
          if (update.docChanged || update.selectionSet) {
            callbacksRef.current.onCursorChange(cursorPosition(update.view));
          }
        }),
        languageCompartmentRef.current.of([]),
        readOnlyCompartmentRef.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        wrapCompartmentRef.current.of(wrap ? EditorView.lineWrapping : []),
      ];
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: initialValueRef.current,
          extensions,
        }),
      });
      viewRef.current = view;
      cleanDocumentRef.current = view.state.doc;
      callbacksRef.current.onCursorChange(cursorPosition(view));
      if (autoFocus) view.focus();
      return () => {
        viewRef.current = undefined;
        view.destroy();
      };
    }, [ariaLabel]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: readOnlyCompartmentRef.current.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      });
    }, [readOnly]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartmentRef.current.reconfigure(
          wrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [wrap]);

    useEffect(() => {
      initialValueRef.current = initialValue;
      const view = viewRef.current;
      if (!view) return;
      if (view.state.doc.toString() !== initialValue) {
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: initialValue,
          },
        });
      }
      cleanDocumentRef.current = view.state.doc;
      journalRef.current.reset(view.state.doc.toString());
      callbacksRef.current.onDirtyChange(false);
    }, [initialValue, path]);

    useEffect(() => {
      let cancelled = false;
      callbacksRef.current.onLanguageError(undefined);
      void loadCodeMirrorLanguage(language, path)
        .then((extension) => {
          const view = viewRef.current;
          if (cancelled || !view) return;
          view.dispatch({
            effects: languageCompartmentRef.current.reconfigure(extension),
          });
        })
        .catch((err) => {
          if (cancelled) return;
          callbacksRef.current.onLanguageError(
            `Syntax highlighting could not be loaded: ${err instanceof Error ? err.message : `${err}`}`,
          );
        });
      return () => {
        cancelled = true;
      };
    }, [language, path]);

    return (
      <div className={`ul-cm-editor ${className ?? ""}`.trim()} ref={hostRef} />
    );
  },
);

export default CodeMirrorEditor;
