import { useState } from "react";
import {
  isExternalMentionTarget,
  serializeAgentMention,
} from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { openAgentThread } from "@cocalc/frontend/agents/open-agent";
import { useAgentMentionContext } from "@cocalc/frontend/agents/mention-context";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
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
  const { postOnly } = useAgentMentionContext();
  if (element.type !== "agent-mention")
    throw new Error("Expected agent mention");
  const reference = element.reference;
  const mentioned = reference.target;
  // An agent on another site has no thread here: it is a member of the
  // person's Agent Networks, which Agents shows.
  const external = isExternalMentionTarget(mentioned);
  async function open() {
    if (isExternalMentionTarget(mentioned)) {
      void redux.getActions("page").set_active_tab("agents");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { personalAgentApi } = await import("@cocalc/frontend/agents/api");
      const target = await personalAgentApi().getIdentity(mentioned);
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
          aria-label={
            external
              ? `Agent on another site @${reference.name}; open Agents`
              : `Open agent @${reference.name}`
          }
          title={
            postOnly
              ? "This post will not notify or send a message to this agent."
              : external
                ? "An agent on another site, in your Agent Networks. The current agent can message it; mentioning it does not send a message."
                : "Reference this agent so the current agent can contact it. Mentioning it does not send a message."
          }
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
          {external && (
            <>
              {" "}
              <Icon name="global" />
            </>
          )}
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
