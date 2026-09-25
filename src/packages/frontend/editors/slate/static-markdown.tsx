import "./elements/init-ssr";
import type { ComponentProps } from "react";
import StaticMarkdownCore from "./static-markdown-core";
import { staticSelectedMarkdown } from "./selected-markdown";

// The public viewer imports the core directly. Keep the serializer's editor
// registrations out of that path so they cannot replace public renderers.
export default function StaticMarkdown(
  props: ComponentProps<typeof StaticMarkdownCore>,
) {
  return (
    <StaticMarkdownCore
      {...props}
      serializeSelection={staticSelectedMarkdown}
    />
  );
}
