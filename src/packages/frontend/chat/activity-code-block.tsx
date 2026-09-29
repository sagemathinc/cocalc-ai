/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import StaticMarkdown from "./bounded-static-markdown";
import { MAX_RENDERED_TEXT_CHARS } from "./paged-text";

// Reserve two fences longer than any backtick run, plus the language hint.
export const MAX_TERMINAL_PAGE_CHARS = Math.floor(
  (MAX_RENDERED_TEXT_CHARS - 6) / 3,
);

export function toFencedCodeBlock(content: string, language = ""): string {
  let longest = 0;
  let run = 0;
  for (const ch of content) {
    run = ch === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language.trim()}\n${content}\n${fence}`;
}

export function stripAnsi(text: string): string {
  const withoutOsc = text.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
  return withoutOsc.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g,
    "",
  );
}

export function ActivityCodeBlock({
  value,
  language = "",
  fontSize,
  editorTheme,
}: {
  value: string;
  language?: "" | "sh";
  fontSize: number;
  editorTheme?: string | null;
}) {
  return (
    <StaticMarkdown
      value={value}
      format={(part) => toFencedCodeBlock(part, language)}
      maxChars={MAX_TERMINAL_PAGE_CHARS}
      style={{ fontSize, marginTop: 0 }}
      editorTheme={editorTheme}
    />
  );
}
