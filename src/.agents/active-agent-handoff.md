# Active-Agent Handoff Ledger

Live "who is doing what right now" board for concurrent agents (Claude, Codex,
Gemini). This is the FAST-CHANGING companion to the stable
`multi-agent-github-operating-model.md` (which holds the durable branch/worktree
map). Update the relevant block at the **start and end of every agent turn**.

## Rules (the "checkout system")

1. **One worktree per domain.** Platform UI → `/home/user/cocalc-ai`
   (`remove-empty-project-tag`). Public site → `/home/user/cocalc-ai-synthesis`
   (`blaec-synthesis-2026-06-18`). Never edit the other agent's worktree.
2. **Claim before editing.** List the files/routes you will touch under your
   block below. If they overlap another agent's active claim, STOP and coordinate.
3. **Commit at handoff.** Don't hand off uncommitted piles. Finish a bounded
   change → validate → commit → release the claim.
4. **One preview owner at a time.** `blaec.cocalc.ai` is served from ONE worktree.
   Verify before any build/preview: `ps -eo pid,cmd | rg 'packages/hub|node .*hub'`
   then `readlink /proc/<pid>/cwd`. Do not start a build that writes a `dist/` the
   other agent's preview serves while they're mid-turn.
5. **Serialize builds.** Two `build:dev`/`static:dev` runs against a shared cache
   can produce a mixed/stale bundle (this is what reverted the homepage). Only one
   agent builds at a time; the other waits for the commit + "build released".
6. **Validate the preview by CONTENT, not liveness.** HTTP 200 + metadata is not
   enough — a stale bundle still returns 200. Use the canary check
   (`public-site-browser-qa.mjs`, rendered-text assertions) before declaring a
   preview good.
7. **Scratch stays out of Git.** Screenshots/QA JSON/logs → `/tmp/cocalc-*` or the
   ignored `preview/`. Commit only source, tests, and intentional docs.

## Block template

```
Active agent:
Task:
Worktree / Branch:
Preview owner (this turn?):
Claimed files/routes:
Do not touch:
Validation required:
Last commit:
Open PR:
Next step:
Known risks:
```

---

## Current state (2026-06-18)

### Claude — now ASSISTANT / observer (role change 2026-06-20)

- **Role:** Codex now drives BOTH platform UI and the landing page; Claude is the personal
  assistant — tracks Codex's work, reviews changes/images against the Brief on request, and
  does NOT edit platform / `/tmp` worktrees (read-only via `git -C`). Editable home = this
  synthesis worktree, only when Blaec assigns public-site work.
