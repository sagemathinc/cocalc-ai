/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// @name references to the account's computers in chat (plan:
// src/.agents/computers-plan-2026-10-11.md). A reference is identity only:
// it tells the agent which computer the person means; using it is checked
// when the agent asks for a ticket, as always.

export interface ComputerMentionReference {
  version: 1;
  computer_id: string;
  name: string;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_MENTIONS = 20;

export function computerMentionReference(
  value: unknown,
): ComputerMentionReference | undefined {
  if (!value || typeof value !== "object") return;
  const reference = value as ComputerMentionReference;
  if (
    reference.version !== 1 ||
    typeof reference.computer_id !== "string" ||
    !UUID.test(reference.computer_id) ||
    typeof reference.name !== "string" ||
    !NAME.test(reference.name)
  )
    return;
  return {
    version: 1,
    computer_id: reference.computer_id.toLowerCase(),
    name: reference.name,
  };
}

export function serializeComputerMention(
  reference: ComputerMentionReference,
): string {
  const valid = computerMentionReference(reference);
  if (!valid) throw Error("Invalid computer mention reference");
  return `<span class="computer-mention" data-computer-reference="${encodeURIComponent(JSON.stringify(valid))}">@${valid.name}</span>`;
}

export function parseComputerMention(
  markup: string,
): ComputerMentionReference | undefined {
  const match = markup.match(
    /^<span class="computer-mention" data-computer-reference="([^"]{1,1024})">@([a-z0-9-]+)<\/span>$/,
  );
  if (!match) return;
  try {
    const reference = computerMentionReference(
      JSON.parse(decodeURIComponent(match[1])),
    );
    return reference?.name === match[2] ? reference : undefined;
  } catch {
    return;
  }
}

/** Each computer once, at most MAX_MENTIONS of them. */
export function extractComputerMentions(
  markdown: string,
): ComputerMentionReference[] {
  const references = new Map<string, ComputerMentionReference>();
  for (const match of markdown.matchAll(
    /<span class="computer-mention" data-computer-reference="[^"]{1,1024}">@[a-z0-9-]+<\/span>/g,
  )) {
    const reference = parseComputerMention(match[0]);
    if (reference && !references.has(reference.computer_id)) {
      references.set(reference.computer_id, reference);
      if (references.size >= MAX_MENTIONS) break;
    }
  }
  return [...references.values()];
}

/** What the agent is told about the computers the person mentioned. */
export function computerMentionsNote(
  references: ReadonlyArray<ComputerMentionReference>,
): string {
  if (references.length === 0) return "";
  return [
    "Computers mentioned in this human turn (the person's own machines connected to CoCalc; identity only, not permission):",
    ...references.map((r) => `- @${r.name} (computer_id ${r.computer_id})`),
    "Run commands there with `cocalc computer exec @NAME -- 'a shell line'` (it waits; see --timeout), or start longer work with `cocalc computer run @NAME --description ... -- ...` (`cocalc computer --help`). `cocalc computer list` shows whether you can use it now; if not, `cocalc computer request NAME --why ...` asks the owner.",
  ].join("\n");
}
