/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// In the log, what an agent said about its turn with `cocalc agent turn`: the
// subject as a heading on its reply, and a high priority marked as in the
// reader. Only what the agent set: the reader's defaults (a first line, a
// priority by who started the turn) would just repeat the message here.
// Only on an agent's reply: never as a banner on a person's message.

import { readTurnMeta } from "@cocalc/chat";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { isAgentReply } from "./reader-model";
import type { ChatMessageTyped } from "./types";

export function TurnSubjectHeader({ message }: { message: ChatMessageTyped }) {
  if (!isAgentReply(message)) return null;
  const { subject, priority } = readTurnMeta(message);
  const high = priority === "high";
  const low = priority === "low";
  if (!subject && !high && !low) return null;
  return (
    <div
      data-testid="chat-turn-subject"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        marginBottom: 6,
        padding: "2px 8px",
        borderLeft: `3px solid ${high ? UI_COLORS.warning : "transparent"}`,
        background: high ? UI_COLORS.warningBg : undefined,
        borderRadius: 2,
      }}
    >
      {high ? (
        // Not by color alone: the label says it too.
        <span
          aria-label="High priority: for you"
          style={{ color: UI_COLORS.warning, fontSize: 11, flex: "none" }}
        >
          for you
        </span>
      ) : low ? (
        <span
          aria-label="Low priority"
          style={{ color: UI_COLORS.muted, fontSize: 11, flex: "none" }}
        >
          fyi
        </span>
      ) : null}
      {subject ? (
        <span
          role="heading"
          aria-level={2}
          style={{
            fontWeight: 600,
            color: low ? UI_COLORS.muted : undefined,
            overflowWrap: "anywhere",
          }}
        >
          {subject}
        </span>
      ) : null}
    </div>
  );
}
