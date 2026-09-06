# Systematic Appearance Audit: September 6 Follow-up

## Scope and Result

Completed a broad Chromium regression pass against the local lite2b deployment,
plus source review and focused tests. This is not full implementation-plan
signoff or a claim that every fixed-color reference is correct.

Two additional groups of problems were fixed:

- Site-license dashboard and provisioning panels: light backgrounds, fixed
  accent colors, approval rows, pool summaries, and shadows now use semantic
  appearance tokens. The intentionally dark blue header with explicit white
  text is retained. No licensing, billing, authorization, or routing logic changed.
- CPU and network-egress history: chart strokes, timestamps, secondary copy,
  hover panels, borders, and event labels now follow appearance. These render
  as DOM/SVG, so CSS variables are supported; no canvas color parser is involved.

The signed-in capture runner also now supports `--ready-selector` and rejects
blank/connecting screens. Its former one-second capture delay produced several
misleading editor screenshots. Those original captures are excluded as evidence.

## Browser Evidence

Private screenshots and JSON reports remain under `src/.local/dark-mode/`;
they are deliberately not committed.

| Evidence directory                       | Coverage                                                                                 | Result / limitation                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `systematic-public-sept6`                | 15 public routes, Light/Dark, 1440/320 CSS pixels; 60 route captures plus consent states | No automated WCAG A/AA violations or document overflow. Desktop/mobile contact sheets and representative screenshots reviewed. This samples route families, not every docs article or interactive state.     |
| `systematic-sept6`                       | 17 signed-in routes in both themes, 1440 pixels; 34 captures                             | No reported page exceptions or automated contrast violations. Contact sheets reviewed. Empty user-search, VM error/empty states, and unpopulated project views do not establish populated-workflow coverage. |
| `systematic-editors-ready-sept6`         | Notebook with plots and LaTeX rich editor/PDF, both themes                               | Repeated with visible CodeMirror readiness; loaded screenshots reviewed. Plot/PDF white backgrounds intentionally preserve authored output.                                                                  |
| `systematic-documents-ready-sept6`       | Course assignment list, whiteboard with note, Slate Markdown, both themes                | Repeated after file-tab readiness; loaded dark screenshots reviewed. Whiteboard paper and note ink remain light-content islands, with dark surrounding controls.                                             |
| `systematic-sept6/provision-*.png`       | Site-license provisioning dialog, both themes                                            | Reviewed after rebuild, including default student/instructor/researcher draft pools. Opened and closed only; no license provisioned.                                                                         |
| `systematic-sept6/network-history-*.png` | Populated account network history, both themes                                           | Reviewed chart, metrics, labels, categories, and recent events after rebuild. CPU hover behavior has component coverage, not a separate live populated screenshot.                                           |

The original `systematic-editors-sept6` captures include blank/connecting
screens and must not be counted as successful editor verification.
The project log/agents entries in the general sweep are not deep workflow
acceptance; the session's saved filters/layout left little or no populated
content in those particular screenshots.

Signed-in browser work used separate tabs in the user-authorized isolated CDP
profile, restored appearance on exit, and closed only audit-created tabs.
No document content was edited, notebook cells executed, payments submitted,
customers contacted, or infrastructure provisioned. Opening project files can
still update normal recent-file/activity state.

## Startup and Performance

`audit-runtime.mjs` passed against the landing page and terminal docs page:

- Dark System appearance applied before external app scripts, with both normal
  and blocked localStorage.
- Live OS light/dark changes kept the selected preference at System.
- Keyboard focus remained on the selector through repeated theme changes.
- Unthrottled input-to-following-frame p95: landing 85.7 ms; docs 68.9 ms.
- Separate 4x CPU-throttled p95: landing 399.5 ms; docs 348.7 ms. These are
  diagnostics, not evidence of sub-100-ms performance on slow devices.

No Dark Reader matches were found in the checked frontend/static/Essential
package manifests or built static JavaScript chunks.

## Tests

- Frontend appearance and downloaded-HTML group: 15 suites, 45 tests passed.
- Site-license manager: 36 tests passed, including new themed-panel assertions.
- CPU hover appearance: one new component test passed (also included in the
  appearance group above).
- Egress helpers, control, and Ant Design context: 18 tests passed in an earlier
  focused run; some overlap with the appearance group.
- Utility preference/store/browser/bootstrap: 4 suites, 43 tests passed.
- Audit route matching: 3 tests passed.
- Frontend lint, solution typecheck, static rebuild, formatting, and diff checks
  passed. Build retained the existing bundle-size warnings.

## Remaining Review and Explicit Limits

- The refreshed fixed-palette inventory has 248 files / 1139 references, down
  from 250 / 1185 before this pass. This is a review queue, not a bug count.
  It includes tests, backend/email output, branding, authored content and
  concrete-color renderers. No global replacement or inversion filter was added.
- Signed-in axe findings remain: missing button/input/progressbar names,
  nested interactive elements, and editor accessibility roles. These occur in
  both themes and need a separate interaction/accessibility remediation pass;
  lack of automated contrast violations is not full accessibility acceptance.
- Actual iOS Safari/touch/software-keyboard, Firefox/WebKit, and running
  CoCalc Plus remain outside this live Chromium pass. Earlier Lite visibility
  regression tests are not a running desktop-app screenshot.
- No forced logout/login or cross-account changes were performed in the supplied
  signed-in profile. Preference race/migration behavior has unit coverage.
- No kernel/terminal restart, undo-history, or actively streaming chat state
  preservation experiment was performed here. Read-only editor screenshots do
  not prove those properties.
- VM workflows still lack configured GCP data. Public policies/news and empty
  search results only cover the currently configured empty states. Site-license
  provisioning was inspected as a draft, not as a live completed workflow.
- Contact sheets establish broad surface review, not pixel-by-pixel approval of
  all full-height content, every overlay, hover, focus, disabled, or error state.

Keep these limits visible when reviewing the original implementation plan;
do not mark its complete acceptance checklist solely from this audit.
