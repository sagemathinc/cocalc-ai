# Native Appearance Audits

## Isolated Remote Chrome

When the user explicitly supplies a dedicated, signed-in Chrome profile through
a loopback-only SSH DevTools tunnel, run:

```sh
node src/scripts/appearance/audit-cdp.mjs --cdp http://127.0.0.1:9222
```

This uses a separate tab in that isolated profile, captures 11 signed-in routes
in both themes at 1440 and 390 CSS pixels, runs axe, and restores the original
appearance preference. Do not use a normal personal browsing profile or expose
DevTools publicly. Theme changes are account-wide while the audit runs. No
billing, infrastructure, or customer mutations are part of this runner.

Evidence defaults to `src/.local/dark-mode/cdp-audit`. It is private and must not
be committed. Capture success is not visual acceptance: rows remain unreviewed,
axe can miss contrast problems, and root overflow checks miss inner scrolling.
A narrow desktop viewport is not a substitute for real iOS Safari, touch, or
software-keyboard testing. Use `--routes`, `--widths`, and `--output` to isolate
follow-up captures after a completed static rebuild.
For editor captures, supply `--ready-selector` with a visible editor-specific
selector (for example `.CodeMirror` for a code editor). The runner waits up to
45 seconds for it and rejects blank/connecting captures. Still inspect every
screenshot: a loaded shell does not establish that the target editor loaded.

## Fixed-color Review Queue

Run `node src/scripts/appearance/inventory-fixed-colors.mjs` from the repo
root (or add `--json` for exact member-reference lines). The syntax-tree scan
finds named, aliased, mixed, and namespace imports of `@cocalc/util/theme`
across packages. The initial snapshot is in
`src/.agents/fixed-color-inventory-2026-09-06.md`.

Treat every entry as unreviewed until its usages and callers are inspected.
Work through admin/billing, project navigation, then editor surfaces in scoped
batches. Map neutral and status colors by semantic role, not by similarly
named constants; always pair text and backgrounds. Preserve intentional
branding and authored document colors. Canvas, terminal, chart, and color-mixing
APIs may require resolved concrete palettes instead of CSS variables.

For each batch, record migrated usages or the reason for retaining fixed colors,
run focused tests and lint, and review light/dark screenshots including loading,
empty, selected, disabled, and expanded states. Audit static `Modal.*` calls,
raw inline colors, stylesheets, and third-party widgets separately: changing
`COLORS` imports alone cannot cover those. Static Ant Design modals need a
context-aware hook with its holder inside the themed tree.

Stripe Elements supports the `night` appearance theme. Embedded Checkout is a
different integration using Stripe branding settings; do not invert its iframe,
change account-wide branding per viewer, or recreate payment sessions on theme
changes. No real payment is needed for appearance verification.

## Browser Checks

Run from `src` after rebuilding the static frontend with `pnpm static`:

```sh
eval "$(pnpm -s dev:hub:env)"
node scripts/appearance/audit-public.mjs
```

This launches an isolated, anonymous Chromium instance against
`https://lite2b.cocalc.ai`. It does not read account cookies or modify projects.
It checks 15 public routes in Light and Dark at 1440 and 320 CSS pixels, records
axe WCAG A/AA findings, captures screenshots, checks horizontal overflow and
page exceptions, and exercises explicit and System appearance changes.
Consent-dialog checks run while the dialog is fully visible; the page audit
waits for the actual closing transition rather than only its removed ARIA role.

Reports and screenshots default to `src/.local/dark-mode/public-audit`, which
is local evidence and should not be committed. A failed assertion gives a
nonzero exit status. `--no-fail` is useful only for an initial inventory; it does
not make findings acceptable.

Useful options:

```sh
node scripts/appearance/audit-public.mjs \
  --base-url https://lite2b.cocalc.ai \
  --routes /,/features/python,/docs/terminal/use-terminal,/auth/sign-in \
  --widths 1440,320 \
  --output .local/dark-mode/public-targeted \
  --chromium /usr/bin/chromium
```

The automated audit is not full release acceptance. Review the screenshots,
keyboard navigation, hover/focus/disabled states, open dialogs, long content,
auth transitions, and the signed-in editor workflows in the implementation
plan. Main-app validation should use a dedicated authenticated browser session
following `docs/browser-debugging.md`; do not use or alter a user's active
browser session for a systematic sweep. Never commit authenticated screenshots
or browser state files that may contain private data.

For a repeatable signed-in screenshot matrix, first create a dedicated browser
session and authenticate it through the local hub. Then pass its explicit
profile, API, browser, and disposable audit project to the typed-action runner:

```sh
node scripts/appearance/audit-signed-in.mjs \
  --profile native-appearance-local \
  --api http://localhost:9100 \
  --browser BROWSER_ID \
  --project PROJECT_ID \
  --output .local/dark-mode/signed-in-final
```

The runner covers account, notification, admin, project settings/files, and
Essential routes at desktop and mobile widths in Light and Dark. It writes a
JSON capture report after every route and restores the account-wide appearance
preference on exit. Every row intentionally remains `unreviewed` until a human
inspects its screenshot; a capture failure makes the command fail. Keep this
authenticated evidence under `.local` and never commit it.

The signed-in runner reloads before the sweep and rejects screenshots whose
reported path/hash differs from the requested route. Run it only after the
static build finishes, without rebuilding during the sweep. Correct business
routes are `/admin/customers`, `/admin/receivables`, and
`/admin/membership-tiers`. Disabled capabilities do not count as populated
workflow coverage.

Run anonymous startup and timing checks with:

```sh
node scripts/appearance/audit-runtime.mjs
node --test scripts/appearance/route-check.test.mjs
```

Runtime checks measure native input-to-following-frame latency, keyboard focus,
System changes, and prepaint with external scripts blocked, including blocked
storage. Only unthrottled samples use the provisional 100 ms desktop p95 gate;
4x throttled samples are separate diagnostics. They do not establish notebook,
terminal, or streaming-chat state preservation or performance.
