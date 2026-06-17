# AGENTS.md, CLAUDE.md and GEMINI.md

Guidance for Claude Code, Gemini CLI, and OpenAI Codex when working in this repository.

## Repo Facts

- CoCalc-ai source monorepo (TypeScript-heavy) under `src/packages`.
- Workspace management uses pnpm (`src/packages/pnpm-workspace.yaml`).
- Prefer package-local changes and checks over full-repo commands when possible.

## Preferred Commands

- Run these from the repo root unless a command says otherwise.
- Full dev build: `pnpm -C src build:dev`
- Full typecheck: `pnpm -C src tsc`
- Dev/browser environment bootstrap:
  - Lite: `cd src && pnpm dev:lite:env` to print the environment for lite development and browser automation, including the correct `COCALC_API_URL` (typically port `7001`), browser session, and PATH updates. Use `eval "$(pnpm -s dev:lite:env)"` to apply it to the current shell.
  - Hub / full multi-user launchpad: `cd src && pnpm dev:hub:env` to print the corresponding environment for hub-backed development. Use `eval "$(pnpm -s dev:hub:env)"` to apply it to the current shell.
- Prettier (repo-pinned): `pnpm -C src prettier --write <file>`
- Frontend lint (fast): `pnpm -C src lint:frontend`
- Package typecheck (fast): `cd src/packages/<pkg> && pnpm tsc --build`
- Package build: `cd src/packages/<pkg> && pnpm build`
- For `next` / `static`: use `pnpm -C src build:dev` instead of `pnpm -C src build`
- Tests: run focused package/tests first; avoid full test suite unless needed
- Dependency consistency check: `pnpm -C src version-check`

## Live Hub Env

- Before running live Lite/Launchpad control-plane commands such as `cocalc host ...`, `cocalc project ...`, or browser-driven validation against the local dev hub, refresh the hub env first:
  - `cd src && eval "$(pnpm -s dev:hub:env)"`
- Do this again after restarting the hub, switching between local hub instances, or resuming a stale shell. Otherwise `cocalc` can silently use outdated credentials and fail with misleading auth/control-plane errors.
- When a task depends on upgrading hosts or validating live project-host behavior, assume this step is required unless the current shell definitely just ran it.
- For dangerous CLI operations that require fresh auth in local dev, use `cocalc auth elevate --dev` when the local hub password and database are available. This bootstraps a cookie-backed dev fresh-auth session; raw bearer, API-key, or hub-password auth alone will still fail fresh-auth checks.

## Live Lite / Browser Env

- Before using `cocalc browser ...` or other live browser automation against the local Lite or Launchpad dev servers, always load the matching env in the current shell:
  - Lite: `cd src && eval "$(pnpm -s dev:lite:env)"`
  - Hub: `cd src && eval "$(pnpm -s dev:hub:env)"`
- This is not optional for reliable targeting. The env sets the correct `COCALC_API_URL`, browser session, project id, auth token, and PATH.
- If the wrong env is loaded, `cocalc browser` can fail with misleading errors, e.g. trying to use hub/project-host resolution against Lite, or targeting the wrong browser session entirely.

## Hard Rules (CoCalc-Specific)

- Use `@cocalc/*` absolute imports for cross-package imports.
- Use `import type` for type-only imports.
- Use `COLORS` from `@cocalc/util/theme` instead of ad-hoc color literals.
- Use package logging utilities (`getLogger`) for persistent logging; avoid `console.log` except temporary debugging.
- Prefer Conat RPC APIs (`src/packages/conat/hub/api`) over Next API routes in `src/packages/next/pages/api/v2`.
- For direct DB access in hub/backend, use `getPool()` from `@cocalc/database/pool`.
- Keep dependency versions aligned across packages; update matching `@types/*` packages when applicable.
- Redux store values are deep-converted with Immutable.js at runtime. Do not assume nested values returned by `useTypedRedux` are plain objects just because the TypeScript type says so; normalize or use `.get(...)`/`.toJS()` before nested property access.

## Multibay Architecture Rule

