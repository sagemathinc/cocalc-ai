/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render a static version of a document for use in TimeTravel.
*/

import * as CodeMirror from "codemirror";
import $ from "jquery";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { AccountState } from "@cocalc/frontend/account/types";
import "../generic/codemirror-plugins";
import { cm_options } from "../codemirror/cm-options";
import { init_style_hacks } from "../codemirror/util";

function withExtension(path: string, ext: string): string {
  const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
  if (!normalized) return path;
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const hasExt = base.lastIndexOf(".") > 0;
  if (hasExt) {
    return path.replace(/\.([^.\/]+)$/, `.${normalized}`);
  }
  return `${path}.${normalized}`;
}

type TextDocumentProps = {
  id: string;
  actions?: unknown;
  path: string;
  project_id: string;
  font_size: number;
  editor_settings: AccountState["editor_settings"];
  value: string | (() => string);
  syntaxHighlightExtension?: string;
  sourcePosition?: { line: number; column?: number; request?: number };
  scrollPosition?: { current: number };
};

function readValue(value: string | (() => string)): string {
  return typeof value === "function" ? (value() ?? "") : value;
}

export function TextDocument(props: TextDocumentProps) {
  const {
    path,
    font_size,
    editor_settings,
    value,
    syntaxHighlightExtension,
    scrollPosition,
  } = props;
  const modePath = useMemo(
    () =>
      syntaxHighlightExtension != null
        ? withExtension(path, syntaxHighlightExtension)
        : path,
    [path, syntaxHighlightExtension],
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cmRef = useRef<CodeMirror.Editor | null>(null);

  const refresh = () => {
    const cm = cmRef.current;
    if (cm == null) return;
    cm.refresh();
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea == null) return;

    const options: any = cm_options(modePath, editor_settings);
    options.readOnly = true;
    const cm = CodeMirror.fromTextArea(textarea, options);
    cmRef.current = cm;
    init_style_hacks(cm);
    $(cm.getWrapperElement()).css({ height: "100%" });
    const restoreTop = scrollPosition?.current ?? 0;
    cm.setValue(readValue(value));
    let restoring = true;
    let acceptingUserScroll = false;
    let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
    const endUserScrollSoon = () => {
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        acceptingUserScroll = false;
      }, 150);
    };
    const saveScrollPosition = () => {
      if (!restoring && acceptingUserScroll && scrollPosition != null) {
        scrollPosition.current = cm.getScrollInfo().top;
      }
      if (acceptingUserScroll) {
        endUserScrollSoon();
      }
    };
    const beginUserScroll = () => {
      restoring = false;
      acceptingUserScroll = true;
      endUserScrollSoon();
    };
    const scroller = cm.getScrollerElement();
    scroller.addEventListener("scroll", saveScrollPosition, { passive: true });
    scroller.addEventListener("wheel", beginUserScroll, { passive: true });
    scroller.addEventListener("touchstart", beginUserScroll, { passive: true });
    scroller.addEventListener("pointerdown", beginUserScroll);
    scroller.addEventListener("keydown", beginUserScroll);
    let restoreFrame: number | undefined;
    let restoreAttempts = 0;
    // CodeMirror measures its new document asynchronously and may reset the
    // viewport during the first few frames.
    const restoreScroll = () => {
      if (!restoring) return;
      refresh();
      if (Math.abs(cm.getScrollInfo().top - restoreTop) > 1) {
        cm.scrollTo(null, restoreTop);
      }
      restoreAttempts += 1;
      if (restoreAttempts < 12) {
        restoreFrame = requestAnimationFrame(restoreScroll);
      } else {
        restoring = false;
      }
    };
    restoreFrame = requestAnimationFrame(restoreScroll);

    return () => {
      if (restoreFrame != null) {
        cancelAnimationFrame(restoreFrame);
      }
      clearTimeout(scrollIdleTimer);
      scroller.removeEventListener("scroll", saveScrollPosition);
      scroller.removeEventListener("wheel", beginUserScroll);
      scroller.removeEventListener("touchstart", beginUserScroll);
      scroller.removeEventListener("pointerdown", beginUserScroll);
      scroller.removeEventListener("keydown", beginUserScroll);
      $(cm.getWrapperElement()).remove();
      cmRef.current = null;
    };
  }, [modePath, editor_settings, scrollPosition]);

  useEffect(() => {
    const cm = cmRef.current;
    if (cm == null) return;
    const next = readValue(value);
    const top = scrollPosition?.current;
    if (cm.getValue() !== next) {
      // Apply live updates without resetting the viewport or selection.
      cm.setValueNoJump(next);
    }
    const frame = requestAnimationFrame(() => {
      refresh();
      if (top != null) {
        cm.scrollTo(null, top);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [value, scrollPosition]);

  useEffect(() => {
    const position = props.sourcePosition;
    const cm = cmRef.current;
    if (!position || !cm) return;
    const line = position.line - 1;
    if (!Number.isInteger(line) || line < 0 || line >= cm.lineCount()) return;
    const target = { line, ch: Math.max(0, (position.column ?? 1) - 1) };
    const frame = requestAnimationFrame(() => {
      cm.refresh();
      cm.setCursor(target);
      cm.scrollIntoView(target, 80);
      cm.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.sourcePosition, modePath, editor_settings]);

  return (
    <div
      className="smc-vfill"
      style={{
        fontSize: `${font_size}px`,
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <textarea ref={textareaRef} style={{ display: "none" }} />
    </div>
  );
}
