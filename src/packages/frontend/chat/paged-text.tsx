import { Button, Space } from "antd";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { TextSource } from "./text-source";

// Bound the source passed to parsers, syntax highlighting, and DOM layout.
// Leave one code unit of room so a page boundary never splits a surrogate pair.
export const MAX_RENDERED_TEXT_CHARS = 16_384;

export function textPageCount(
  value: string | TextSource,
  maxChars = MAX_RENDERED_TEXT_CHARS,
): number {
  return Math.max(1, Math.ceil(value.length / (maxChars - 1)));
}

export function textPage(
  value: string | TextSource,
  page: number,
  maxChars = MAX_RENDERED_TEXT_CHARS,
): string {
  return value.slice(...textPageRange(value, page, maxChars));
}

function textPageRange(
  value: string | TextSource,
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
  renderRanges = false,
}: {
  value: string | TextSource;
  children: (part: string) => ReactNode;
  followTail?: boolean;
  // Reserve space for mandatory formatting such as terminal code fences.
  maxChars?: number;
  // Parse structured source blocks independently, restoring their wrappers.
  renderRanges?: boolean;
}) {
  const [chosenPage, setChosenPage] = useState<number>();
  const [wasFollowingTail, setWasFollowingTail] = useState(followTail);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [value]);
  useEffect(() => {
    if (followTail) setWasFollowingTail(true);
  }, [followTail]);
  const rendering =
    renderRanges && typeof value !== "string" ? value.rendering : undefined;
  const displayValue = rendering?.source ?? value;
  const pageChars = rendering
    ? Math.floor((maxChars - rendering.maxOverhead) / rendering.maxExpansion)
    : maxChars;
  if (pageChars < 2)
    throw Error("Text page budget is too small for formatting");
  const pages = textPageCount(displayValue, pageChars);
  // Completion is not navigation. Retain the tail excerpt (and its DOM) until
  // the reader chooses a page; a newly opened completed message starts at 0.
  const showingTail = (followTail || wasFollowingTail) && chosenPage == null;
  const page = Math.min(chosenPage ?? (showingTail ? pages - 1 : 0), pages - 1);
  function renderRange(start: number, end: number) {
    if (!rendering) return children(displayValue.slice(start, end));
    return rendering.ranges.map((range, index) => {
      const from = Math.max(start, range.start);
      const to = Math.min(end, range.end);
      if (from >= to) return null;
      const part = displayValue.slice(from, to);
      return (
        <Fragment key={index}>
          {children(range.format ? range.format(part) : part)}
        </Fragment>
      );
    });
  }
  if (displayValue.length <= pageChars && value.length <= maxChars)
    return <>{renderRange(0, displayValue.length)}</>;
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
            setCopied(await copyTextToClipboard({ text: value.toString() }));
          }}
        >
          {copied ? "Copied full text" : "Copy full text"}
        </Button>
      </Space>
      <div key={showingTail ? "tail" : page}>
        {renderRange(
          ...(showingTail
            ? textTailRange(displayValue, pageChars)
            : textPageRange(displayValue, page, pageChars)),
        )}
      </div>
    </div>
  );
}

function textTailRange(
  value: string | TextSource,
  maxChars: number,
): [number, number] {
  let start = Math.max(0, value.length - (maxChars - 1));
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value.slice(start, start + 1)))
    start--;
  return [start, value.length];
}
