import type { ComponentProps } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { MAX_RENDERED_TEXT_CHARS, PagedText } from "./paged-text";

export function formatMarkdownPage(
  part: string,
  format?: (part: string) => string,
): string {
  const formatted = format ? format(part) : part;
  // Optional decorations must not undo the source-page bound. Mandatory
  // formatting (code fences) reserves its worst-case overhead via maxChars.
  return formatted.length <= MAX_RENDERED_TEXT_CHARS ? formatted : part;
}

export default function BoundedStaticMarkdown({
  value,
  format,
  maxChars,
  ...props
}: ComponentProps<typeof StaticMarkdown> & {
  format?: (part: string) => string;
  maxChars?: number;
}) {
  return (
    <PagedText value={value} maxChars={maxChars}>
      {(part) => (
        <StaticMarkdown {...props} value={formatMarkdownPage(part, format)} />
      )}
    </PagedText>
  );
}
