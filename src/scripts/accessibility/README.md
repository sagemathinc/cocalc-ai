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