- **VERIFIED REALITY 2026-06-20 (supersedes the stale lines in the Codex block below):**
  - **:9100 preview HANDED to synthesis 2026-06-20** (Claude, at Blaec's instruction): stopped
    the `public-site-pr-refresh` hub, rebuilt synthesis dist, started the synthesis hub (**pid
    228054**, `/home/user/cocalc-ai-synthesis/src`); cloudflared up, `blaec.cocalc.ai` 200,
    content canary 0 failures on / + /products. **CANONICAL landing-page branch =
    `blaec-synthesis-2026-06-18`** — the only branch carrying the operating system (Brief,
    /site-\* commands, Stop hook, C1/D1 tests) AND the latest content; the clean PR for William
    is re-sliced off `main` at the end. Re-verify owner each turn via `/proc` (NOT HTTP 200).
  - **Codex recovered + very active:** 9 worktrees; open PRs **#96 / #97 / #98**; a **24-file
    uncommitted pile** in `/home/user/cocalc-ai` that OVERLAPS files already on #96/#97/#98
    (highest coordination risk — divergent versions / clobbers). The "session lost" note below
    is historical.
  - **Public-site forked across 3 branches:** `blaec-synthesis-2026-06-18` = content source of
    truth (323 commits, **NO upstream → loss risk**); `public-site-pr` (clean staged);
    `public-site-pr-refresh` (clean, SSO superset, serving :9100 but **LAGS the 06-19 synthesis
    content**). Pick ONE canonical landing-page branch before deep work.
  - **Launchpad/Rocket "merge":** NOT a hard merge — shipped state is keep-5-products,
    group-as-3-operating-models (chooser intro `products/app.tsx:175-179`, commit `d30e9f0884`);
    the Brief still lists 5 distinct paths. A full 4-card collapse is proposed but unexecuted +
    gated on Blaec + William.
- **Image hand-off:** `/home/user/cocalc-shared/` (created, empty) — Codex drops mockups/
  screenshots there; Claude reads on request.
- **Claude's last actions:** reverted its temporary app-server-card overlay from the platform
  worktree; removed `/tmp/recover-wt`. Recovery branch `frontend/app-server-preset-card-compact`
  (@ `254013663a` — card redesign + drop-Learn-more) is preserved but in NO worktree — tell
  Codex it lives there so it isn't redone.

### Codex — public-site driver (START 2026-06-20 12:30 PDT)

- **Task:** take over public landing-site work under the synthesis operating system; read the
  required guardrails/brief/workflow/skill files; verify preview ownership; do branch hygiene
  before any new page edits.
- **Worktree / Branch:** `/home/user/cocalc-ai-synthesis` / `blaec-synthesis-2026-06-18`.
- **Preview owner this turn:** YES. Verified hub pid `228054`, cwd
  `/home/user/cocalc-ai-synthesis/src`; no second `build:dev` observed.
- **Claimed files/routes:** `src/.agents/active-agent-handoff.md` only for this start ledger
  update. No public route/content files claimed yet.
- **Do not touch:** `/home/user/cocalc-ai` platform WIP, `/tmp/public-site-refresh-wt`,
  `public-site-pr`, `public-site-pr-refresh`, or any public-site route until Blaec chooses the
  first evidence-gated round.
- **Validation required:** housekeeping/status audit only; no page build needed unless a source
  edit follows.
- **Last commit:** `fb87cbc1d1` (`frontend/public/products: drop the redundant closing section on
Plus/Star/Launchpad`).
- **Open PRs:** `gh pr list --repo sagemathinc/cocalc-ai --state open` currently returns none from
  this environment; prior ledger references #96/#97/#98, so treat PR status as a coordination risk
  until re-confirmed with Blaec/Claude.
- **Known risks:** branch has no upstream; `/home/user/cocalc-ai` still has 24 modified platform
  files on `frontend/files-toolbar-tooltip-polish`; `gh` is authenticated as `williamstein`, so PR
  authorship/attribution must be handled deliberately before any PR creation. Blaec explicitly
  said: do not create PRs unless he explicitly asks for one.
- **END 2026-06-20 12:32 PDT:** required guardrails/operating-system/brief/skill/ledger and
  `/site-*` prompt templates read; preview ownership re-verified; branch backup pushed and upstream
  set to `origin/blaec-synthesis-2026-06-18`; app-server preset-card recovery branch verified at
  `254013663a`. Platform 24-file WIP was audited but not modified, because it is outside the
  public-site lane and likely belongs to the existing platform PR stack. Next public-site round
  should be chosen by Blaec; the most recent concrete landing-page issue is the `/features`
  Automations card being too close to HTTPS Automations.
- **START 2026-06-20 12:38 PDT:** Blaec reports the updated preview is missing. Verified the hub
  still serves `/home/user/cocalc-ai-synthesis/src`; found the missing feature-page edits in
  `/tmp/public-site-refresh-wt`, not the canonical synthesis worktree. Claiming
  `src/packages/frontend/public/features/{app.tsx,catalog.ts,automations-page.tsx,more-languages-page.tsx,__tests__/app.test.tsx,whiteboard-page.tsx}`
  and `src/packages/util/public-site-metadata.ts` to port the relevant feature-index changes,
  make Automations distinct from HTTPS Automations, rebuild, then release.
- **END 2026-06-20 12:43 PDT:** restored the missing `/features` changes into synthesis: Project
  Automations replaces the API tile on the index, More Languages is a real feature page instead of
  a docs handoff, Dedicated Compute is shortened, and the index combines Whiteboard and Slides.
  Rebuilt `packages/static` preview bundle (`public-bbb33e6f2b7553d4.js`), verified live preview
  routes `/features`, `/features/automations`, `/features/more-languages` with 45 browser QA
  assertions / 0 failures, focused Jest passed (`public/features/__tests__/app.test.tsx`, 86
  tests), and `lint:frontend` passed. No PR created.
- **START 2026-06-20 13:19 PDT:** Blaec asked whether More Languages under-represents important
  languages CoCalc.ai supports. Verified preview still owned by synthesis hub pid `228054`, no
  active build, and current branch is clean with one local commit ahead of origin
  (`8f4a340f40`, whiteboard QA text). Claiming
  `src/packages/frontend/public/features/more-languages-page.tsx`,
  `src/packages/frontend/public/features/catalog.ts`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/util/public-site-metadata.ts`, and this ledger to broaden the More Languages copy
  and rebuild preview. No PR.
- **END 2026-06-20 13:25 PDT:** broadened More Languages from four example languages into
  audience-relevant language families: compiled code, scripting/shell, JVM/web, and data
  workflows. Updated the detail page, feature index summary, feature catalog metadata, public
  route metadata, and the compressed-page regression test. Validation: focused Jest
  `public/features/__tests__/app.test.tsx` passed (86 tests; existing React/AntD jsdom warnings),
  `lint:frontend` passed, `packages/static build:dev` passed, browser QA passed on `/features`
  and `/features/more-languages` (34 assertions / 0 failures total), and a live Playwright text
  assertion confirmed the new `/features/more-languages` content. No PR created.
- **START 2026-06-20 13:35 PDT:** Blaec approved the recommendation to resolve the
  `/features/whiteboard` vs `/features/slides` confusion, but asked for deeper research, stored
  per-action plans, and dynamic burn-down tracking before implementation. Verified branch clean at
  `def217aacd`, preview still owned by synthesis hub pid `228054`
  (`/home/user/cocalc-ai-synthesis/src`), and no active build. Claiming
  `src/packages/frontend/public/features/{whiteboard-page.tsx,slides-page.tsx,app.tsx,catalog.ts,__tests__/app.test.tsx}`,
  `src/packages/util/public-site-metadata.ts`, a new route plan under `src/.agents/`, and this
  ledger. No PR.
- **END 2026-06-20 13:49 PDT:** resolved the whiteboard/slides IA confusion by making
  `/features/whiteboard` the canonical "Whiteboards and Slides" discovery route and keeping
  `/features/slides` as a focused slide-deck detail route. Stored the researched burn-down plan at
  `src/.agents/public-site-whiteboards-slides-plan-2026-06-20.md`, removed `slides` from the
  feature-index discovery cards, added a slide-deck section to the canonical page, changed the
  canonical hero "Slide decks" action to scroll within the overview, updated direct `/features/slides`
  CTAs to point back to "Whiteboards and slides overview", and updated route metadata/tests/QA
  canaries. Preview ownership briefly regressed to the platform hub again; stopped the platform hub
  and restarted synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Validation:
  focused feature Jest passed (86 tests; existing React/AntD jsdom warnings), `lint:frontend`
  passed, `packages/static build:dev` passed, desktop browser QA passed on `/features`,
  `/features/whiteboard`, and `/features/slides` (56 assertions / 0 failures), mobile browser QA
  passed on `/features/whiteboard` and `/features/slides` (33 assertions / 0 failures), and
  desktop and mobile screenshots were reviewed from `/tmp/cocalc-public-qa-r2IXlu` and
  `/tmp/cocalc-public-qa-Z13Ovs`. No PR created.
- **START 2026-06-20 13:50 PDT:** Blaec flagged the `/features/whiteboard` hero body as too much
  text. Verified clean branch at `34df9c8f39`, synthesis hub still owns preview pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`), and no active build. Claiming only
  `src/packages/frontend/public/features/whiteboard-page.tsx` plus this ledger to shorten the hero
  copy, rebuild, verify, commit, and push. No PR.
