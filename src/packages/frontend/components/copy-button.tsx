import { Button } from "antd";
import { CSSProperties, useEffect, useState } from "react";

import { Icon } from "@cocalc/frontend/components/icon";

interface Props {
  style?: CSSProperties;
  value?: string;
  size?;
  noText?: boolean;
  block?: true;
  markdown?: boolean;
}

export default function CopyButton({
  style,
  value,
  size,
  noText = false,
  block,
  markdown = false,
}: Props) {
  const [copied, setCopied] = useState<boolean>(false);
  useEffect(() => {
    setCopied(false);
  }, [value]);
  const text = value ?? "";
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
      // fallback below
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

  const copy = async () => {
    if (!text) return;
    const viaNavigator = await copyWithNavigatorApi();
    const ok = viaNavigator || copyWithExecCommand();
    if (ok) {
      noteMarkdownCopy();
      setCopied(true);
    }
  };

  return (
    <Button
      block={block}
      size={size}
      type="text"
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
    >
      <Icon name={copied ? "check" : "copy"} />
      {noText ? undefined : copied ? "Copied" : "Copy"}
    </Button>
  );
}
