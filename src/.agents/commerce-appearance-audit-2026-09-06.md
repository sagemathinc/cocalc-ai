# CRM and AR appearance audit

Local site: https://lite2b.cocalc.ai. Dedicated signed-in Chromium session;
synthetic customer records only. No billing, provider or outreach mutations.

## Verified

- Server typecheck and all six fixture tests pass.
- All 13 focused frontend CRM/AR suites pass (54 tests).
- Expanded the fixture set to 120 customers/orders because both queues request
  100 rows per page. Stable IDs preserve earlier fixture edits.
- Inspected desktop light/dark screenshots of customer details, populated
  contacts, edit-profile dialog, lower customer sections and linked orders.
- Inspected desktop dark AR overview/actions, lower detail sections and the
  lower new-order form. No white-background/dark-text mismatch found in these
  captures. Existing invoice/payment sections are empty by design.
- Mobile light customer detail and edit-profile dialog fit at 390px. Mobile
  light/dark queue headers and summary panels fit for CRM and AR.
- CRM Load more adds the final records and disappears, confirmed by screenshot.
  The subsequent remote selector assertion timed out, so this is visual rather
  than a completed automated assertion.

## Evidence and limits

Private local screenshots: `src/.local/dark-mode/commerce-workflows/`,
`commerce-mobile-queues/`, and `pagination-probe.png`. The workflow runner stopped
at a mobile AR scroll action; some captures retain the previous scroll position.
Do not interpret successful screenshot capture as full-page coverage.

Browser actions intermittently time out on the browser-session RPC despite
native screenshots continuing to work. Retried with the resolved session ID.
Raw DOM access is unavailable under the current browser execution policy;
no injected axe/contrast scan was performed or claimed.

Still required: AR next/previous pagination and no-results assertions; complete
mobile dark detail/form coverage; keyboard focus restoration assertions;
invoice/payment/provider-dependent states using isolated test providers; numeric
contrast audit of colored tags/icons and secondary labels. This is not a full
CRM/AR appearance sign-off or completion of the broader dark-mode plan.
