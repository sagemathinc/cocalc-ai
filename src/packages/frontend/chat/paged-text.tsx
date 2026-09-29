import { Button, Space } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

// Bound the source passed to parsers, syntax highlighting, and DOM layout.
// Leave one code unit of room so a page boundary never splits a surrogate pair.
export const MAX_RENDERED_TEXT_CHARS = 16_384;

export function textPageCount(
  value: string,
  maxChars = MAX_RENDERED_TEXT_CHARS,
): number {
  return Math.max(1, Math.ceil(value.length / (maxChars - 1)));
}

export function textPage(
  value: string,
  page: number,
  maxChars = MAX_RENDERED_TEXT_CHARS,
): string {
  return value.slice(...textPageRange(value, page, maxChars));
}

function textPageRange(
  value: string,
  page: number,
  maxChars: number,
): [number, number] {
  const stride = maxChars - 1;
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
  return [
    boundary(page * stride),
    boundary(Math.min(value.length, (page + 1) * stride)),
  ];
}

export function PagedText({
  value,
  children,
  followTail = false,
  maxChars = MAX_RENDERED_TEXT_CHARS,
}: {
  value: string;
  children: (part: string) => ReactNode;
  followTail?: boolean;
  // Reserve space for mandatory formatting such as terminal code fences.
  maxChars?: number;
}) {
  const [chosenPage, setChosenPage] = useState<number>();
  const [wasFollowingTail, setWasFollowingTail] = useState(followTail);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [value]);
  useEffect(() => {
    if (followTail) setWasFollowingTail(true);
  }, [followTail]);
  if (maxChars < 2) throw Error("Text page budget is too small for formatting");
  const pages = textPageCount(value, maxChars);
  // Completion is not navigation. Retain the tail excerpt (and its DOM) until
  // the reader chooses a page; a newly opened completed message starts at 0.
  const showingTail = (followTail || wasFollowingTail) && chosenPage == null;
  const page = Math.min(chosenPage ?? (showingTail ? pages - 1 : 0), pages - 1);
  if (value.length <= maxChars) return <>{children(value)}</>;
  return (
    <div>
      <Space wrap size="small" style={{ marginBottom: 8 }}>
        <span role="status" style={{ color: UI_COLORS.secondary }}>
          {showingTail
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
            setCopied(await copyTextToClipboard({ text: value }));
          }}
        >
          {copied ? "Copied full text" : "Copy full text"}
        </Button>
      </Space>
      <div key={showingTail ? "tail" : page}>
        {children(
          value.slice(
            ...(showingTail
              ? textTailRange(value, maxChars)
              : textPageRange(value, page, maxChars)),
          ),
        )}
      </div>
    </div>
  );
}

function textTailRange(value: string, maxChars: number): [number, number] {
  let start = Math.max(0, value.length - (maxChars - 1));
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value.slice(start, start + 1)))
    start--;
  return [start, value.length];
}
