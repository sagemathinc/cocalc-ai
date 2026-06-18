/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Render a static version of a document for use in TimeTravel.
*/

import * as CodeMirror from "codemirror";
import { useEffect, useMemo, useRef } from "react";
import type { AccountState } from "@cocalc/frontend/account/types";
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
};

function readValue(value: string | (() => string)): string {
  return typeof value === "function" ? (value() ?? "") : value;
}

export function TextDocument(props: TextDocumentProps) {
  const { path, font_size, editor_settings, value, syntaxHighlightExtension } =
    props;
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

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea == null) return;

    const options: any = cm_options(modePath, editor_settings);
    options.readOnly = true;
    const cm = CodeMirror.fromTextArea(textarea, options);
    cmRef.current = cm;
    init_style_hacks(cm);
    $(cm.getWrapperElement()).css({ height: "100%" });
    cm.setValue(readValue(value));
    requestAnimationFrame(refresh);

    return () => {
      $(cm.getWrapperElement()).remove();
      cmRef.current = null;
    };
  }, [modePath, editor_settings]);

  useEffect(() => {
    const cm = cmRef.current;
    if (cm == null) return;
    const next = readValue(value);
    if (cm.getValue() !== next) {
      cm.setValue(next);
    }
    requestAnimationFrame(refresh);
  }, [value]);

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
