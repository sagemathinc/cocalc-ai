import type { ComputerMentionReference } from "@cocalc/util/computer-mentions";
import { serializeComputerMention } from "@cocalc/util/computer-mentions";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { register } from "./register";
import type { RenderElementProps, SlateElement } from "./register";

export interface ComputerMention extends SlateElement {
  type: "computer-mention";
  reference: ComputerMentionReference;
  isInline: true;
  isVoid: true;
}

export function createComputerMention(
  reference: ComputerMentionReference,
): ComputerMention {
  return {
    type: "computer-mention",
    reference,
    isInline: true,
    isVoid: true,
    children: [{ text: "" }],
  };
}

function ComputerMentionElement({
  attributes,
  element,
  children,
}: RenderElementProps) {
  if (element.type !== "computer-mention")
    throw Error("Expected computer mention");
  return (
    <span {...attributes}>
      <span
        contentEditable={false}
        title="Your computer: the agent can run commands there once it has access"
        style={{
          color: UI_COLORS.link,
          background: UI_COLORS.elevated,
          border: `1px solid ${UI_COLORS.border}`,
          borderRadius: 3,
          padding: "0 2px",
        }}
      >
        @{element.reference.name}
      </span>
      {children}
    </span>
  );
}

register({
  slateType: "computer-mention",
  toSlate: ({ token }) => createComputerMention(token.reference),
  fromSlate: ({ node }) => serializeComputerMention(node.reference),
  Element: ComputerMentionElement,
  StaticElement: ComputerMentionElement,
});
