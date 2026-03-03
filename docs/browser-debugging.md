# Browser Debugging with `cocalc browser`

This guide is for agent-driven debugging in a live CoCalc browser session.

It is specifically useful when unit tests pass but behavior in the real app still fails.

## Why this matters

In practice, these bugs often come from runtime differences:

- wrong server/port (`7000` vs `7003`)
- wrong browser session id
- stale bundle in an existing tab
- multiple Slate editors mounted, and instrumentation hitting the wrong one
- selection/range state that only appears in real DOM/editor integration

## Minimal workflow (recommended)

0. Bootstrap env quickly (recommended).
   - Lite: `pnpm --dir src dev:env:lite`
   - Hub: `pnpm --dir src dev:env:hub`
   - Apply exports into current shell:
     - `eval "$(pnpm -s --dir src dev:env:lite)"`
     - `eval "$(pnpm -s --dir src dev:env:hub)"`

1. Confirm target server and auth context.
   - `cd src && pnpm lite:daemon:status`
   - Read the `url` (e.g. `http://localhost:7003`).

2. List browser sessions for that exact server.
   - `COCALC_API_URL=http://localhost:7003 COCALC_BEARER_TOKEN='' cocalc browser session list`

3. Use the returned `browser_id` explicitly in every command.
   - `COCALC_API_URL=http://localhost:7003 COCALC_BROWSER_ID=<id> COCALC_BEARER_TOKEN='' cocalc browser exec-api`

4. Open a clean repro file from browser-exec itself.
   - Write file with `api.fs.writeFile(...)`
   - Open file with `api.openFiles([...])`

5. Probe the runtime editor instance and verify you have the right one.
   - Enumerate `[data-slate-editor="true"]`
   - Resolve React fiber editor refs
   - Pick the editor with expected text/content

6. Reproduce by mutating the real editor object.
   - Set selection
   - Call `editor.insertText(...)`
   - Return `before/after` children snapshots

7. Capture a screenshot when visual state matters.
   - `cocalc browser screenshot --selector body --out /tmp/repro.png`

8. Patch code, run focused tests, rebuild frontend, restart lite daemon, and retest in browser.

## Practical debugging tips

- Always set `COCALC_API_URL` for each command when using multiple servers.
- In lite mode, `COCALC_BEARER_TOKEN=''` is often correct.
- If behavior does not match code, assume stale JS bundle first.
- For Slate bugs, check both:
  - `editor.selection` shape/path
  - what `editor.range(path)` and `editor.string(path)` return at runtime
- If two editors are present, never assume `querySelector(...)` returns the active one.

## Browser API Wishlist

These are improvements that would speed up real debugging and reduce mistakes.

### Session targeting

- `cocalc browser session list --api <url> --project-id <id> --active-only`
- `cocalc browser use --api <url> <browser_id>` scoped by API URL
- Better default-session resolution when multiple servers are active

### Better runtime inspection helpers

- Built-in helper to return the active Slate editor(s) with identifiers
- Built-in helper to return mounted React roots/components by predicate
- Built-in helper to dump Redux slices/state safely

### Event/telemetry capture

- `browser logs tail` for console logs/warnings/errors
- Network request trace capture for a time window
- Optional capture of uncaught errors/rejections with stack traces

### Action-level automation

- High-level actions: click, type, keypress, focus selector
- Wait helpers: `waitForSelector`, `waitForUrl`, `waitForIdle`
- Snapshot helper: DOM snapshot or screenshot from CLI

### Screenshot support (next iterations)

- First pass now exists:
  - `cocalc browser screenshot --selector "<css>" --out /tmp/repro.png`
- Follow-ups:
  - `--fullpage` / viewport-mode controls
  - `--wait-for-idle`
  - direct blob/attachment output
  - richer failure diagnostics when client-side renderer cannot load

### Script ergonomics

- `--json` structured output mode for script results and errors
- `--eval-file` with sourcemap-ish line mapping for runtime errors
- Persistent script snippets/macros for frequent debugging tasks

### Safety/diagnostics

- "target context" banner in output: API URL, browser id, project id, active path
- Guardrail warning if browser session URL host/port mismatches `COCALC_API_URL`
- Optional dry-run mode that shows which session would be targeted
- Way to run the lite daemon and full hub daemon (launchpad) so that it is easy to get exactly the env needed, e.g., a valid `COCALC_BEARER_TOKEN`, etc. by just running a pnpm command.

## Implementation pointers

Most of this command surface is implemented in:

- `src/packages/cli/src/bin/commands/browser/*`
- `src/packages/cli/src/bin/cocalc.ts`

Recommended approach:

1. Implement screenshot as a new `browser` subcommand in CLI.
2. Reuse existing browser session resolution and context output.
3. Keep output compatible with agent workflows (`--json` + shell-friendly text).

## Known good pattern for live bug work

- Reproduce in runtime first
- Add a deterministic test that fails before the fix
- Fix narrowly
- Verify in runtime again
- Keep one commit for bug fix + regression tests
