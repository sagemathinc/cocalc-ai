# Accessibility Checks

These scripts run static audit-library tests, Lighthouse page audits, and
axe-core audits with optional interaction and focus assertions.

## Fast Checks

Run the script tests without starting CoCalc or Chromium:

```sh
pnpm -C src accessibility:test
```

Run frontend lint, including enabled `jsx-a11y` rules:

```sh
pnpm -C src lint:frontend
```

Both commands fail on violations. The script tests run in the CI checks job.

## Browser Audits

Start the relevant local environment before running a browser audit. See the
root `AGENTS.md` for the Lite and hub environment commands.

Audit all configured pages:

```sh
pnpm -C src accessibility:audit
```

Audit public pages without authentication:

```sh
pnpm -C src accessibility:audit:public
```

Audit scripted interactive states:

```sh
pnpm -C src accessibility:audit:interactive
```

Use `--pages` to limit a run to changed surfaces and `--project-id` for project
routes. For example:

```sh
pnpm -C src accessibility:audit -- --pages pricing,features
pnpm -C src accessibility:audit:interactive -- --pages project-new-file --project-id UUID
```

Run `pnpm -C src accessibility:audit -- --help` for all options. Reports are
written under `src/.local/accessibility/` by default.

## Adding Coverage

- Add ordinary page audits to `pages.json`.
- Add states that require opening a dialog, changing focus, or invoking a
  control to `scenarios.json`.
- Give each entry a stable, descriptive `id` and select the smallest reliable
  ready condition.
- Prefer role/name selectors when supported. Use CSS selectors only when the
  audit action format or target has no appropriate accessible query.
- For dialogs and overlays, assert initial focus, Escape dismissal, and focus
  restoration when applicable.
- Keep deterministic behavior in component tests when possible; browser audits
  should cover integration behavior that component tests cannot establish.

Lighthouse and axe do not prove WCAG conformance. Manually review keyboard
operation, focus visibility, responsive reflow, zoom, contrast across affected
states, and motion behavior for substantial UI changes.

`collaborators-workspace.mjs` exports additional interaction checks for an
isolated, populated Collaborators fixture. `checkCollaboratorsProjectPins(page,
projectTitle)` exercises keyboard pinning, the pinned-only view, removal focus,
and restores the original pin. `checkCollaboratorsSharing(page, options)` starts
from an open resource overview and checks destination selection, audience,
Escape, focus restoration and reachable controls. Supply the destination's full
accessible button name. Its optional `addReference: true` changes a private draft
only, so use a disposable fixture; neither check sends messages or runs agents.
Run at desktop and 320px widths, light/dark themes and 200% browser zoom. These
helpers supplement, not replace, the automated component and axe audits.

Run the isolated Manual Scan dialog audit from the repository root:

```sh
node src/scripts/accessibility/manual-scan.mjs
```

It renders the actual component against deterministic RPC responses and uses
disposable Chromium profiles for light/dark at 100% and 200% native browser
zoom. The audit verifies the resulting 320 CSS-pixel viewport and device scale;
it does not substitute CSS `zoom`. It checks keyboard selection/start/cancel,
reload, result pagination, explicit retry, Escape focus restoration, reachable
controls, and axe violations. It needs Chromium (default `/usr/bin/chromium`,
override with `CHROME_BIN`) but no live CoCalc login. The separate
`server/collaborators/scan-browser.acceptance.test.ts` covers real service RPCs;
neither fixture substitutes for a signed-in deployment check.

`checkCollectionViews(page, label, pinnedTitle?)` exercises the shared collection
controls on Artifacts or populated Collaborators People/Projects/Conversations.
It switches list/grid using the keyboard, checks reachable controls and the
optional pinned-item keyboard drag/cancel, then restores the original view. Run against
isolated fixtures at the same widths/themes above; it does not alter pin order.