- **END 2026-06-20 13:52 PDT:** shortened the `/features/whiteboard` hero body from three
  paragraphs to one compact two-sentence paragraph. Validation: prettier passed, focused feature
  Jest passed (86 tests; existing React/AntD jsdom warnings), `lint:frontend` passed,
  `packages/static build:dev` passed, browser QA passed on `/features/whiteboard` in desktop and
  mobile (17 assertions each / 0 failures), and the desktop screenshot
  `/tmp/cocalc-public-qa-yZXkFz/features-whiteboard-desktop-full.png` was reviewed for reduced
  first-screen density. No PR created.
- **START 2026-06-20 13:54 PDT:** Blaec flagged a `/features` card that goes directly to docs
  unlike the other cards and asked to double-check for similar cases. Verified clean branch at
  `16c0ee17c1`, synthesis hub still owns preview pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`), and no active build. Source audit found two docs-only
  feature-index card overrides: `CoCalc CLI` and `Dedicated Compute`; the "Project notes and
  Markdown" docs link is a non-card group text link. Claiming the feature index, catalog,
  metadata, tests, browser-QA route rules, new local feature detail pages for CLI and dedicated
  compute, and this ledger. No PR.
- **PIVOT 2026-06-20 14:02 PDT:** Blaec raised a mission-critical framing/process request:
  reread `/home/user/cocalc-ai/docs/pitch`, research adjacent product positioning externally,
  and make the resulting product-framing discipline persistent so future public-site edits keep
  learning instead of drifting. Pausing the docs-card route implementation with two uncommitted
  draft pages still present (`cli-page.tsx`, `dedicated-compute-page.tsx`) until the framing
  system decides whether they are the right fix. Verified synthesis hub still owns preview pid
  `13303`; platform hub is stopped. Claiming public-site operating docs plus this ledger for the
  framing-system update. No PR unless explicitly requested.
- **END 2026-06-20 14:11 PDT:** created and wired the persistent public-site framing layer:
  `docs/landing-page-framing-system.md`, `docs/landing-page-framing-research-register.md`, and
  `src/.agents/public-site-framing-workplan-2026-06-20.md`. Updated the website operating
  system, public-site skill, root agent index, and decisions log so future rounds must consult
  the route frame, dated research register, claim classes, and active burn-down plan. External
  official-source scan covered Jupyter/JupyterHub, Colab, Codespaces, Overleaf, Replit Agent,
  Posit Cloud, Deepnote, Hex, OpenAI Codex, and GitHub Copilot cloud agent. Validation:
  `git diff --check` clean; new docs are ASCII-only; banned/category-collapse terms appear only
  in internal "do not say" rows. The two draft feature pages remain uncommitted and should be
  re-evaluated under FS-001 before being wired in. No PR.
- **START 2026-06-20 14:12 PDT:** Blaec flagged mismatched accent colors between `/features`
  cards and the detail pages for Project Automations and Julia. Verified synthesis hub owns
  preview pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Existing unrelated dirt:
  `src/packages/frontend/scripts/public-site-turn-snapshot.sh` plus untracked draft
  `cli-page.tsx` and `dedicated-compute-page.tsx`; leaving them untouched. Claiming
  `src/packages/frontend/public/features/{app.tsx,automations-page.tsx,julia-page.tsx}` plus
  this ledger to centralize the two accents, rebuild, QA `/features`, `/features/automations`,
  and `/features/julia`, then commit. No PR.
- **END 2026-06-20 14:17 PDT:** fixed the accent drift by adding shared `FEATURE_ACCENTS` for
  Automations blue and Julia purple, then using them on both the feature index and the
  associated detail pages. Validation: prettier passed, focused feature Jest passed (86 tests;
  existing React/AntD jsdom warnings), `lint:frontend` passed, `git diff --check` clean,
  `packages/static build:dev` passed, and browser QA passed for `/features`,
  `/features/automations`, and `/features/julia` on desktop and mobile (104 assertions / 0
  failures; screenshots in `/tmp/cocalc-public-qa-sw83Va`). Generic `pnpm -C src test ...`
  still fails before focused tests because the environment lacks Python `requests` for the
  unrelated docs URL checker. No PR.
- **START 2026-06-20 14:20 PDT:** Blaec flagged that the CoCalc CLI card on `/features` still
  routes directly to docs instead of a consistent short overview page. Verified preview remains
  owned by synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Existing unrelated
  dirt remains `src/packages/frontend/scripts/public-site-turn-snapshot.sh` and untracked
  `dedicated-compute-page.tsx`; leaving both untouched. Claiming the CLI route/page, feature
  index, feature catalog/metadata/tests, framing workplan, and this ledger to promote the
  existing CLI draft into `/features/cli`, keep docs as a secondary link, rebuild, QA, commit,
  and push. No PR.
- **END 2026-06-20 14:31 PDT:** Promoted CoCalc CLI from a docs-only feature-index card to
  `/features/cli`, with the CLI guide retained as a secondary CTA. Added catalog/metadata entries,
  route tests, and the CLI route frame in the persistent workplan. Validation: focused feature
  Jest `88/88` passing after removing the generic operating-model CTA from the CLI route;
  `lint:frontend` passing; `git diff --check` clean; `pnpm -C src/packages/static build:dev`
  passing; browser QA on `/features` and `/features/cli` desktop/mobile `68` assertions, `0`
  failures before commit (`/tmp/cocalc-public-qa-zalVUg`) and after the post-commit rebuild
  (`/tmp/cocalc-public-qa-kl0j74`). Committed and pushed synthesis branch backup. No PR.
- **START 2026-06-20 14:33 PDT:** Blaec flagged that the `/features/cli` context list uses a red
  bug-looking icon for the agent item. Existing unrelated dirt remains the snapshot script and
  untracked `dedicated-compute-page.tsx`; leaving both untouched. Claiming only the CLI page and
  this ledger to replace that icon with a neutral CLI/control icon, rebuild, QA, commit, and push.
  No PR.
- **END 2026-06-20 14:35 PDT:** Replaced the CLI page agent-context `robot` icon with the neutral
  `gears`/control icon so the row no longer reads as a red bug/error. Validation: prettier
  passed, focused feature Jest `88/88` passing, `lint:frontend` passing, `git diff --check` clean,
  `pnpm -C src/packages/static build:dev` passing, and browser QA on `/features/cli` and
  `/features` desktop/mobile `68` assertions, `0` failures (`/tmp/cocalc-public-qa-C6sGUU`).
  No PR.
- **START 2026-06-20 14:37 PDT:** Blaec flagged that the `/features` "Notebooks and writing" row
  is the only index row with extra docs links underneath, making it busier than the other groups.
  Existing unrelated dirt remains the snapshot script and untracked `dedicated-compute-page.tsx`;
  leaving both untouched. Claiming only the features index/group tests and this ledger to remove
  the extra `Project notes and Markdown` docs link, rebuild, QA `/features`, commit, and push.
  No PR.
- **END 2026-06-20 14:39 PDT:** Removed the `Project notes and Markdown` docs link from the
  `/features` "Notebooks and writing" group so the feature index rows use consistent card-only
  presentation. Updated index tests to assert the extra link is absent. Validation: prettier
  passed, focused feature Jest `88/88` passing, `lint:frontend` passing, `git diff --check` clean,
  `pnpm -C src/packages/static build:dev` passing, and browser QA on `/features` and
  `/features/cli` desktop/mobile `68` assertions, `0` failures (`/tmp/cocalc-public-qa-Lxic29`).
  No PR.
- **START 2026-06-20 14:41 PDT:** Blaec flagged that `/features/cli` labels the docs CTA as
  `CLI guide`, which implies a guide page instead of documentation; eventual guides belong under
  `/guides` if/when created. Existing unrelated dirt remains the snapshot script and untracked
  `dedicated-compute-page.tsx`; leaving both untouched. Claiming only the CLI page, focused
  feature tests, and this ledger to rename the button to `CLI Docs`, rebuild, QA, commit, and
  push. No PR.
- **END 2026-06-20 14:43 PDT:** Renamed the `/features/cli` docs CTA from `CLI guide` to
  `CLI Docs` and added a focused route assertion that the button points at
  `/docs/cli/use-cocalc-cli` while `CLI guide` stays absent. Validation: prettier passed, focused
  feature Jest `88/88` passing, `lint:frontend` passing, `git diff --check` clean,
  `pnpm -C src/packages/static build:dev` passing, and browser QA on `/features/cli` and
  `/features` desktop/mobile `68` assertions, `0` failures (`/tmp/cocalc-public-qa-hIvO31`).
  No PR.
- **START 2026-06-20 14:45 PDT:** Blaec flagged that the `/features/cli` context row "Inspect
  browser tabs and workspace state when needed" still shows a red icon. Existing unrelated dirt
  remains the snapshot script and untracked `dedicated-compute-page.tsx`; leaving both untouched.
  Claiming only the CLI page and this ledger to replace the custom `browser` icon with the
  regular `bug` icon so it inherits the same neutral color as the other context icons, rebuild,
  QA, commit, and push. No PR.
- **END 2026-06-20 14:48 PDT:** Replaced the CLI context row's custom `browser` icon with the
  regular `bug` icon, which renders in the same neutral context-list color as the surrounding
  icons. Validation: prettier passed, focused feature Jest `88/88` passing, `lint:frontend`
  passing, `git diff --check` clean, `pnpm -C src/packages/static build:dev` passing, browser QA
  on `/features/cli` and `/features` desktop/mobile `68` assertions, `0` failures
  (`/tmp/cocalc-public-qa-0lTWPQ`), and visual screenshot inspection confirmed the icon is no
  longer red. No PR.
- **START 2026-06-20 14:51 PDT:** Blaec asked to use the attached screenshot as the top visual on
  `/features/cli`. Verified synthesis hub still owns preview pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`). Existing unrelated dirt remains the snapshot script and
  untracked `dedicated-compute-page.tsx`; leaving both untouched. Claiming only the CLI page,
  attached image asset if recoverable, focused tests if needed, and this ledger to replace the
  mock top visual with the requested screenshot, rebuild, QA, commit, and push. No PR.
