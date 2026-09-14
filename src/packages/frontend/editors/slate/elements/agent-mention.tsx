import { useState } from "react";
import { serializeAgentMention } from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { openAgentThread } from "@cocalc/frontend/agents/open-agent";
import { register } from "./register";
import type { RenderElementProps, SlateElement } from "./register";

export interface AgentMention extends SlateElement {
  type: "agent-mention";
  reference: AgentMentionReference;
  isInline: true;
  isVoid: true;
}
export function createAgentMention(
  reference: AgentMentionReference,
): AgentMention {
  return {
    type: "agent-mention",
    reference,
    isInline: true,
    isVoid: true,
    children: [{ text: "" }],
  };
}

function AgentMentionElement({
  attributes,
  element,
  children,
}: RenderElementProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (element.type !== "agent-mention")
    throw new Error("Expected agent mention");
  const reference = element.reference;
  async function open() {
    setBusy(true);
    setError("");
    try {
      const { personalAgentApi } = await import("@cocalc/frontend/agents/api");
      const target = await personalAgentApi().getIdentity(reference.target);
      if (target.disabled_at) throw new Error("This agent is unavailable");
      await openAgentThread(target);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <button
          type="button"
          disabled={busy}
          aria-label={`Open agent @${reference.name}`}
          title={`Named by ${reference.naming_account_id}; agent ${reference.target.agent_id}. Display name is a snapshot.`}
          onClick={() => void open()}
          style={{
            color: UI_COLORS.link,
            background: UI_COLORS.elevated,
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 3,
            font: "inherit",
            cursor: "pointer",
          }}
        >
          @{reference.name}
        </button>
        {error && <span role="alert">{error}</span>}
      </span>
      {children}
    </span>
  );
}

register({
  slateType: "agent-mention",
  toSlate: ({ token }) => createAgentMention(token.reference),
  fromSlate: ({ node }) => serializeAgentMention(node.reference),
  Element: AgentMentionElement,
  StaticElement: AgentMentionElement,
});
