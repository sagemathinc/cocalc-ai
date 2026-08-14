# Frontend Accessibility

Use this guidance when adding or substantially changing first-party frontend
UI. It does not make unrelated legacy remediation part of an ordinary task, but
new code must not copy known inaccessible patterns.

## Required Checks

1. Run `pnpm -C src lint:frontend` for frontend changes.
2. Test changed interactive behavior by accessible role and name, not only by
   CSS selector or implementation detail.
3. Add focused keyboard and focus assertions when changing controls, dialogs,
   overlays, navigation, shortcuts, or drag interactions.
4. For substantial public, authentication, navigation, or application-shell
   changes, run the relevant audit documented in
   `src/scripts/accessibility/README.md`.

Automated checks are regression evidence, not a substitute for using the UI
with a keyboard and reviewing behavior at narrow widths and browser zoom.

## Interaction Checklist

- Prefer native semantic elements and controls.
- Every interactive control must have an accessible name. Associate visible
  labels programmatically, ensure the accessible name includes the visible
  label, and give icon-only controls a meaningful name rather than relying on a
  tooltip.
- Expose a custom control's role, state, and value. Expose important
  asynchronous changes through an appropriate live region or alert without
  unnecessarily moving focus.
- Keep pointer functionality keyboard operable unless the pointer path is
  essential. Provide a non-drag, single-pointer alternative for nonessential
  dragging or multipoint gestures.
- Preserve logical focus order, visible focus, and a keyboard path into and out
  of the UI. Dialogs and temporary overlays must manage and restore focus.
- Use the shared helpers in
  `src/packages/frontend/keyboard/boundary.tsx` for new overlays and global
  shortcuts. Scope bare-character shortcuts to the focused editor or component.
- Use programmatically associated form labels, appropriate `autocomplete`
  purpose tokens, and specific programmatically exposed errors. Do not block
  paste or password managers in authentication fields.

## Visual And Responsive Checklist

- General-purpose UI must remain usable at 200% browser zoom and reflow without
  losing content or controls at 320 CSS pixels wide. Intrinsically
  two-dimensional content such as canvases and large data grids may be a
  documented exception; surrounding navigation and controls are not.
- Do not convey information solely by color, shape, or spatial wording such as
  "above" or "below". Do not reuse the same unlabeled icon for different
  actions in one context.
- Check text and non-text contrast in each affected theme, interaction state,
  and disabled state.
- Hover or focus content that can obscure other content must be hoverable,
  persistent, and dismissible, including with Escape.
- Persistent nonessential animation must provide a pause/stop mechanism or
  honor reduced-motion preferences.

## Focused Tests

Prefer Testing Library queries such as `getByRole(..., { name: ... })` and
assert the resulting state, focus movement, Escape behavior, and focus
restoration. A snapshot or click-only test does not establish keyboard
operability.

Add or update a browser audit scenario when component-level tests cannot cover
the rendered application behavior. Existing examples are in
`src/scripts/accessibility/scenarios.json` and keyboard-boundary tests under
`src/packages/frontend`.