- **END 2026-06-20 14:56 PDT:** Replaced the synthetic `/features/cli` command mock with Blaec's
  attached screenshot as the top hero visual, stored as
  `/public/features/cocalc-cli-browser-automation.png` with intrinsic dimensions and a restrained
  border/shadow. Validation: prettier passed, focused feature Jest `88/88` passing (existing
  React/AntD jsdom warnings), `lint:frontend` passing, `git diff --check` clean,
  `pnpm -C src/packages/static build:dev` passing, browser QA on `/features/cli` and `/features`
  desktop/mobile `68` assertions, `0` failures (`/tmp/cocalc-public-qa-nttgaC`), and visual
  screenshot inspection confirmed the new top image appears on desktop and mobile. No PR.
- **START 2026-06-20 15:06 PDT:** Blaec asked to keep the exact CLI screenshot asset but frame it
  like the Jupyter feature page visual instead of showing the screenshot as an unframed image.
  Verified synthesis hub still owns preview pid `13303` (`/home/user/cocalc-ai-synthesis/src`).
  Existing unrelated dirt remains the snapshot script and untracked `dedicated-compute-page.tsx`;
  leaving both untouched. Claiming only the CLI page and this ledger to add the Jupyter-style
  outer frame around the existing image, rebuild, QA, commit, and push. No PR.
