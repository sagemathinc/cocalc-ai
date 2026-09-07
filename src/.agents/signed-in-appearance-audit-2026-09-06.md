# Signed-in appearance audit, September 6, 2026

## Scope and evidence

Used the explicitly authorized isolated laptop Chrome through the loopback SSH
DevTools tunnel on port 9222. Created a separate audit tab and restored the
original appearance preference. No payments, customer changes, infrastructure
operations, or site-setting saves were performed.

The initial matrix captured 11 routes x 2 themes x 2 viewport widths: 44
screenshots, no capture failures. PNG dimensions all matched 1440x1000 or
390x1000 despite the user resizing the outer browser during capture.
Private evidence: `src/.local/dark-mode/cdp-audit/report.json` and adjacent PNGs.
The repeatable runner is `src/scripts/appearance/audit-cdp.mjs`.

Routes: projects, project hosts, virtual machines, notifications, balance,
payment methods, usage/limits, site settings, CRM, receivables, membership tiers.
These are viewport captures, not exhaustive coverage of every panel or state.

## Findings addressed

- The compact AI usage meter now explicitly labels usage percentages, uses
  recessed empty segments and colored filled segments, and exposes numeric
  meter semantics. Missing quota data is labeled Unavailable, not zero. Focused
  tests cover zero, partial, full, and unavailable states.
- Notification descriptions, metadata, and read rows use semantic text colors.
  Ordinary Slate link chips inherit a themed surface; default links follow the
  application link color while concrete code syntax palettes remain intact.
- Selected Ant Design tabs and their indicator use accessible dark-mode link
  colors, preserving light-mode defaults.
- Site-settings helper text, subgroup labels, and missing/complete indicators
  use paired semantic tokens instead of fixed gray and pastel colors.

Follow-up private evidence is in `src/.local/dark-mode/dialog-check`. The live
Balance account returned unavailable quota windows, so numeric usage states
are unit-tested, not claimed as live-account verification.

## Visual review and limitations

Manually inspected representative desktop light and dark host/payment views,
dark notifications, VM, usage/limits, site settings, populated CRM and AR,
membership tiers, narrow hosts and payment methods, and the updated Balance
dialog in both themes. Not every captured image has received manual review;
machine report rows deliberately retain their unreviewed status.

Final follow-up captures also cover host drawer overview and site settings in
both themes. Reviewed the dark versions: surfaces and subgroup labels are
readable. The Current metrics heading is visible, but its full contents are
below the viewport and are not certified by that capture.

Major desktop surfaces in CRM, AR, membership tiers, and payment-method rows
are readable in the inspected views. This does not certify all expanded
records, editors, loading states, confirmations, or third-party payment forms.

Remaining findings:

- Expanding payment-method Raw reveals a white outer wrapper around the dark
  syntax block. The inner code theme changed correctly, but its wrapper and
  footer still need migration (confirmed in the final dark screenshot).

- Narrow account/admin sidebars consume most of the content width. Inner
  horizontal scrolling/clipping is not detected by the root overflow check.
  The user confirms severe real-phone Codex chat usability problems. Track
  mobile web layout separately, with chat first: readable conversation width,
  composer and keyboard behavior, navigation collapse, long tool output, and
  touch interactions. A future native app does not replace this requirement.
- VM data is empty and GCP configuration is missing. Only its empty/error
  presentation was inspected; populated VM workflow coverage is still absent.
- Small preset status tags on hosts and legacy mention chips still merit a
  contrast/consistency pass. Do not broadly override authored content colors.
- Axe reports unnamed controls/progressbars on hosts, unnamed buttons and
  nested interactive controls on notifications, and unnamed controls on
  several narrow admin/account views. See per-selector findings in the private
  JSON. These are unresolved accessibility issues, not passing checks.
- Axe reported no contrast violations even where manual review found gray
  notification text. Its result is not sufficient for contrast acceptance.
- Real iOS Safari, software keyboard, editor state preservation during theme
  switches, Stripe iframe behavior, and every remaining fixed-color inventory
  entry are not covered by this sweep.
- Translation Info follow-up automation timed out locating its menu entry;
  that dialog is not claimed as visually verified in this pass.

## Validation

Six focused frontend suites passed (32 tests): AI usage, Balance, notification
rows, Slate inline links/code, readonly links, and appearance context. Frontend
lint and the static build/typecheck passed. Static bundling retains its existing
asset-size warnings. Authenticated screenshots and browser data stay local.
The additional selected-tab regression and site-settings row suite also passed
(12 tests in their final two-suite run).
