# AGENTS.md, CLAUDE.md and GEMINI.md

Guidance for Claude Code, Gemini CLI, and OpenAI Codex when working in this repository.

## Repo Facts

- CoCalc-ai source monorepo (TypeScript-heavy) under `src/packages`.
- Workspace management uses pnpm (`src/packages/pnpm-workspace.yaml`).
- Prefer package-local changes and checks over full-repo commands when possible.

## Preferred Commands

- Full dev build: `pnpm build:dev`
- Full typecheck: `pnpm tsc`
- Package typecheck (fast): `cd src/packages/<pkg> && pnpm tsc --build`
- Package build: `cd src/packages/<pkg> && pnpm build`
- For `next` / `static`: use `pnpm build:dev` instead of `pnpm build`
- Tests: run focused package/tests first; avoid full test suite unless needed
- Dependency consistency check: `pnpm version-check`

## Hard Rules (CoCalc-Specific)

- Use `@cocalc/*` absolute imports for cross-package imports.
- Use `import type` for type-only imports.
- Use `COLORS` from `@cocalc/util/theme` instead of ad-hoc color literals.
- Use package logging utilities (`getLogger`) for persistent logging; avoid `console.log` except temporary debugging.
- Prefer Conat RPC APIs (`src/packages/conat/hub/api`) over Next API routes in `src/packages/next/pages/api/v2`.
- For direct DB access in hub/backend, use `getPool()` from `@cocalc/database/pool`.
- Keep dependency versions aligned across packages; update matching `@types/*` packages when applicable.

## Git and Validation

- Commit messages should be prefixed by area/package, e.g. `frontend/chat: ...`.
- By default, write commit messages with:
  - a concise first line (subject), and
  - a detailed markdown body explaining details of the commit, which is more succinct than the agent turn summary, including only information that is valuable longterm.
  - do not include a dedicated `Tests and validation` section; mention verification only when it adds long-term value.
  - do not embed literal escaped newlines (e.g. `\n`) in commit messages.
  - For multiline commit messages, prefer stdin/heredoc form instead of escaped `-m` strings:
```
git commit -F - <<'EOF'
<subject line>
<body>
EOF
  ```
- If using `-m`, use multiple `-m` flags (one paragraph per flag) rather than embedding `\n`.
- For new source files that use the standard CoCalc file header comment, set the copyright year to the current year.
- Before finishing a change-set, run relevant typecheck/tests for touched packages.
- Run `prettier -w <file>` on modified files as needed.

## Docs

- Architecture/docs: `docs/`
- Translation workflow: `docs/translation.md`
- Browser runtime debugging via `cocalc browser`: `docs/browser-debugging.md`
  - Includes both live-user-session targeting and dedicated Playwright-backed spawned sessions.