- **END 2026-06-20 15:08 PDT:** Added the Jupyter-style outer frame around the existing
  `/features/cli` screenshot asset: light gradient surface, 8px radius, border, shadow, and
  padding, while keeping Blaec's screenshot as the inner image. Validation: prettier passed,
  focused feature Jest `88/88` passing (existing React/AntD jsdom warnings), `lint:frontend`
  passing, `git diff --check` clean, `pnpm -C src/packages/static build:dev` passing, browser QA
  on `/features/cli` and `/features` desktop/mobile `68` assertions, `0` failures
  (`/tmp/cocalc-public-qa-5dy63T`), and visual screenshot inspection confirmed the frame renders
  on desktop and mobile. No PR.
- **START 2026-06-20 15:19 PDT:** Blaec asked to try the selected Jupyter screenshot as the hero
  visual on `/features/jupyter-notebook` and rebuild the preview. Verified synthesis hub still
  owns preview pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Existing unrelated dirt remains
  the snapshot script and untracked `dedicated-compute-page.tsx`; leaving both untouched. Claiming
  only the Jupyter feature page, selected screenshot asset, focused tests if needed, and this
  ledger to replace the synthetic notebook mock with the real screenshot in the existing frame,
  rebuild, QA, commit, and push. No PR.
- **PAUSED 2026-06-20 15:20 PDT:** Newer Blaec request superseded the Jupyter screenshot trial
  before any Jupyter page or asset edits were made. Leaving the Jupyter image decision unexecuted
  for now. No PR.
