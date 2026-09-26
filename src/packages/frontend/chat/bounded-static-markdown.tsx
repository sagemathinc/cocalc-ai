import type { ComponentProps } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { PagedText } from "./paged-text";

export default function BoundedStaticMarkdown({
  value,
  format,
  ...props
}: ComponentProps<typeof StaticMarkdown> & {
  format?: (part: string) => string;
}) {
  return (
    <PagedText value={value}>
      {(part) => (
        <StaticMarkdown {...props} value={format ? format(part) : part} />
      )}
    </PagedText>
  );
}
