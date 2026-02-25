import { Button } from "antd";
import { CSSProperties, useEffect, useState } from "react";
import { CopyToClipboard } from "react-copy-to-clipboard";

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

  const copyWithClipboardApi = async (): Promise<boolean> => {
    if (!text) return false;
    if (typeof navigator === "undefined") return false;
    if (!navigator.clipboard || typeof navigator.clipboard.write !== "function") {
      return false;
    }
    const ClipboardItemCtor = (window as any)?.ClipboardItem;
    if (typeof ClipboardItemCtor !== "function") return false;
    try {
      const itemData: Record<string, Blob> = {
        "text/plain": new Blob([text], { type: "text/plain" }),
      };
      if (markdown) {
        itemData["text/markdown"] = new Blob([text], { type: "text/markdown" });
      }
      await navigator.clipboard.write([new ClipboardItemCtor(itemData)]);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <CopyToClipboard text={text} onCopy={() => setCopied(true)}>
      <Button
        block={block}
        size={size}
        type="text"
        style={style}
        onClick={(e) => {
          e.stopPropagation();
          void (async () => {
            if (await copyWithClipboardApi()) {
              setCopied(true);
            }
          })();
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
        {noText ? undefined : copied ? "Copied" : "Copy"}
      </Button>
    </CopyToClipboard>
  );
}