- **START 2026-06-20 15:20 PDT:** Blaec asked to add the CLI feature icon from the `/features`
  index into the `/features/cli` screenshot frame, similar to the Jupyter page styling. Existing
  unrelated dirt remains the snapshot script and untracked `dedicated-compute-page.tsx`; leaving
  both untouched. Claiming only the CLI page and this ledger to add the terminal icon/accent header
  above the existing screenshot, rebuild, QA, commit, and push. No PR.
- **END 2026-06-20 15:22 PDT:** Added the `/features` CLI card's `terminal` icon treatment above
  the `/features/cli` screenshot inside the existing framed panel, using the shared gray CLI accent
  for the badge and context list. Validation: prettier passed, focused feature Jest `88/88`
  passing (existing React/AntD jsdom warnings), `lint:frontend` passing, `git diff --check` clean,
  `pnpm -C src/packages/static build:dev` passing, browser QA on `/features/cli` and `/features`
  desktop/mobile `68` assertions, `0` failures (`/tmp/cocalc-public-qa-97rQpM`), and visual
  screenshot inspection confirmed the icon/header appears above the CLI screenshot on desktop and
  mobile. No PR.

### Codex — platform-UI thread

- **Task:** terminal/frame overflow menu cleanup — remove the repeated frame title
  from the `...` popover while preserving menu commands, toolbar actions, and
  frame controls.
