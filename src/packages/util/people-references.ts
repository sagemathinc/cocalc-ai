/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A typed link to a conversation, artifact or agent, written into a chat
// message. It names a target only: it grants no access and invokes nothing.
// Opening it rechecks access; without access the reader can request it.

import type MarkdownIt from "markdown-it";

export const PEOPLE_REFERENCE_KINDS = [
  "conversation",
  "artifact",
  "agent",
] as const;
export type PeopleReferenceKind = (typeof PEOPLE_REFERENCE_KINDS)[number];

export interface PeopleReference {
  version: 1;
  kind: PeopleReferenceKind;
  project_id: string;
  // conversation_id, artifact catalog entry_id, or agent_id
  id: string;
  // What the author saw; shown until the reader opens the link.
  label: string;
}

export const PEOPLE_REFERENCE_LABEL_LIMIT = 256;
const MAX_ENCODED = 4096;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ENTRY = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function peopleReference(value: unknown): PeopleReference | undefined {
  if (value == null || typeof value !== "object") return;
  const v = value as PeopleReference;
  if (
    v.version !== 1 ||
    !PEOPLE_REFERENCE_KINDS.includes(v.kind) ||
    typeof v.project_id !== "string" ||
    !UUID.test(v.project_id) ||
    typeof v.id !== "string" ||
    !(v.kind === "artifact" ? ENTRY : UUID).test(v.id) ||
    typeof v.label !== "string" ||
    !v.label.trim() ||
    v.label.length > PEOPLE_REFERENCE_LABEL_LIMIT ||
    CONTROL.test(v.label)
  ) {
    return;
  }
  return {
    version: 1,
    kind: v.kind,
    project_id: v.project_id.toLowerCase(),
    id: v.id.toLowerCase(),
    label: v.label,
  };
}

export function makePeopleReference(
  kind: PeopleReferenceKind,
  project_id: string,
  id: string,
  label: string,
): PeopleReference {
  const clean = Array.from(label.replace(/[\u0000-\u001f\u007f]/g, " ").trim())
    .slice(0, PEOPLE_REFERENCE_LABEL_LIMIT)
    .join("");
  const reference = peopleReference({
    version: 1,
    kind,
    project_id,
    id,
    label: clean || kind,
  });
  if (!reference) throw Error("invalid reference");
  return reference;
}

export function peopleReferenceHref(reference: PeopleReference): string {
  const { kind, project_id, id } = reference;
  switch (kind) {
    case "conversation":
      return `/people/conversations/${project_id}/${id}`;
    case "artifact":
      return `/library/${project_id}/${id}`;
    case "agent":
      return `/agents/${id}`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

export function serializePeopleReference(reference: PeopleReference): string {
  const bound = peopleReference(reference);
  if (!bound) throw Error("invalid reference");
  const encoded = encodeURIComponent(JSON.stringify(bound));
  return `<a class="cocalc-reference" data-reference="${encoded}" href="${escapeHtml(peopleReferenceHref(bound))}">${escapeHtml(bound.label)}</a>`;
}

// Accept only the exact canonical serialization, so a label or destination
// can never disagree with the encoded target.
export function parsePeopleReference(
  markup: string,
): PeopleReference | undefined {
  if (markup.length > MAX_ENCODED * 2) return;
  const match = markup.match(
    /^<a class="cocalc-reference" data-reference="([^"]+)" href="[^"]+">[^<]*<\/a>$/,
  );
  if (!match || match[1].length > MAX_ENCODED) return;
  let reference: PeopleReference | undefined;
  try {
    reference = peopleReference(JSON.parse(decodeURIComponent(match[1])));
  } catch {
    return;
  }
  if (!reference) return;
  return serializePeopleReference(reference) === markup ? reference : undefined;
}

const OPEN = '<a class="cocalc-reference" ';

// Consume the whole atom before Markdown parses punctuation in labels.
export function peopleReferencePlugin(md: MarkdownIt): void {
  md.inline.ruler.before("html_inline", "people-reference", (state, silent) => {
    if (!state.src.startsWith(OPEN, state.pos)) return false;
    const end = state.src.indexOf("</a>", state.pos);
    if (end < 0 || end + 4 > state.posMax) return false;
    const reference = parsePeopleReference(state.src.slice(state.pos, end + 4));
    if (!reference) return false;
    if (!silent) {
      const token = state.push("people-reference", "", 0);
      (token as typeof token & { reference: PeopleReference }).reference =
        reference;
    }
    state.pos = end + 4;
    return true;
  });
  md.renderer.rules["people-reference"] = (tokens, idx) =>
    serializePeopleReference(
      (tokens[idx] as (typeof tokens)[number] & { reference: PeopleReference })
        .reference,
    );
}
