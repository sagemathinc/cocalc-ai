/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  collaborationReferenceLabel,
  parseCollaborationReference,
} from "@cocalc/util/collaboration-references";
import { parseAgentMention } from "@cocalc/util/agent-mentions";
import { parseArtifactMention } from "@cocalc/util/artifact-mentions";

/** Count a bound reference by its label, never cut its serialized identity. */
export function notificationPreview(markdown: string, limit = 240): string {
  let remaining = limit;
  let result = "";
  let position = 0;
  const append = (text: string) => {
    const characters = Array.from(text);
    result += characters.slice(0, remaining).join("");
    remaining -= Math.min(remaining, characters.length);
  };
  const atoms =
    /<a class="collaboration-reference" [^>]*>[^<]*<\/a>|<span class="(?:agent|artifact)-mention" [^>]*>[^<]*<\/span>/g;
  for (const match of markdown.matchAll(atoms)) {
    const markup = match[0];
    const reference = parseCollaborationReference(markup);
    const legacy = parseAgentMention(markup) ?? parseArtifactMention(markup);
    if (!reference && !legacy) continue;
    const before = markdown.slice(position, match.index);
    if (Array.from(before).length > remaining) {
      append(before);
      return result + "...";
    }
    append(before);
    const label = reference
      ? collaborationReferenceLabel(reference)
      : `@${legacy!.name}`;
    const length = Array.from(label).length;
    // Bound serialized size as well as visible length for reference-heavy posts.
    if (length > remaining || result.length + markup.length > 16384)
      return result + "...";
    result += markup;
    remaining -= length;
    position = match.index! + markup.length;
  }
  const tail = markdown.slice(position);
  const truncated = Array.from(tail).length > remaining;
  append(tail);
  return result + (truncated ? "..." : "");
}

/** Old notifications lost the rest of the atom before it was saved. Do not
 * guess an identity from a partial payload; the row still opens the message. */
export function readableNotificationMarkdown(markdown: string): string {
  return markdown.replace(
    /<(?:a|span) class="(?:collaboration-reference|agent-mention|artifact-mention)"[^>]*(?:$|>[^<]*$)/g,
    "Linked resource (open the conversation to view).",
  );
}