- Before changing auth, accounts, billing, projects, collaborators, hosts, project files, backups, secrets, public sharing, or Conat control-plane APIs, read `src/.agents/scalable-architecture.md`.
- Treat Launchpad as the one-bay special case of the same architecture, not a separate architecture.
- Always ask: which bay is authoritative for this data or action?
- Route by explicit ownership: account `home_bay_id`, project `owning_bay_id`, and host `bay_id`.
- Do not assume the local bay/database is authoritative unless the code has resolved ownership or is documented as one-bay-only.
- Cross-bay project operations must use the inter-bay/project-host routing layer, not direct local DB/project-host shortcuts.
- For project-to-project operations, assume source and destination projects may belong to different bays unless the operation explicitly requires same-host/same-bay semantics.
- Keep the control plane and data plane separate: hubs/bays authorize, route, synchronize state, and issue scoped project-host access, but steady-state project traffic such as files, terminals, Jupyter, Codex, previews, and app/server proxying should flow directly between the user/client and the project host whenever possible.
- Do not proxy project data through the hub/control plane unless there is a documented reason. If a new access mode needs different permissions, prefer a distinct project-host subject/service with narrower capabilities over hub-mediated data access.

## Git and Validation

- By default, agents should auto-commit completed change-sets after relevant validation passes.
- The default workflow is: make the change, run the relevant checks, commit, then let the user review and request follow-up fixes in a new commit if needed.
- Do not wait for an explicit "commit" request unless the user asked not to commit, the work is clearly exploratory/incomplete, or there are unrelated worktree changes that would make an automatic commit unsafe.
- Commit messages should be prefixed by area/package, e.g. `frontend/chat: ...`.
- By default, write commit messages with:
  - a concise first line (subject), and
  - a detailed markdown body explaining details of the commit, which is more succinct than the agent turn summary, including only information that is valuable longterm.
  - do not include a dedicated `Tests and validation` section; mention verification only when it adds long-term value.
  - do not embed literal escaped newlines (e.g. `\n` or `\\n`) in commit messages.
  - For multiline commit messages, always use stdin/heredoc or a message file instead of `git commit -m`.
  - In `exec_command` / shell tool calls, do not rely on quoted `\n` sequences to create commit-message line breaks; use literal newlines in the heredoc body.
  - Safe default pattern:

```
git commit -F - <<'EOF'
<subject line>

<body>
EOF
```

- `git commit -m` is only for subject-only commits with no body.
- Prefer follow-up commits over amending or rewriting history unless the user explicitly asks for that.
- For new source files that use the standard CoCalc file header comment, set the copyright year to the current year.
- Before finishing a change-set, run relevant typecheck/tests for touched packages.
- Run `pnpm -C src prettier --write <file>` on modified files as needed.
- For frontend changes, also run `pnpm -C src lint:frontend`. Treat frontend lint failures the same way as test or typecheck failures.

## Public Site and Artifact Hygiene

- Treat public React routes, public metadata, and files under `src/packages/frontend/public` as user-facing publication surfaces. Do not copy internal pitch language, competitor research, agent planning notes, or compliance interpretation into them unless the user explicitly approves that exact public wording.
- For CoCalc.ai public-site, landing-page, feature-page, product-page, guides, CTA, or public-copy work, use the repo skill `.agents/skills/public-site-landing-page/SKILL.md` and the operating audit `src/.agents/landing-page-agent-operating-audit.md` as the durable workflow standard.
- Keep scratch browser-QA screenshots, Playwright traces, generated reports, terminal transcripts, and temporary research files outside the repository, preferably under `/tmp/cocalc-public-qa-*`.
- Commit only source, tests, and intentional docs. Do not commit generated QA artifacts or candidate screenshots unless they are approved public assets with a clear freshness/source rationale.
- Before committing public-site work, run `git status --short`, review `git diff --name-only`, and check untracked files with `git ls-files --others --exclude-standard` so accidental scratch artifacts do not enter the repository.
- When a public page needs evidence, prefer route-specific workflow examples and approved existing assets. Do not invent metrics, customer proof, benchmark numbers, security/privacy claims, or specific UI counts that could be mistaken for validated proof.

## Docs

- Architecture/docs: `docs/`
- Translation workflow: `docs/translation.md`
- Browser runtime debugging via `cocalc browser`: `docs/browser-debugging.md`
  - Includes both live-user-session targeting and dedicated Playwright-backed spawned sessions.
