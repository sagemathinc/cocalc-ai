/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ClipboardEvent } from "react";

type PlainTextPasteEvent = Pick<
  ClipboardEvent<HTMLDivElement>,
  "clipboardData" | "preventDefault" | "stopPropagation"
>;

type PlainTextPasteEditor = {
  insertData?: (data: any) => void;
  __forcePlainTextPaste?: boolean;
};

export function handleForcedPlainTextPaste({
  editor,
  event,
}: {
  editor: PlainTextPasteEditor;
  event: PlainTextPasteEvent;
}): boolean {
  if (!editor.__forcePlainTextPaste) return false;

  const plain = event.clipboardData?.getData("text/plain");
  editor.__forcePlainTextPaste = false;
  if (typeof plain !== "string" || plain.length === 0) return false;
  if (typeof editor.insertData !== "function") return false;

  event.preventDefault();
  event.stopPropagation();
  editor.__forcePlainTextPaste = true;
  try {
    editor.insertData({
      getData: (type: string) => (type === "text/plain" ? plain : ""),
      types: ["text/plain"],
      items: [],
    } as any);
  } finally {
    editor.__forcePlainTextPaste = false;
  }
  return true;
}
