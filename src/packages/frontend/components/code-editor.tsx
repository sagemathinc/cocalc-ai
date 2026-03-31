/*
A lightweight code editor fallback for static/public notebook views.

This is intentionally just a styled textarea.  The heavy lifting for syntax
highlighting is handled elsewhere by CodeMirrorStatic/Prism when rendering
read-only content, and callers only need a simple editable surface here.
*/

import type { CSSProperties, TextareaHTMLAttributes } from "react";

type Language = string | { name?: string };

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  language?: Language;
};

const DEFAULT_STYLE: CSSProperties = {
  width: "100%",
  minHeight: "5em",
  resize: "vertical",
  boxSizing: "border-box",
  tabSize: 2,
  whiteSpace: "pre",
  overflowWrap: "normal",
  overflowX: "auto",
  background: "transparent",
};

export default function CodeEditor({ style, language, ...props }: Props) {
  const dataLanguage = typeof language === "string" ? language : language?.name;
  return (
    <textarea
      {...props}
      spellCheck={false}
      data-language={dataLanguage}
      style={{ ...DEFAULT_STYLE, ...style }}
    />
  );
}