- **Worktree / Branch:** `/home/user/cocalc-ai` / `frontend/frame-overflow-title-cleanup`
- **Preview owner:** platform still owns `blaec.cocalc.ai` (:9100; hub pids 294/333,
  cwd `/home/user/cocalc-ai/src`). Reclaim for synthesis before any live public-site preview.
- **⚠️ Codex session lost (2026-06-19).** The interactive Codex conversation vanished. All
  _committed_ Codex work is intact on a long stack of pushed `frontend/*` branches (current
  platform checkout `frontend/files-toolbar-tooltip-polish` @ `cf1cdfa654`, clean). The only
  at-risk work was ONE uncommitted edit in the platform worktree — a `PresetSummaryCard`
  redesign in `frontend/project/app-server-panel.tsx`.
- **Recovery (Claude, at user's request):** committed the recovered edit to a clean branch
  off `origin/main` (`frontend/app-server-preset-card-compact`). PR #91 was opened then
  **CLOSED** — opening it without Blaec's per-change sign-off was premature (lesson recorded
  in memory `explicit-approval-before-pr`). Blaec then chose "revise before any re-PR":
  follow-up commit `254013663a` drops the card's off-platform "Learn more" link (it opened
  third-party homepages in a new tab; functional links kept — running-app public URL, CoCalc
  CLI download). Branch HEAD `254013663a`; prettier+oxlint clean; **NOT pushed**, awaiting
  Blaec's approval to re-PR. Worktree re-added at `/tmp/recover-wt`; recovered patch also at
  `/tmp/recover-app-server.patch`.
- **Open PRs:** #72 (frame overflow menu, earlier). #91 is CLOSED.
- **Known risks:** PR #91 not locally typechecked end-to-end (CI gates it). The rest of
  Codex's `frontend/*` stack is pushed but its review/merge status is unknown to this thread.

---

## Preview-ownership incident (2026-06-18) — ROOT CAUSE of the reverted homepage

**Not a code/build/merge problem.** The synthesis build and source are current and
correct. The revert is a **hub-ownership collision**:

- Both worktrees' hub daemons are configured for the **same** `http://localhost:9100`.
- Synthesis hub daemon = **stopped**; platform hub daemon = **running** (pid 100501,
  cwd `/home/user/cocalc-ai/src`). So `blaec.cocalc.ai` is served by the **platform**
  hub → it shows the **platform worktree's old public pages**.
- Diagnostic that nails it: `bash scripts/dev/hub-daemon.sh status` in each worktree,
  plus `readlink /proc/<hub-pid>/cwd`. The serving cwd must be
  `/home/user/cocalc-ai-synthesis/src`; right now it is not.

