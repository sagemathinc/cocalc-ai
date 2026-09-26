import { Button, Space } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { TextSource } from "./text-source";

// Bound the source passed to parsers, syntax highlighting, and DOM layout.
// Leave one code unit of room so a page boundary never splits a surrogate pair.
export const MAX_RENDERED_TEXT_CHARS = 16_384;
const PAGE_STRIDE = MAX_RENDERED_TEXT_CHARS - 1;

export function textPageCount(value: string | TextSource): number {
  return Math.max(1, Math.ceil(value.length / PAGE_STRIDE));
}

export function textPage(value: string | TextSource, page: number): string {
  const boundary = (offset: number) => {
    if (
      offset > 0 &&
      offset < value.length &&
      /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(value.slice(offset - 1, offset + 1))
    ) {
      return offset - 1;
    }
    return offset;
  };
  return value.slice(
    boundary(page * PAGE_STRIDE),
    boundary(Math.min(value.length, (page + 1) * PAGE_STRIDE)),
  );
}

export function PagedText({
  value,
  children,
  followTail = false,
}: {
  value: string | TextSource;
  children: (part: string) => ReactNode;
  followTail?: boolean;
}) {
  const [chosenPage, setChosenPage] = useState<number>();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [value]);
  const pages = textPageCount(value);
  const page = Math.min(chosenPage ?? (followTail ? pages - 1 : 0), pages - 1);
  const following = followTail && chosenPage == null;
  if (value.length <= MAX_RENDERED_TEXT_CHARS)
    return <>{children(value.toString())}</>;
  return (
    <div>
      <Space wrap size="small" style={{ marginBottom: 8 }}>
        <span role="status" style={{ color: UI_COLORS.secondary }}>
          {following
            ? "Long output: showing the latest text"
            : `Long output: part ${page + 1} of ${pages}`}
        </span>
        <Button
          size="small"
          disabled={page === 0}
          onClick={() => setChosenPage(0)}
        >
          First part
        </Button>
        <Button
          size="small"
          disabled={page === 0}
          onClick={() => setChosenPage(page - 1)}
        >
          Previous part
        </Button>
        <Button
          size="small"
          disabled={page === pages - 1}
          onClick={() => setChosenPage(page + 1)}
        >
          Next part
        </Button>
        <Button
          size="small"
          disabled={page === pages - 1 && (!followTail || chosenPage == null)}
          onClick={() => setChosenPage(followTail ? undefined : pages - 1)}
        >
          {followTail ? "Follow latest" : "Last part"}
        </Button>
        <Button
          size="small"
          onClick={async () => {
            setCopied(await copyTextToClipboard({ text: value.toString() }));
          }}
        >
          {copied ? "Copied full text" : "Copy full text"}
        </Button>
      </Space>
      <div key={following ? "tail" : page}>
        {children(following ? textTail(value) : textPage(value, page))}
      </div>
    </div>
  );
}

function textTail(value: string | TextSource): string {
  let start = Math.max(0, value.length - PAGE_STRIDE);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value.slice(start, start + 1)))
    start--;
  return value.slice(start, value.length);
}
