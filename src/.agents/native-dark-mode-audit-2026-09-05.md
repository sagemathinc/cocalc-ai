# Native Dark Mode Audit

Date: 2026-09-05

## Result

The initial implementation audit covered the representative first-party public,
signed-in, project, and Essential surfaces listed below. It did not complete the
full implementation plan's acceptance gates. The audit found several
remaining fixed-light application surfaces; the user-visible defects discovered
during this pass were converted to semantic appearance tokens.

See the implementation plan's Acceptance Follow-Up for newer findings and
evidence. In particular, route capture success alone does not verify the route
was reached or that the browser loaded the current build.

This is not a claim that authored content is recolored. PDFs, notebook output,
plots, whiteboard pages, syntax themes, images, and third-party applications
retain their own colors by design.

## Automated Coverage

- Public site: 15 routes at 1440px and 320px, in Light and Dark, for 60 probes.
  There were no capture failures, axe violations, or overflow failures. Evidence:
  `.local/dark-mode/public-final/report.json`.
- Signed-in app: 19 routes at 1440px and 390px, in Light and Dark, for 76
  captures. There were no capture failures. Evidence:
  `.local/dark-mode/signed-in-complete-final/report.json`.
- Signed-in routes include projects, all main account-settings sections,
  notifications, admin, project settings/files/Apps/New, and Essential
  projects/files.
- Direct dark-state captures cover Recent Activity and Create Project. Evidence:
  `.local/dark-mode/state-recent-activity-dark.png` and
  `.local/dark-mode/state-create-project-dark.png`.

## Findings Corrected

- Project list, file browser, directory overlays, loading states, and project
  flyouts no longer rely on fixed white panels or fixed dark text.
- Account settings cards, section headings, usage meters, and Codex credentials
  use paired semantic foreground/background tokens.
- Project Apps cards, status panels, configuration forms, and preset tiles use
  dark surfaces with readable metadata.
- New-file Quick Create labels and controls use semantic text and surfaces.
- Root filesystem selection, publishing, technical details, and catalog cards
  use semantic surfaces. Catalog title, metadata, and description colors remain
  readable when a catalog theme supplies an accent color.
- Create Project uses semantic modal, health, image, host, and summary panels.
- Recent Activity uses semantic modal/list/selected-row colors.
- Codex settings/payment surfaces, the chat shell/sidebar, attachment controls,
  composer, and shared Markdown input chrome use semantic colors.
- The public appearance menu now uses the same compact control as the app shell.
- Extending the Ant Design theme no longer discards existing component tokens.

## Source Inventory

The final literal-light-background scan records 157 matches in
`.local/dark-mode/residual-fixed-light-backgrounds-final.txt`. A raw match is
not automatically a defect. The remaining inventory primarily falls into:

- authored/document surfaces: PDF and media pages, notebook outputs,
  whiteboards, rendered Markdown, code/syntax themes, and public viewers;
- deliberate status/brand swatches where both foreground and background are
  explicitly paired;
- routes outside the representative acceptance matrix, including specialized
  admin, host, billing, course, and destructive-action dialogs.

The last category remains a useful backlog for route owners. It should be
converted and visually verified when those workflows are changed; it must not
be globally rewritten because the first two categories intentionally preserve
content colors.

## Validation

- `packages/frontend`: `pnpm tsc --build`
- `src`: `pnpm lint:frontend`
- Focused frontend tests: 76 tests passed across appearance, public navigation,
  project creation/New, file listing, and Codex/account settings.
- Additional chat/rootfs tests: 27 tests passed.
- `src`: `pnpm static`

## Remaining Limitations

- Chromium on lite2b is the browser used for visual acceptance. Safari and
  Firefox were not visually exercised in this audit.
- The signed-in script captures route states but does not run axe in the
  authenticated browser sandbox; accessibility behavior is covered by focused
  tests and frontend lint, while axe coverage is currently public-site only.
- A static rebuild intentionally produced an in-app “updated” banner in some
  matrix screenshots. That banner is not a dark-mode failure.
- Specialized routes named in the source inventory are not silently declared
  complete. Future audits should add them to the signed-in matrix when stable
  fixtures are available.
