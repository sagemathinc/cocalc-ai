/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export async function copyTextToClipboard({
  text,
  markdown = false,
  html,
}: {
  text: string;
  markdown?: boolean;
  // Rendered HTML of the same content, for pasting as rich text elsewhere.
  // CoCalc editors prefer the tagged markdown copy when it is present.
  html?: string;
}): Promise<boolean> {
  const noteMarkdownCopy = () => {
    if (!markdown) return;
    if (typeof window === "undefined") return;
    (window as any).__COCALC_LAST_MARKDOWN_COPY = {
      text,
      at: Date.now(),
    };
  };

  const copyWithNavigatorApi = async (): Promise<boolean> => {
    if (!text) return false;
    if (typeof navigator === "undefined") return false;
    try {
      const ClipboardItemCtor = (window as any)?.ClipboardItem;
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.write === "function" &&
        typeof ClipboardItemCtor === "function"
      ) {
        const itemData: Record<string, Blob> = {
          "text/plain": new Blob([text], { type: "text/plain" }),
        };
        if (markdown) {
          itemData["text/markdown"] = new Blob([text], {
            type: "text/markdown",
          });
          itemData["application/x-cocalc-markdown-copy"] = new Blob([text], {
            type: "application/x-cocalc-markdown-copy",
          });
        }
        if (html) {
          itemData["text/html"] = new Blob([html], { type: "text/html" });
        }
        await navigator.clipboard.write([new ClipboardItemCtor(itemData)]);
        return true;
      }
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall back to execCommand below.
    }
    return false;
  };

  const copyWithExecCommand = (): boolean => {
    if (typeof document === "undefined") return false;
    const onCopy = (event: ClipboardEvent) => {
      const dt = event.clipboardData;
      if (!dt) return;
      event.preventDefault();
      dt.setData("text/plain", text);
      if (markdown) {
        dt.setData("text/markdown", text);
        dt.setData("application/x-cocalc-markdown-copy", text);
      }
      if (html) dt.setData("text/html", html);
    };
    try {
      document.addEventListener("copy", onCopy);
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.removeEventListener("copy", onCopy);
    }
  };

  const viaNavigator = await copyWithNavigatorApi();
  const ok = viaNavigator || copyWithExecCommand();
  if (ok) {
    noteMarkdownCopy();
  }
  return ok;
}
