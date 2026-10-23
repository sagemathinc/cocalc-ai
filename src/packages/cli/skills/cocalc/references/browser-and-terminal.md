# Shared browser, shared terminal, browser exec

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

## Shared Browser: Browse The Web With The Human Watching

When a task needs a real web browser (testing a web app served from the
project, reading pages that need JavaScript, filling forms, screenshots), use
the project's shared browser. A headless Chromium ships with CoCalc, so there
is nothing to install. The human sees it live in a chat card and can take over
at any time; prefer it over launching your own browser.

```bash
cocalc project browser start --path <chat> --thread-id <thread> \
  --message-date <this turn's message date>
```

The three values are the current turn's publication context (they default to
`COCALC_CODEX_CHAT_PATH`, `COCALC_CODEX_THREAD_ID` and
`COCALC_CODEX_MESSAGE_DATE` when those are set).

`start` is idempotent: it starts the browser (or reuses it) and publishes the
card once per thread. Then act on the tab the human sees with the built-in
commands (no library needed):

```bash
cocalc project browser goto http://localhost:5173   # URL, host or search words
cocalc project browser text                         # URL, title, visible text
cocalc project browser click 'button[type=submit]'  # CSS selector, real click
cocalc project browser type 'hello' --selector '#q'
cocalc project browser press Enter
cocalc project browser eval 'document.querySelectorAll("a").length'
cocalc project browser screenshot --out /tmp/page.png   # then view the image
```

For heavier automation, `start` also prints `cdp`, a loopback Chrome DevTools
endpoint for any CDP client (Playwright `chromium.connectOverCDP(cdp)` and
then its existing context and page, Puppeteer `connect({ browserURL: cdp })`,
`chrome-devtools-mcp --browser-url <cdp>`). Disconnect when done; do not close
the browser or its last page.

- While the human drives, your commands wait until they hand back (all but
  protocol housekeeping, e.g. attaching to a tab). Do not treat the wait as a
  hang, and never work around it, e.g. through another connection to the
  browser: take-over is a cooperation rule, not a barrier.
- While the human drives you cannot see the page unless they click "Let the
  agent see": then `text` and `screenshot` work (read only; you still cannot
  act). Otherwise those two fail at once and say so: ask the human to click
  "Let the agent see" or to hand back; do not retry in a loop.
- For logins, CAPTCHAs, payments or anything needing the human's judgment or
  credentials, ask them to take over:
  `cocalc project browser ask-human --message "Please log in" --wait`.
  Never ask for passwords in chat.
- `cocalc project browser status` lists tabs and the driver;
  `cocalc project browser stop` stops it.
- Browsers keep sign-ins (encrypted with the `COCALC_BROWSER_KEY` project
  secret) once the human has opened a browser in the project. Never change or
  delete that secret: it signs every browser out.
- Pages on the project's own servers are reachable as `http://localhost:<port>`
  once the browser is on the project's network: a browser in its own
  container starts on its own (`goto` says so). Start it with
  `--network project` (or run `cocalc project browser network project`, which
  restarts it there, keeping its pages). The choice is remembered.
- Downloads land in the project's `~/Downloads`, whoever clicked (you, or the
  human driving). `cocalc project browser downloads --wait 60` lists recent
  ones with their paths. Playwright's own download API works as usual.
- User documentation: `cocalc docs show projects/web-browser`.
- A `.browser` file is a browser of its own (`--browser <file>` on every
  command; it has its own sign-ins). It can run on the user's computer instead
  of the project, so sites see their network and accounts (needed for sites
  that block cloud servers, e.g. X/Twitter sign-in). If it is not connected,
  commands say so: ask the user to run the printed
  `cocalc project browser connect --browser <file>` on their computer.

## Shared Terminal: Work Where The Human Can Watch

When the human should see what you run (long builds, servers, interactive
programs), work in a shared terminal shown live in a chat card. The human can
type in it too.

```bash
cocalc project terminal start --path <chat> --thread-id <thread> \
  --message-date <this turn's message date>
cocalc project terminal write <id> --enter 'make test'
cocalc project terminal history <id> --max-chars 4000
```

`start` is idempotent: one terminal per chat thread, and the card is
published once. It prints the session `id`. While the human is typing,
`write` returns `written: false`; wait and retry instead of using `--force`.

## Browser Exec Is For UI Work

Inspect the browser API with:

```bash
cocalc browser exec-api
```

This drives the user's CoCalc web UI, not the web in general; for browsing
websites use the shared browser above.

Use `cocalc browser exec` only when the task is specifically about:

- opening files or navigating UI state
- clicking, typing, scrolling, screenshots
- testing/debugging browser behavior
- browser-only inspection

Do not use browser exec for document operations that already have a backend API.
