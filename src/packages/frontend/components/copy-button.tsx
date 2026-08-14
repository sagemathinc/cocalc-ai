import { Button } from "antd";
import { CSSProperties, useEffect, useState } from "react";

import { Icon } from "@cocalc/frontend/components/icon";
import { copyTextToClipboard } from "./copy-to-clipboard-util";

export { copyTextToClipboard } from "./copy-to-clipboard-util";

interface Props {
  style?: CSSProperties;
  value?: string;
  size?;
  noText?: boolean;
  block?: true;
  markdown?: boolean;
  ariaLabel?: string;
}

export default function CopyButton({
  style,
  value,
  size,
  noText = false,
  block,
  markdown = false,
  ariaLabel,
}: Props) {
  const [copied, setCopied] = useState<boolean>(false);
  useEffect(() => {
    setCopied(false);
  }, [value]);
  const text = value ?? "";

  const copy = async () => {
    if (!text) return;
    const ok = await copyTextToClipboard({ text, markdown });
    if (ok) {
      setCopied(true);
    }
  };

  return (
    <Button
      aria-label={
        noText
          ? copied
            ? "Copied"
            : (ariaLabel ?? "Copy to clipboard")
          : undefined
      }
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
