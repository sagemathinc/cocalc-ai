# Automated accessibility auditing

CoCalc's local audit runner launches a dedicated system Chromium browser and
runs Lighthouse's accessibility category against a checked-in page matrix. It
also runs axe against deterministic interactive states, including keyboard and
focus assertions. Both public landing pages and authenticated application
pages are supported.

## Run the audit

Start the local hub/launchpad stack, then run:

```bash
pnpm -C src accessibility:audit
```

The checked-in default matrix covers routes across landing and product pages,
feature documentation, support and news, account preferences, project files,
and project settings. The runner reads the active hub development environment,
issues a local impersonation login URL, starts an isolated Chromium profile,
and audits every route in `src/scripts/accessibility/pages.json`. Reports are
written under `src/.local/accessibility/<timestamp>/`:

- `summary.md` gives the score and threshold for each page.
- `summary.json` is suitable for scripts and CI artifacts.
- `<page>.html` is the full interactive Lighthouse report.
- `<page>.json` contains complete machine-readable audit evidence.

Run only public pages without any authentication:

```bash
pnpm -C src accessibility:audit:public
```

Audit stateful dialogs and expanded controls:

```bash
pnpm -C src accessibility:audit:interactive
```

The interactive matrix opens controls using the keyboard, checks expected
focus placement, runs WCAG 2.x axe rules against the resulting state, and
checks focus restoration when the state closes. It currently covers expanded
pricing details, membership changes, SSH-key creation, the project new-file
view, the project file shell, and project settings. These scenarios do not
submit forms or mutate account/project data.

An explicit public URL does not require a running local development stack:

```bash
pnpm -C src accessibility:audit:public -- \
  --base-url https://cocalc.ai
```

Run a subset or override the site and project:

Replace the quoted project-ID placeholder below with your designated development project ID.

```bash
pnpm -C src accessibility:audit -- \
  --base-url https://lite1b.cocalc.ai \
  --project-id "<project-id>" \
  --pages landing,project-files
```

Use `--no-fail` for exploratory audits. The default command exits nonzero when
a page errors or falls below its configured minimum score.

## Add or tighten coverage

Edit `src/scripts/accessibility/pages.json` for route audits or
`src/scripts/accessibility/scenarios.json` for interactive states. Each entry
defines:

- a stable page id and title;
- a route, with optional `{project_id}` interpolation;
- whether account authentication is required;
- a readiness selector and short settling delay;
- the minimum accepted Lighthouse accessibility score.

Interactive entries use `"engine": "axe"` and an `actions` array. Supported
actions can locate an element by CSS selector, accessible role/name, or text,
then focus, click, press a key, wait for visibility, remember an element, or
assert focus. Optional `cleanupActions` close the state and verify focus
restoration after axe has collected its evidence.

Authenticated audits complete the local impersonation confirmation before
opening a route. They fail if an account or project route redirects to `/`;
this prevents a signed-out landing page from being reported as a passing
authenticated audit. Failed scenario setup also writes a screenshot and page
diagnostics alongside the axe or Lighthouse report.

Once a page reaches a higher score, raise its threshold in the matrix. This
turns future accessibility regressions into deterministic test failures while
retaining the full Lighthouse evidence needed to fix them.

Prefer representative, stable routes and non-destructive states over pages
whose useful state depends on ephemeral production data. Add editor scenarios
only after their file/session fixture can be created and cleaned up
deterministically.

For a non-local authenticated site, pass an explicit one-time login URL with
`--login-url`. The runner intentionally does not accept passwords or persist
the temporary browser profile by default.
