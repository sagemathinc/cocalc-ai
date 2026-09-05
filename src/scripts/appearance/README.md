# Native Appearance Audits

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
