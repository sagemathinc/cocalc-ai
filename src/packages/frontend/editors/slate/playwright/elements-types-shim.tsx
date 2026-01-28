/*
 * Minimal element registrations for Playwright harness.
 * This avoids importing the full frontend element suite (which pulls many
 * app-only deps) while still allowing basic paragraph/list/code rendering.
 */

import type { Descendant } from "slate";
import { register } from "../elements/register";
import "../elements/generic";
import "../elements/paragraph/editable";
import "../elements/list/editable-list";
import "../elements/list/editable-list-item";

register({
  slateType: "code_block",
  Element: ({ attributes, children }) => (
    <pre
      {...attributes}
      className="cocalc-slate-code-block"
      style={{ margin: "6px 0", padding: "4px 6px", background: "#f7f7f7" }}
    >
      <code>{children}</code>
    </pre>
  ),
});

register({
  slateType: "code_line",
  Element: ({ attributes, children }) => (
    <div {...attributes} style={{ whiteSpace: "pre" }}>
      {children}
    </div>
  ),
});

// Minimal checkbox support so list tests don't crash if they appear.
register({
  slateType: "checkbox",
  Element: ({ attributes, children }) => (
    <div {...attributes}>
      <input type="checkbox" readOnly style={{ marginRight: 6 }} />
      {children}
    </div>
  ),
});

// Provide a tiny helper for code blocks pasted as plain text.
export function toCodeLines(value: string): Descendant[] {
  return value.split("\n").map((line) => ({
    type: "code_line",
    children: [{ text: line }],
  })) as Descendant[];
}