**Immediate fix — DONE (2026-06-18 17:07):** stopped the platform hub, started the
synthesis hub on `:9100` (pid 119412), cloudflared tunnel back up. Content canary
**0 failures / 75 assertions** across `/`, `/features/ai`, `/features/jupyter-notebook`,
`/pricing`. `blaec.cocalc.ai` now serves the current synthesis pages. Platform hub
is STOPPED.

**Structural fix — STILL OPEN; bigger than a port var (Codex/platform infra).**
Investigated 2026-06-18 17:1x: the synthesis hub-daemon.env is
`HUB_CMD="DATA_BASE=/home/user/cocalc-ai/src/data/app ./packages/hub/bin/start.sh postgres"`.
The platform worktree has NO `src/.local/hub-daemon.env`, so its hub inherits the
hub's default `:9100`. **Both hubs share the same `DATA_BASE`** (`cocalc-ai/src/data/app`
— DB, postgres, cloudflared). So running both simultaneously needs the platform hub to
get (a) its OWN port AND (b) its OWN `DATA_BASE`/data dir — otherwise they collide on
`:9100` and/or the shared DB. That is platform-worktree infra: the platform agent should
create `cocalc-ai/src/.local/hub-daemon.env` with a distinct port + DATA_BASE. NOT done
here to avoid breaking the shared hub/DB.

**Interim rule (in force now):** ONE hub on `:9100`, owned by **synthesis** (it backs
`blaec.cocalc.ai`). The platform hub stays stopped unless it explicitly takes a handoff.
Before ANY preview judgment, every agent runs `hub-daemon.sh status` in BOTH worktrees +
`readlink /proc/<hub-pid>/cwd` and confirms cwd `= /home/user/cocalc-ai-synthesis/src`.
HTTP 200 ≠ correct owner.

---

## Contribution-hygiene / PR-prep (2026-06-18) — NOT pushed

Cut clean, main-based PR branches so William reviews product only (not the 304-commit
synthesis branch, not scaffolding, not platform work):

- **`public-site-pr`** — worktree `/home/user/cocalc-ai-public-site-pr`. The landing-site
  PR: **70 files off `origin/main`** (frontend/public pages+tokens+tests, the
  `hub/servers/app/public-*` backend + `express-app` wiring, `customize/app-base-path`,
  `util/public-site-metadata`). Verified standalone: **zero** platform/scaffolding imports.
  Two dev-tooling tests (`public-site-browser-qa-script.test.ts`,
  `public-site-agent-workflow.test.ts`) were excluded — they assert the QA harness /
  `.agents/` docs, not product.
- **`public-site-shells`** — the 3 `cli|launchpad|plus/site/index.html` product marketing
  pages (3 files off `origin/main`). Split out so the landing PR stays tight.
- **Scaffolding stays here on `blaec-synthesis-2026-06-18`** (local): `.agents/`, the audit
  docs, `.claude/commands`, the preview hook + QA harness, the 2 dev-tooling tests.
- Empirical gate (pnpm install + jest + tsc on the fresh branch) deferred to **CI on the PR**.

**⚠️ Codex — decide the home of the orphaned platform files** (currently only on
`blaec-synthesis` via `blaec2`, NOT on `remove-empty-project-tag`): `project/page/flyouts/*`
(6), `projects/project-rootfs-badge.*` (2), `styles/index-base.css` (flyout-star CSS),
`docs/mockups/file-explorer-*` (6). Provenance commits `d0de512695` (rootfs badge),
`072401c147` (flyout controls). Cherry-pick onto a platform branch if still wanted; else
they're harmlessly excluded from the public-site PRs.

---

## main-sync (2026-06-18) — synthesis now current with upstream

Merged `origin/main` (`5a0688d925`, incl **PR #71** empty-explorer spacing, xterm 5.5.0,
idle handling) into `blaec-synthesis-2026-06-18` — **clean, zero conflicts** (synthesis
public-site changes and main's in-app changes didn't overlap). Rebuilt via `static:dev`
(new bundle `app-408615…` embeds the merge commit + #71's `no-files.tsx`) and restarted
the synthesis hub. **Public content canary: 0 failures.** #71 is a project/in-app change —
verify its spacing in the logged-in explorer view, NOT on the public landing pages. NOT pushed.
