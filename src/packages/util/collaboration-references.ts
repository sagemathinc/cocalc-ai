/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type MarkdownIt from "markdown-it";
import type {
  CollaborationResource,
  CollaborationTarget,
} from "./collaborators";

/** Identity only: neither an access grant nor an agent invocation. */
export interface CollaborationReference {
  version: 1;
  target: CollaborationTarget;
  display_fallback: string;
  /** Authored alias, never used to resolve the target. */
  alias?: string;
}

export const COLLABORATION_REFERENCE_LABEL_LIMIT = 256;
const MAX_ENCODED = 8192;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !CONTROL.test(value) &&
    // Reject unpaired surrogates, which cannot be URI encoded.
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(
      value,
    )
  );
}

export function collaborationReference(
  value: unknown,
): CollaborationReference | undefined {
  if (value == null || typeof value !== "object") return;
  const v = value as CollaborationReference;
  if (
    v.version !== 1 ||
    !v.target ||
    typeof v.target.project_id !== "string" ||
    !UUID.test(v.target.project_id) ||
    !["agent", "artifact", "conversation"].includes(v.target.kind) ||
    !boundedText(v.target.resource_id, 256) ||
    !boundedText(v.display_fallback, COLLABORATION_REFERENCE_LABEL_LIMIT) ||
    (v.alias !== undefined && !boundedText(v.alias, 128))
  )
    return;
  return {
    version: 1,
    target: {
      project_id: v.target.project_id,
      kind: v.target.kind,
      resource_id: v.target.resource_id,
    },
    display_fallback: v.display_fallback,
    ...(v.alias !== undefined ? { alias: v.alias } : {}),
  };
}

export function collaborationReferenceFromResource(
  resource: CollaborationResource,
): CollaborationReference {
  const title = resource.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  // Slice by code points first, then avoid cutting a surrogate pair at the bound.
  let display_fallback = "";
  for (const character of title || resource.kind) {
    if (
      display_fallback.length + character.length >
      COLLABORATION_REFERENCE_LABEL_LIMIT
    )
      break;
    display_fallback += character;
  }
  const reference = collaborationReference({
    version: 1,
    target: resource,
    display_fallback,
    // Conversation aliases are display text, not legacy agent-name handles.
    alias:
      resource.personal?.alias?.replace(/[\u0000-\u001f\u007f]/g, " ").trim() ||
      undefined,
  });
  if (!reference) throw Error("Invalid collaboration reference");
  return reference;
}

export function encodeCollaborationReference(
  value: CollaborationReference,
): string {
  const reference = collaborationReference(value);
  if (!reference) throw Error("Invalid collaboration reference");
  return encodeURIComponent(JSON.stringify(reference));
}

export function decodeCollaborationReference(
  value: string,
): CollaborationReference | undefined {
  if (value.length > MAX_ENCODED) return;
  try {
    return collaborationReference(JSON.parse(decodeURIComponent(value)));
  } catch {
    return;
  }
}

export function collaborationReferenceLabel(
  reference: CollaborationReference,
): string {
  return reference.alias ? `@${reference.alias}` : reference.display_fallback;
}

/** The global route rechecks access and resolves the current locator on open. */
export function collaborationReferenceHref(
  reference: CollaborationReference,
): string {
  const { project_id, kind, resource_id } = reference.target;
  return `/people/conversations/project/${encodeURIComponent(project_id)}/resource/${kind}/${encodeURIComponent(resource_id)}`;
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

/** Distinct from legacy agent/artifact spans, which retain their old semantics. */
export function serializeCollaborationReference(
  reference: CollaborationReference,
): string {
  const encoded = encodeCollaborationReference(reference);
  return `<a class="collaboration-reference" data-collaboration-reference="${encoded}" href="${escapeHtml(collaborationReferenceHref(reference))}">${escapeHtml(collaborationReferenceLabel(reference))}</a>`;
}

export function parseCollaborationReference(
  markup: string,
): CollaborationReference | undefined {
  if (markup.length > MAX_ENCODED * 2) return;
  const match = markup.match(
    /^<a class="collaboration-reference" data-collaboration-reference="([^"]+)" href="[^"]+">[^<]*<\/a>$/,
  );
  if (!match) return;
  const reference = decodeCollaborationReference(match[1]);
  if (!reference) return;
  const canonical = serializeCollaborationReference(reference);
  // Saved messages retain the former workspace prefix. Accept only that exact
  // old serialization; new references and rendered HTML use the canonical URL.
  const legacy = canonical.replace(' href="/people/', ' href="/collaborators/');
  // Do not accept a label or destination that disagrees with the bound target.
  return markup === canonical || markup === legacy ? reference : undefined;
}

/** Consume the entire authored atom before Markdown parses punctuation in titles. */
export function collaborationReferencePlugin(md: MarkdownIt): void {
  md.inline.ruler.before(
    "html_inline",
    "collaboration-reference",
    (state, silent) => {
      if (
        !state.src.startsWith('<a class="collaboration-reference" ', state.pos)
      )
        return false;
      const end = state.src.indexOf("</a>", state.pos);
      if (
        end < 0 ||
        end + 4 > state.posMax ||
        end + 4 - state.pos > MAX_ENCODED * 2
      )
        return false;
      const reference = parseCollaborationReference(
        state.src.slice(state.pos, end + 4),
      );
      if (!reference) return false;
      if (!silent) {
        const token = state.push("collaboration-reference", "", 0);
        (
          token as typeof token & { reference: CollaborationReference }
        ).reference = reference;
      }
      state.pos = end + 4;
      return true;
    },
  );
  md.renderer.rules["collaboration-reference"] = (tokens, idx) =>
    serializeCollaborationReference(
      (
        tokens[idx] as (typeof tokens)[number] & {
          reference: CollaborationReference;
        }
      ).reference,
    );
}
