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
- **START 2026-06-20 15:30 PDT:** Blaec flagged that `/features/cli` now has the right asset
  ingredients but the overall page shape/components are not visually appealing or production-grade
  for decision-makers. Verified synthesis hub still owns preview pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`). Existing unrelated dirt remains the snapshot script and
  untracked `dedicated-compute-page.tsx`; leaving both untouched. Read the public-site guardrails,
  operating system, brief, framing system/register, and external design sources on scanability,
  visual hierarchy, and card hierarchy. Claiming only the CLI page, focused tests, and this ledger
  to simplify the route into a clearer hero, use-case section, and CLI/API/Automations decision
  section, then rebuild, QA, commit, and push. The paused Jupyter screenshot trial remains
  unexecuted. No PR.
- **END 2026-06-20 15:39 PDT:** Reframed `/features/cli` as the external-tool/agent bridge into
  CoCalc project context instead of a minor automation side utility. Replaced the old context-list
  and final `StartCard` stack with hero proof points, a compact use-case panel, and a
  CLI/Automations/API choice section; kept Blaec's screenshot and the approved neutral terminal
  icon/frame. Validation: prettier passed, focused feature Jest passed (`88/88`; existing
  React/AntD jsdom warnings), `lint:frontend` passed, `git diff --check` clean,
  `packages/static build:dev` passed, and browser QA passed on `/features/cli` and `/features`
  desktop/mobile (`68` assertions, `0` failures; screenshots in
  `/tmp/cocalc-public-qa-DD9BA7`). No PR. The paused Jupyter screenshot trial remains unexecuted.
- **SYNC 2026-06-20 16:11 PDT:** Read `/home/user/cocalc-shared/working-agreement.md` and the
  current shared coordination notes (`shipped-features-audit-2026-06-20.md`,
  `agent-era-pitch-challenge-2026-06-20.md`, `products-framing-audit-2026-06-20.md`,
  `chooser-grouping-spec-2026-06-20.md`). Operating agreement accepted: Codex acts/owns source,
  tests, builds, `:9100`, commits, pushes, and this repo ledger; Claude audits read-only and writes
  to `/home/user/cocalc-shared`; Blaec decides; no PRs unless explicitly asked. Verified synthesis
  status: clean except untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`;
  Claude's snapshot-script edit is reverted; preview owner remains synthesis hub pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`). Work queue now recorded as: hold CLI structural demotion
  until the agent-era pitch challenge resolves; next candidates are whiteboard/slides copy cleanup
  and dedicated-compute scoping, followed by products detail-page subtraction and the confirmed
  5-products/3-operating-model chooser grouping. No source edit, build, commit, or PR for this sync.
- **START 2026-06-20 16:26 PDT:** Blaec approved the recommended whiteboard/slides cleanup and
  asked for a quick `/features` group-order swap: exchange AI Workflows with Runtime, and Teaching
  with Languages. Verified synthesis is clean except untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx`; preview owner is still
  synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Claiming
  `src/packages/frontend/public/features/{app.tsx,whiteboard-page.tsx,slides-page.tsx,__tests__/app.test.tsx}`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, and this ledger. No PR.
- **END 2026-06-20 16:34 PDT:** Completed the requested `/features` group-order swap so Runtime
  leads, Notebooks remains second, AI Workflows moves below Notebooks, Languages moves above
  Teaching, and Teaching closes the index. Trimmed the whiteboard/slides overlap: shortened the
  whiteboard slide-decks section, moved it above the Jupyter execution-graph section, changed the
  hero `Slide decks` CTA to navigate to `/features/slides`, and tightened the slides page copy.
  Validation: prettier passed, focused feature Jest passed (`88/88`; existing React/AntD jsdom
  warnings), `lint:frontend` passed, `git diff --check` clean, `packages/static build:dev` passed,
  and browser QA passed on `/features`, `/features/whiteboard`, and `/features/slides`
  desktop/mobile (`112` assertions, `0` failures; screenshots in
  `/tmp/cocalc-public-qa-ZvMtil`). No PR. The untracked dedicated-compute draft remains untouched.
- **SYNC 2026-06-20 17:15 PDT:** Read Claude's current status
  (`/home/user/cocalc-shared/claude-current-status.md`) and the completed read-only language audit
  (`/home/user/cocalc-shared/public-site-language-audit-2026-06-20.md`). Verified synthesis is
  still clean except untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  and preview owner remains synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`).
  Added Codex challenge notes to the shared audit only: confirmed the CLI hero screenshot as the
  first P0 slice, split CLI/Automations proof-surface cleanup from the held structural demotion,
  recommended keeping the dedicated-compute draft unwired, and framed the `project host` vs
  `compute host` decision for Blaec. No source edits, build, commit-worthy product changes, or PR.
- **START 2026-06-20 17:26 PDT:** Blaec approved Slice A for `/features/cli`: remove the raw
  `cocalc-cli-browser-automation.png` `--help` screenshot and replace it with a clean framed
  one-workflow CLI visual using safe public commands/output, while preserving the framed panel +
  terminal icon treatment. Read Claude status first; Claude is read-only and waiting for re-audit.
  Verified synthesis remains clean except untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`,
  preview owner remains synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`), and no
  build is active. Claiming `src/packages/frontend/public/features/cli-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/assets/public/features/cocalc-cli-browser-automation.png`, browser QA expectations
  if needed, and this ledger. No PR.
- **END 2026-06-20 17:55 PDT:** Slice A implemented and preview rebuilt. Replaced the raw CLI
  `--help` screenshot with an in-code framed terminal workflow showing safe public commands
  (`cocalc browser files` and `cocalc project jupyter exec`), deleted the unsafe PNG asset, and
  added Jest/browser-QA guards that require the safe workflow while forbidding the leaked internal
  terms. Validation: `pnpm prettier:write -- packages/frontend/public/features/cli-page.tsx
  packages/frontend/public/features/__tests__/app.test.tsx packages/frontend/scripts/public-site-browser-qa.mjs`;
  `pnpm jest public/features/__tests__/app.test.tsx --runInBand`; `pnpm jest
  public/__tests__/public-site-browser-qa-script.test.ts --runInBand`; `pnpm lint:frontend`;
  `git diff --check`; `pnpm -C src/packages/static build:dev`; browser QA for `/features/cli` and
  `/features` on desktop/mobile passed with 102 assertions and 0 failures, artifacts in
  `/tmp/cocalc-public-qa-DDGlvr`. Pre-existing untracked dedicated-compute draft untouched. No PR.
- **START 2026-06-20 18:08 PDT:** Blaec approved the bounded `/features/cli` copy/design pass from
  `cli-page-copy-adversarial-audit-2026-06-20.md`: keep the safe framed workflow visual, make the
  page docs-first instead of sign-up-first, replace "bridge / typed surface / run and report" with
  workspace-first review language, and reduce repeated explanatory copy. Read Claude status first;
  Claude remains read-only with an auto-watch armed for the next commit. Verified preview owner
  remains synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Claiming
  `src/packages/frontend/public/features/cli-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, browser QA artifacts, and this ledger.
  Pre-existing untracked dedicated-compute draft remains out of scope. No PR.
- **END 2026-06-20 18:22 PDT:** `/features/cli` copy/design pass implemented and preview rebuilt.
  Made the hero docs-first (`CLI Docs` primary, no hero sign-up CTA), replaced "bridge / typed
  surface / run and report" copy with workspace-first review language, reduced the middle section
  to three compact proof cards, and bounded the agent-compatibility language to scripts and
  shell-capable agents per Claude's review. Validation: `pnpm prettier:write -- packages/frontend/public/features/cli-page.tsx
  packages/frontend/public/features/__tests__/app.test.tsx packages/frontend/scripts/public-site-browser-qa.mjs`;
  `pnpm jest public/features/__tests__/app.test.tsx --runInBand`; `pnpm jest
  public/__tests__/public-site-browser-qa-script.test.ts --runInBand`; `pnpm lint:frontend`;
  `git diff --check`; `pnpm -C src/packages/static build:dev`; browser QA for `/features/cli` and
  `/features` on desktop/mobile passed with 114 assertions and 0 failures, artifacts in
  `/tmp/cocalc-public-qa-RDVlKQ`. Desktop and mobile screenshots inspected. Dedicated-compute draft
  untouched. No PR.
- **FOLLOW-UP 2026-06-20 17:58 PDT:** Blaec flagged the mobile first viewport as still visually
  problematic. Corrected the CLI hero H1 from the clunky `shell-capable agents` qualifier to
  `Run project work from the command line.`, while preserving the required claim boundary in a
  hero bullet (`scripts or agents that can run shell commands`). Rebuilt preview and re-ran browser
  QA for `/features/cli` + `/features` desktop/mobile: 116 assertions, 0 failures, artifacts in
  `/tmp/cocalc-public-qa-J3ESvT`; desktop and mobile screenshots inspected. No PR.
- **START 2026-06-20 18:10 PDT:** Applying the bounded `/features/cli` design-polish slice from
  Claude's review: remove the lone ad-hoc gold terminal icon color, break the repeated card-row
  rhythm by turning the middle proof cards into a numbered Read → Run → Return flow, run visual
  density/contrast QA, rebuild the preview, and commit with a detailed message. Read Claude status
  first; Claude remains read-only. Verified preview owner remains synthesis hub pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`). Claiming
  `src/packages/frontend/public/features/cli-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, browser QA artifacts, and this
  ledger. Pre-existing untracked dedicated-compute draft remains out of scope. No PR.
- **END 2026-06-20 18:13 PDT:** `/features/cli` design-polish slice implemented and preview
  rebuilt. Removed the terminal header's lone ad-hoc gold icon color so it inherits the terminal
  header treatment, converted the middle proof row into a numbered Read → Run → Return sequence,
  and added a browser-QA selector guard for the new sequence. Validation:
  `pnpm prettier:write -- packages/frontend/public/features/cli-page.tsx packages/frontend/scripts/public-site-browser-qa.mjs`;
  `pnpm --dir packages/frontend exec jest public/features/__tests__/app.test.tsx --runInBand`;
  `pnpm --dir packages/frontend exec jest public/__tests__/public-site-browser-qa-script.test.ts --runInBand`;
  `pnpm lint:frontend`; `git diff --check`; `pnpm -C src/packages/static build:dev`; browser QA
  for `/features/cli` and `/features` on desktop/mobile passed with 118 assertions and 0 failures,
  artifacts in `/tmp/cocalc-public-qa-pOscri`. Desktop and mobile screenshots inspected. The
  repo-level `pnpm test -- ...` wrapper is blocked in this environment by missing Python
  `requests`, so focused package Jest was run directly. Dedicated-compute draft untouched. No PR.
- **START 2026-06-20 18:16 PDT:** Revising the `/features/cli` middle flow after Blaec flagged
  the `01/02/03` badges and right-aligned icons as visually weird/inconsistent. Scope: keep the
  sequence concept but simplify the treatment so each step has one consistent left-aligned marker
  and no competing per-card icon. Read Claude status first; Claude remains read-only. Verified
  preview owner remains synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`).
  Claiming `src/packages/frontend/public/features/cli-page.tsx`, browser QA artifacts, and this
  ledger. Dedicated-compute draft remains out of scope. No PR.
- **END 2026-06-20 18:18 PDT:** `/features/cli` middle flow revised and preview rebuilt. Removed
  the `01/02/03` circular badges and the competing right-aligned icons; each step now uses the same
  left-aligned pattern (`Step 1/2/3`, title, body) with a subtle left border. Validation:
  `pnpm prettier:write -- packages/frontend/public/features/cli-page.tsx`;
  `pnpm --dir packages/frontend exec jest public/features/__tests__/app.test.tsx --runInBand`;
  `pnpm --dir packages/frontend exec jest public/__tests__/public-site-browser-qa-script.test.ts --runInBand`;
  `pnpm lint:frontend`; `git diff --check`; `pnpm -C src/packages/static build:dev`; browser QA
  for `/features/cli` and `/features` on desktop/mobile passed with 118 assertions and 0 failures,
  artifacts in `/tmp/cocalc-public-qa-xRagwv`. Desktop and mobile screenshots inspected. No PR.
- **START 2026-06-20 18:20 PDT:** Folding Claude's validated framing-principles digest items 3-7
  into the durable public-site framing layer and running the remaining `/features/cli` polish pass:
  WCAG contrast verification, sibling-page rhythm check, and low-risk meta-description alignment.
  Principles 1, 2, 8, and 9 remain provisional until Claude's research runs land. Read Claude
  status first; Claude remains read-only. Verified preview owner remains synthesis hub pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`). Claiming
  `docs/landing-page-framing-system.md`, `docs/landing-page-framing-research-register.md`,
  `src/packages/frontend/public/features/cli-page.tsx`, browser QA artifacts, and this ledger.
  Dedicated-compute draft remains out of scope. No PR.
- **END 2026-06-20 18:35 PDT:** Folded validated principles 3-7 into
  `docs/landing-page-framing-system.md` and logged their evidence in
  `docs/landing-page-framing-research-register.md`; principles 1, 2, 8, and 9 remain provisional.
  Added the explicit rule that public product capability claims must trace to the current
  `github.com/sagemathinc/cocalc-ai` source tree. Source verification for the CLI copy is based on
  `src/packages/cli/src/bin/commands/browser.ts` (`browser files`, `browser workspace-state`,
  `browser exec`), `src/packages/cli/src/bin/commands/project/jupyter.ts`
  (`project jupyter exec --path ... --stdin`), and
  `src/packages/ai/acp/codex-app-server.ts` (agent runtime guidance that shells out to those CLI
  commands). `rg` found no source-backed native MCP integration, so public copy remains bounded to
  scripts and shell-capable agents. Updated CLI feature index/catalog/social metadata to lead with
  the source-backed project-command workflow and added tests/QA forbids for the old
  "command-line surface" wording. Contrast pass: muted text on white `6.39:1`, muted text on page
  background `5.86:1`, CLI step/accent text on white `9.89:1`, CLI step/accent text on light panel
  `9.07:1`, terminal output/command/chrome text on terminal background `14.67:1` / `14.37:1` /
  `12.05:1`. Validation: `pnpm --dir packages/frontend exec jest
  public/features/__tests__/app.test.tsx --runInBand --silent`; `pnpm --dir packages/frontend exec
  jest public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`;
  `pnpm lint:frontend`; `git diff --check`; `pnpm prettier:check --
  ../docs/landing-page-framing-system.md ../docs/landing-page-framing-research-register.md`;
  `pnpm -C src/packages/static build:dev`; browser QA for `/features`, `/features/cli`,
  `/features/api`, `/features/automations`, and `/features/terminal` on desktop/mobile passed with
  202 assertions and 0 failures, artifacts in `/tmp/cocalc-public-qa-lAP9x1`; post-commit preview
  rebuild and browser QA passed the same routes/viewports with 202 assertions and 0 failures,
  artifacts in `/tmp/cocalc-public-qa-CN4zC2`. Desktop/mobile CLI screenshots and sibling
  feature-page screenshots inspected. Dedicated-compute draft remains untouched and untracked. No
  PR.
- **START 2026-06-20 18:40 PDT:** Beginning the systematic-audit burn-down with bounded Slice 1:
  public feature-page accessibility only. Scope: fix contrast failures from accent colors used as
  small text (eyebrows, tags, step labels, diagram labels), heading-level skips from card titles,
  and sub-24px interactive targets where present. Out of scope: pricing dollars, compliance/policy
  language, protected home/Brief positioning, and Claude's claimed `/home/user/cocalc-ai/docs/pitch`
  lane. Read Claude status and `framing-principles-digest-2026-06-20.md`; Claude remains read-only
  on synthesis. Verified branch `blaec-synthesis-2026-06-18` at `cf51f3075e`; preview remains the
  synthesis hub. Pre-existing untracked dedicated-compute draft remains out of scope. No PR.
- **END 2026-06-20 19:55 PDT:** Slice 1 implemented across public feature pages. Moved small
  label text off failing accent colors and onto dark ink (`PUBLIC_COLORS.heading`) while leaving
  accent colors on icons, borders, and visual panels. Removed the feature-page `h2 -> h4` skip by
  changing card/final-panel headings from semantic `h4` to `h3`; added a test guard that audited
  feature routes have no `main h4` headings. Added explicit `minHeight: 24` to feature link-style
  buttons that intentionally use zero inline padding, including the shared `LinkButton`. This slice
  added no new public product claims; it only changed accessibility semantics and visual text
  treatments. Contrast checks: heading on white `14.03:1`, heading on page background `12.87:1`,
  muted text on white `6.39:1`, muted text on page background `5.86:1`, dark text on white
  `9.89:1`, dark text on warning tint `9.35:1`; old brand-blue small text on white is `4.10:1`
  and no longer used for the audited small labels. Source checks: `rg` found no
  `Title level={4}` / `level={4}` in `src/packages/frontend/public/features`, and no direct
  `style={{ paddingInline: 0 }}` link buttons without the target-size floor. Validation:
  `pnpm prettier:write` on touched feature files; `pnpm --dir packages/frontend exec jest
  public/features/__tests__/app.test.tsx --runInBand --silent`; `pnpm --dir packages/frontend exec
  jest public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`;
  `pnpm lint:frontend`; `git diff --check`; `pnpm -C src/packages/static build:dev`; broad browser
  QA for 18 feature routes on desktop/mobile passed with 668 assertions and 0 failures, artifacts
  in `/tmp/cocalc-public-qa-zX4jcd`. Desktop/mobile screenshots for `/features`,
  `/features/jupyter-notebook`, `/features/ai`, `/features/python`, and `/features/terminal`
  inspected. Dedicated-compute draft remains untouched and untracked. No PR.
- **START 2026-06-20 20:02 PDT:** Continuing systematic-audit Slice 1 on the remaining
  non-feature accessibility findings: support pending/status/date contrast, products list
  semantics, and about social-link 24px targets. Read Claude status, framing digest, and the
  burn-down doc first; Claude remains read-only on synthesis and owns only the separate
  `/home/user/cocalc-ai/docs/pitch` lane. Verified preview owner remains synthesis hub pid
  `13303` (`/home/user/cocalc-ai-synthesis/src`). Claiming
  `src/packages/frontend/public/about/app.tsx`,
  `src/packages/frontend/public/support/tickets-view.tsx`,
  `src/packages/frontend/public/products/app.tsx`, related public tests/browser QA, and this
  ledger. Out of scope: pricing dollars, compliance/policy copy, protected home/Brief positioning,
  and the untracked dedicated-compute draft. No PR.
- **END 2026-06-20 20:09 PDT:** Completed the remaining non-feature Slice 1 accessibility pass.
  Support ticket status/type pills now use dark token text on pale status surfaces with 24px
  minimum height; support ticket dates moved from `COLORS.GRAY` to `PUBLIC_COLORS.mutedText`.
  Product chooser/detail grids now expose repeated cards as `list`/`listitem`, and small chooser
  labels/tags use dark ink instead of brand-blue small text. About team social links now use
  dark token icons with 24px minimum targets, and the team/profile grids were made responsive
  after browser QA found `/about/team/william-stein` mobile horizontal overflow. This slice added
  no public product claims and did not touch pricing, policy/compliance copy, the protected home,
  or the dedicated-compute draft. Contrast checks: support pending label `13.39:1`, support open
  label `12.43:1`, support dates `6.39:1`, products labels `13.92:1`, products start tag
  `12.43:1`, about social icons `13.92:1`. `axe-core` is not installed in this workspace, so the
  accessibility verification used source-level contrast checks, semantic Jest assertions, and
  browser QA. Validation: `pnpm prettier:write` on touched files; `pnpm --dir packages/frontend
  exec jest public/__tests__/app.test.tsx --runInBand --silent`; `pnpm --dir packages/frontend
  exec jest public/support/tickets-view.test.tsx --runInBand --silent`; `pnpm --dir
  packages/frontend exec jest public/__tests__/public-site-browser-qa-script.test.ts --runInBand
  --silent`; `pnpm lint:frontend`; `git diff --check`; `pnpm -C src/packages/static build:dev`;
  browser QA for `/products`, all product detail routes, `/about/team/william-stein`, `/support`,
  and `/support/tickets` on desktop/mobile passed with 262 assertions and 0 failures, artifacts
  in `/tmp/cocalc-public-qa-wTlPpR`. Dedicated-compute draft remains untouched and untracked. No
  PR.
- **START 2026-06-20 20:18 PDT:** Starting Slice 2a only: exact `PUBLIC_RADIUS.panel`
  consolidation for public feature routes. Read Claude status and
  `/home/user/cocalc-shared/slice-2-handoff-2026-06-20.md`; Claude remains read-only on
  synthesis and owns only `/home/user/cocalc-ai/docs/pitch`. Verified preview owner remains
  synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Scope is zero-visual
  `8 -> PUBLIC_RADIUS.panel`: delete local `PANEL_RADIUS` / `FEATURE_PANEL_RADIUS` constants in
  feature routes, replace exact `borderRadius: 8` in `src/packages/frontend/public/features`, and
  add source guards. Out of scope: home/app.tsx, radius strays `10/12/14/16`, PUBLIC_ELEVATION,
  PUBLIC_TYPE, palette/accent collapse, pricing/compliance/policy copy, protected home/Brief, and
  the untracked dedicated-compute draft. No PR.
- **END 2026-06-20 20:57 PDT:** Slice 2a implemented and verified as zero-visual. Replaced exact
  `borderRadius: 8` and the local `PANEL_RADIUS` / `FEATURE_PANEL_RADIUS` constants in tracked
  public feature files with `PUBLIC_RADIUS.panel`; `border-radius: ${...}px` usage in the compare
  route now also reads from the token. Left radius strays `10/12/14/16`, `home/app.tsx`,
  `PUBLIC_ELEVATION`, `PUBLIC_TYPE`, and palette/accent work untouched. Added a source guard in
  `public/features/__tests__/app.test.tsx` that scans tracked public feature files and fails on
  local panel-radius constants or bare `borderRadius: 8`. Validation: baseline rendered QA before
  source edits passed on `/features/jupyter-notebook`, `/features/teaching`, `/features/cli`,
  `/features/compare`, `/features`, `/products`, and `/support` desktop/mobile with 328
  assertions / 0 failures (`/tmp/cocalc-public-qa-8XDdx7`); focused feature Jest passed 89 tests;
  public browser-QA script Jest passed 5 tests; source guard found no tracked feature offenders;
  `pnpm lint:frontend` passed; `git diff --check` passed; `pnpm -C src/packages/static build:dev`
  passed including `tsc --build`; post-change rendered QA passed the same routes/viewports with
  328 assertions / 0 failures (`/tmp/cocalc-public-qa-EZYFhg`); all 14 before/after screenshot PNGs
  were byte-identical by `cmp`. No public copy or product claims changed. No PR.
- **START 2026-06-20 21:04 PDT:** Starting Slice 2b only: exact `PUBLIC_DARK` token consumption
  for tracked public feature mock-chrome literals. Read Claude status and
  `/home/user/cocalc-shared/slice-2-handoff-2026-06-20.md`; Claude remains read-only on synthesis
  and owns only `/home/user/cocalc-ai/docs/pitch`. Verified preview owner remains synthesis hub
  pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Scope is zero-visual exact-value
  replacements for `#0b1522`, `#10213f`, `#0b1f47`, `#111827`, `#dbeafe`, `#86efac`, `#bfdbfe`,
  and the three mock dot colors with `PUBLIC_DARK`. Explicitly out of scope: the CLI `#101820`
  stray, `#fde68a`, `#f8fafc`, `#bbf7d0`, PUBLIC_ELEVATION, PUBLIC_TYPE, palette/accent collapse,
  protected home/Brief, and the untracked dedicated-compute draft. No PR.
- **END 2026-06-20 21:07 PDT:** Slice 2b complete locally: exact feature-page mock chrome
  literals now consume `PUBLIC_DARK` tokens, with a source guard preventing tracked
  `public/features/*.tsx` files from reintroducing the tokenized hexes. Left `#101820` in
  `cli-page.tsx` surfaced for later because snapping it to `PUBLIC_DARK.codeSurface` would be a
  visual delta; also left out-of-scope `#fde68a`, `#f8fafc`, and `#bbf7d0`. Validation:
  pre-change rendered QA passed `/features`, `/features/cli`, `/features/jupyter-notebook`,
  `/features/latex-editor`, `/features/linux`, `/features/sage`, `/features/terminal`, and
  `/features/python` desktop/mobile with 336 assertions / 0 failures
  (`/tmp/cocalc-public-qa-hdy3nv`); focused feature Jest passed 90 tests; public browser-QA script
  Jest passed 5 tests; exact-dark-hex grep returned no tracked feature offenders;
  `git diff --check` passed; `pnpm lint:frontend` passed from `src`; `pnpm -C src/packages/static
  build:dev` passed including `tsc --build`; post-change rendered QA passed the same routes/viewports
  with 336 assertions / 0 failures (`/tmp/cocalc-public-qa-nkH0wr`); all 16 before/after screenshot
  PNGs were byte-identical by `cmp`. No public copy or product claims changed. No PR.
- **START 2026-06-20 21:11 PDT:** Starting Slice 2c only: `PUBLIC_ELEVATION` consumption for
  tracked public feature-page shadow literals. Read Claude status plus the run plan, audit
  burndown, and slice-2 handoff; Claude remains read-only on synthesis and owns only
  `/home/user/cocalc-ai/docs/pitch`. Verified preview owner remains synthesis hub pid `13303`
  (`/home/user/cocalc-ai-synthesis/src`). Scope is the 36 tracked
  `rgba(33, 49, 57, …)` feature-page shadow literals; preserve each existing shadow geometry
  where possible by tokenizing the recurring feature elevation levels, so the rendered change is
  limited to the intended slate-to-brand elevation ink convergence. Explicitly out of scope:
  untracked `dedicated-compute-page.tsx`, protected home/Brief, PUBLIC_TYPE, palette/accent
  collapse, copy/product claims, pricing, compliance/policy, and Claude's pitch-doc lane. Because
  this is a visual-risk slice, validation requires before/after rendered QA and surfacing tone
  changes if they read too different. No PR.
- **END 2026-06-20 21:19 PDT:** Slice 2c complete locally: the 36 tracked feature-page
  `rgba(33, 49, 57, …)` shadow literals now consume `PUBLIC_ELEVATION`; recurring feature shadow
  geometries were preserved as named elevation tokens, so the rendered change is limited to the
  intended slate-to-brand shadow ink convergence. Added a source guard preventing tracked
  `public/features/*.tsx` files from reintroducing the legacy feature shadow literal. The only
  remaining legacy feature shadow is in the untracked `dedicated-compute-page.tsx` draft, which
  remains out of scope and unstaged. Validation: pre-change rendered QA passed `/features` plus
  15 affected feature detail routes across desktop/mobile with 596 assertions / 0 failures
  (`/tmp/cocalc-public-qa-wLA7nU`); focused feature Jest passed 91 tests; public browser-QA script
  Jest passed 5 tests; tracked-source grep found no legacy feature shadows; `git diff --check`
  passed; `pnpm lint:frontend` passed from `src`; `pnpm -C src/packages/static build:dev` passed
  including `tsc --build`; post-change rendered QA passed the same routes/viewports with 596
  assertions / 0 failures (`/tmp/cocalc-public-qa-bylD5l`). Screenshot deltas are expected for this
  visual slice: 30/32 images changed, but only in shadow pixels (max RGB delta 3-4, RMS <= 0.704);
  side-by-side review of the highest-delta pages read as visually equivalent/no layout shift. No
  public copy or product claims changed. No PR.
- **START 2026-06-20 22:25 PDT:** Starting Slice 3 only: name under-claimed differentiators
  TimeTravel and real-time collaboration in public copy. Read Claude status and the systematic
  audit; Claude says 2a/2b/2c are clean and 2d/2e are deferred. Verified preview owner remains
  synthesis hub pid `13303` (`/home/user/cocalc-ai-synthesis/src`). Source grounding checked before
  edits: `src/packages/docs/src/content/files.ts` documents TimeTravel recovery/review; Jupyter docs
  name realtime collaboration and detailed notebook TimeTravel; `docs/sync.md` documents
  presence/cursors; `src/packages/jupyter/redux/sync.ts` has `cursors: true`; the existing feature
  catalog already says shared kernel sessions and visible cursors for Jupyter. Scope: jupyter,
  teaching, terminal, julia, octave, products shared project note, compare, pricing lead, and AI
  review copy. Out of scope: protected home, metrics/performance/scale claims, pricing dollars,
  compliance/policy, token work, palette/type visual pass, pitch docs, and the untracked
  dedicated-compute draft. No PR.
- **END 2026-06-20 22:45 PDT:** Slice 3 copy pass complete. Touched only public feature/product/
  pricing copy plus this ledger. Named TimeTravel in recovery/history/review contexts and made
  notebook collaboration more concrete with visible cursors/shared kernel sessions where source-
  grounded. Kept terminal TimeTravel wording bounded to surrounding project files, not terminal
  scrollback. Validation: `public/features/__tests__/app.test.tsx` 91/91 passed;
  `public/__tests__/public-site-browser-qa-script.test.ts` 5/5 passed; `git diff --check` clean;
  `pnpm lint:frontend` clean; `pnpm -C src/packages/static build:dev` passed; live browser QA on
  `/features/ai`, `/features/compare`, `/features/julia`, `/features/jupyter-notebook`,
  `/features/more-languages`, `/features/octave`, `/features/python`,
  `/features/r-statistical-software`, `/features/sage`, `/features/teaching`,
  `/features/terminal`, `/pricing`, and `/products` passed 484 assertions across desktop/mobile.
  No metrics/performance/pricing/compliance claims added; no protected home edits; no PR.
- **START 2026-06-21 14:32 PDT:** Starting Slice 4a only: approved public buyer-copy naming
  sweep from `project host` to `compute host` / `dedicated compute`. Read Claude status, Codex turn
  log, and systematic burn-down; Claude says Slice 3 is clean and next is 4a. Verified current
  branch `blaec-synthesis-2026-06-18` at `a901edf6c3`; preview owner remains synthesis hub pid
  `13303` (`/home/user/cocalc-ai-synthesis/src`). Source grounding: docs and implementation still
  use `project host` as the technical term and route slug (`/docs/hosts/project-hosts`), while the
  approved public buyer label is `Dedicated compute` for the feature and `compute host` for the
  unit. Scope: `pricing/page.tsx`, `guides/app.tsx`, `products/app.tsx`, plus matching public-site
  test/QA labels. Out of scope: docs routes/slugs/destinations, technical UI/source terminology,
  pricing dollars, compliance/policy, protected home, pitch docs, Slice 4b+ converting language,
  deferred type/palette visual work, and the untracked dedicated-compute draft. No PR.
- **END 2026-06-21 14:36 PDT:** Slice 4a complete locally. Public buyer copy now uses
  `Dedicated compute` for the feature and `compute host` for the unit in pricing, guides, and the
  Star product boundary note, while the technical docs destination remains
  `/docs/hosts/project-hosts`. Updated only matching public-site test and browser-QA canaries; left
  broader converting-language items such as `scale-out` for Slice 4b+. Validation: public app Jest
  passed 38/38 after updating a stale Slice 3 product-overview assertion; public browser-QA script
  Jest passed 5/5; `git diff --check` clean; scoped grep found no old public `project host` labels
  in the touched pages/tests/QA script; `pnpm lint:frontend` clean; `pnpm -C src/packages/static
  build:dev` passed; live browser QA on `/pricing`, `/guides`, and `/products` passed 132
  assertions across desktop/mobile. No protected home, pricing dollars, compliance/policy, docs
  route, pitch-doc, or dedicated-compute draft edits. No PR.
- **START 2026-06-21 15:02 PDT:** Slice 4b implementation, using Blaec's technical-audience
  correction from `/home/user/cocalc-shared/codex-turn-log.md`: preserve concrete tool names while
  making the public copy more outcome-led. Verified Claude status before editing; Claude remains
  read-only on synthesis and active in the pitch-docs lane. Verified preview owner pid `13303`, cwd
  `/home/user/cocalc-ai-synthesis/src`. Claimed files:
  `src/packages/frontend/public/features/julia-page.tsx`,
  `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/terminal-page.tsx`,
  `src/packages/frontend/public/products/app.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: protected home, pitch docs, docs
  routes/content, pricing dollars, compliance/policy, route slugs, Slice 4c/4d, deferred type/palette
  visual work, and the untracked dedicated-compute draft. No PR.
- **END 2026-06-21 15:08 PDT:** Slice 4b complete locally. Updated the Julia and Octave detail
  heroes so the first viewport still names the tools technical users care about (`Julia`, `Pluto`,
  `Jupyter`, `GNU Octave`, notebooks, scripts, `.m` files, terminals, and shared project files) while
  adding the project/reproducibility outcome. Replaced terminal implementation jargon (`one PTY
  stream`, `terminal backpressure`) with user-facing session/output wording grounded in the terminal
  flow-control implementation. Updated the Star hero to state the one-Ubuntu-VM setup path and
  installer responsibilities without hiding the technical install card. Source grounding checked
  against the feature catalog, project Julia/Pluto support, Star self-hosting docs, and terminal
  throttle/connected-terminal implementation. Validation: `git diff --check` clean; focused Jest
  suites passed (`public/features/__tests__/app.test.tsx` 91/91, `public/__tests__/app.test.tsx`
  38/38, `public/__tests__/public-site-browser-qa-script.test.ts` 5/5); `pnpm lint:frontend`
  clean; `pnpm -C src/packages/static build:dev` passed; live browser QA passed 140 assertions on
  `/features/julia`, `/features/octave`, `/features/terminal`, and `/products/cocalc-star` across
  desktop/mobile. Screenshots reviewed from `/tmp/cocalc-public-qa-Y5ZHWy`; pre-existing mobile
  Star install-command overflow noted but left out of this copy slice. No protected home, pitch docs,
  docs route/content, pricing dollars, compliance/policy, type/palette visual, Slice 4c/4d, or
  dedicated-compute draft edits. No PR.
- **START 2026-06-21 15:13 PDT:** Blaec flagged `/features/octave` as visually busy. Claiming a
  bounded Octave visual-density cleanup only:
  `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Intent: reduce first-screen text and boxed visual
  density while preserving concrete tool names (`GNU Octave`, notebooks, scripts, `.m` files,
  terminals) and source-grounded collaboration/reproducibility claims. Out of scope: protected home,
  pitch docs, docs routes/content, pricing/compliance, Slice 4c/4d, broader feature-index copy,
  type/palette visual work, and the untracked dedicated-compute draft. No PR.
- **END 2026-06-21 15:19 PDT:** Octave visual-density cleanup complete locally. Shortened the
  Octave hero to one lead paragraph, reduced the mock visual from four icon-heavy cards to three
  compact proof rows, and trimmed the adjacent project-context proof list from five items to three.
  Preserved the concrete technical transition proof (`GNU Octave`, notebooks, scripts, `.m` files,
  terminals, plots/output, TimeTravel, and real-time notebook collaboration). Validation:
  `git diff --check` clean; focused feature Jest passed 91/91; `pnpm lint:frontend` clean;
  `pnpm -C src/packages/static build:dev` passed; live browser QA passed 36 assertions on
  `/features/octave` desktop/mobile; screenshots reviewed from `/tmp/cocalc-public-qa-p9FdGW`.
  No protected home, pitch-doc, docs route/content, pricing/compliance, Slice 4c/4d, broader
  feature-index, type/palette visual, or dedicated-compute draft edits. No PR.
- **START 2026-06-21 15:22 PDT:** Correcting Slice 4b after Blaec + Claude feedback. Decision:
  recast both Julia and Octave H2s to outcome-led versions, keep Star and terminal Slice 4b changes,
  and keep Codex's Octave visual-density reduction (`47b79aa68d`) after Claude confirmed it was a
  clean subtraction. Claimed files:
  `src/packages/frontend/public/features/julia-page.tsx`,
  `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: protected home, pitch docs, docs
  routes/content, pricing/compliance, Star/terminal changes already accepted, Slice 4c/4d, broader
  feature-index copy, type/palette visual work, and the untracked dedicated-compute draft. No PR.
- **END 2026-06-21 15:24 PDT:** Slice 4b correction complete before commit. Recast Julia H2 to
  "Julia for reproducible modeling your team can pick up and continue." and Octave H2 to "Octave
  for shared numerical work — no local install to maintain." Supporting copy and visuals still name
  the concrete tools technical visitors care about: Julia, Pluto, Jupyter, source files, terminals,
  GNU Octave, `.m` files, notebooks, plots/output, TimeTravel, and real-time collaboration. Kept the
  accepted Star/terminal copy and kept Octave's density reduction from `47b79aa68d`. Validation:
  `git diff --check` clean; `public/features/__tests__/app.test.tsx` 91/91 passed;
  `pnpm lint:frontend` clean from `src`; live browser QA for `/features/julia` and
  `/features/octave` desktop/mobile passed 72/72 assertions; screenshots reviewed from
  `/tmp/cocalc-public-qa-CVSew9`. No protected home, pitch-doc, docs route/content,
  pricing/compliance, Slice 4c/4d, broader feature-index copy, type/palette visual work, or
  dedicated-compute draft edits. No PR.
- **START 2026-06-21:** Correcting the rejected Slice 4b H2s after Blaec rejected the abstract
  Julia/Octave versions. Approved direction: make the H2s tool-visible and workflow-specific while
  leaving continuity/reproducibility in supporting copy. Claimed files:
  `src/packages/frontend/public/features/julia-page.tsx`,
  `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: protected home, pitch docs,
  docs route/content, pricing/compliance, Slice 4c/4d, broader feature-index copy, type/palette
  visual work, and the untracked dedicated-compute draft. No PR.
- **END 2026-06-21 15:44 PDT:** Replaced the rejected H2s with tool-visible approved versions:
  "Julia for Pluto, Jupyter, and shared modeling projects." and "GNU Octave for .m files,
  notebooks, and shared numerical work." Updated only the matching feature-page Jest markers.
  Supporting copy and visuals still carry reproducibility, TimeTravel, real-time collaboration,
  `.m` files, notebooks, terminals, plots, and shared project context. Validation: `git diff
  --check` clean; `public/features/__tests__/app.test.tsx` 91/91 passed; `pnpm lint:frontend`
  clean from `src`; `pnpm -C src/packages/static build:dev` passed; live browser QA for
  `/features/julia` and `/features/octave` desktop/mobile passed 72/72 assertions; screenshots
  reviewed from `/tmp/cocalc-public-qa-mUespd`. No protected home, pitch-doc, docs route/content,
  pricing/compliance, Slice 4c/4d, broader feature-index copy, type/palette visual work, or
  dedicated-compute draft edits. No PR.
- **START 2026-06-21:** Removing the bottom "Ask about Julia workflows" button from
  `/features/julia` after Blaec's visual review. Claimed files:
  `src/packages/frontend/public/features/julia-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: Slice 4c proposal implementation,
  protected home, pitch docs, docs route/content, pricing/compliance, type/palette visual work,
  and the untracked dedicated-compute draft. No PR.
- **END 2026-06-21:** Removed the bottom "Ask about Julia workflows" button from `/features/julia`
  and removed the now-unused Julia support-link fixture. Added an explicit Jest canary that the
  Julia page does not render that support link. Validation: `git diff --check`,
  `pnpm lint:frontend`, `pnpm --dir src/packages/frontend exec jest
  public/features/__tests__/app.test.tsx --runInBand --silent` (90/90), `pnpm -C
  src/packages/static build:dev`, and browser QA for `/features/julia` desktop/mobile (36/36).
  Screenshots reviewed from `/tmp/cocalc-public-qa-MAi0Rc`; no PR.
- **START 2026-06-21:** Applying Claude's language-page micro-polish after Blaec shared the
  audit: tighten Julia/Octave H2 grammar while keeping the concrete tool names visible, and add the
  missing explicit "reproducible" support copy on Octave. Claimed files:
  `src/packages/frontend/public/features/julia-page.tsx`,
  `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: Slice 4c implementation, protected
  home, pitch docs, docs route/content, pricing/compliance, type/palette visual work, and the
  untracked dedicated-compute draft. No PR.
- **END 2026-06-21:** Tightened the Julia and Octave H2s to `Use Julia in Pluto,
  Jupyter, and shared modeling projects.` and `Run GNU Octave with notebooks, .m files, and shared
  numerical work.` Kept concrete tool proof visible, added `reproducible` to the Octave project
  support paragraph, and updated route canaries. Validation: `git diff --check`,
  `pnpm --dir src/packages/frontend exec jest public/features/__tests__/app.test.tsx --runInBand
  --silent` (90/90), `pnpm lint:frontend` from `src`, `pnpm -C src/packages/static build:dev`,
  and browser QA for `/features/julia` + `/features/octave` desktop/mobile (72/72). Screenshots
  reviewed from `/tmp/cocalc-public-qa-NG326m`; no PR.
- **START 2026-06-21:** Implementing Slice 4c from the logged proposal: add the
  multi-artifact/unoccupied-bundle line on `/features`, update `/features/compare` hero/quick-read
  copy, and convert compare decision rows into a labeled `Choose CoCalc when` / `Choose a lighter
  tool when` table if the existing source supports it. Claimed files:
  `src/packages/frontend/public/features/app.tsx`,
  `src/packages/frontend/public/features/compare-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: protected home, pitch docs, docs
  routes/content, pricing/compliance, type/palette visual work, the dedicated-compute draft, and
  PRs.
- **END 2026-06-21:** Slice 4c landed in source: `/features` now names the multi-artifact project
  bundle in the index lead; `/features/compare` now contrasts CoCalc with lighter tools in the hero
  and quick-read; the decision checklist is a semantic table with `Decision question`, `Choose
  CoCalc when`, and `Choose a lighter tool when` columns that stacks into labeled rows on mobile.
  Validation: `git diff --check`, `pnpm --dir src/packages/frontend exec jest
  public/features/__tests__/app.test.tsx --runInBand --silent` (90/90), `pnpm lint:frontend` from
  `src`, `pnpm -C src/packages/static build:dev`, and browser QA for `/features` +
  `/features/compare` desktop/mobile (88/88). Screenshots reviewed from
  `/tmp/cocalc-public-qa-cXFSHV`; no PR.
- **START/END 2026-06-21 18:34 PDT:** Executed the latest dynamically logged final-section prompt
  after reading `cocalc-shared/INDEX.md`, `claude-current-status.md`, and `codex-turn-log.md`.
  Claude's newer status superseded Codex's older proposal on one point: the Octave support CTA
  should be removed, not preserved. Landed bounded Wave 1 Octave rollout as commit
  `b2dfb3d472`: converted `/features/octave` final section from split fit block + `StartCard` to
  shared `FeatureFinalBand`; kept concrete proof links (`Linux environment`, `Teaching`,
  `Compare operating models`); removed `Ask about Octave workflows`; and updated feature route
  canaries. Validation: `git diff --check`, focused `public/features/__tests__/app.test.tsx`
  (91/91), `pnpm lint:frontend`, `pnpm -C src/packages/static build:dev`, post-commit rebuild from
  `b2dfb3d472`, and browser QA for `/features/octave` + `/features/julia` desktop/mobile (72/72).
  Screenshots reviewed from `/tmp/cocalc-public-qa-RtWR4y`. Pushed to
  `origin/blaec-synthesis-2026-06-18`; no PR. Worktree clean except known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx`.
- **START/END 2026-06-21 18:50 PDT:** Executed Blaec's extended direction (a) in two bounded
  slices after re-reading `cocalc-shared/INDEX.md`, `claude-current-status.md`, and
  `codex-turn-log.md`. First slice commit `9a1800e9e3` removes the remaining feature-ending
  `Ask about X` support CTAs from Automations, Teaching, Whiteboard, Slides, SageMath, R, and
  More Languages; Julia/Octave were already removed. Teaching's layout was preserved. Updated
  feature route canaries and the browser-QA Teaching rule. Validation: `git diff --check`,
  focused feature Jest 93/93, browser-QA script Jest 5/5, `pnpm lint:frontend`,
  `pnpm -C src/packages/static build:dev`, and affected-route browser QA 264/264 across
  Automations/Teaching/Whiteboard/Slides/Sage/R/More Languages/Octave desktop+mobile. Screenshots
  reviewed from `/tmp/cocalc-public-qa-eQqaT6`.
- **START/END 2026-06-21 18:50 PDT:** Continued Wave 1 with More Languages only. Commit
  `61a12f817e` converts `/features/more-languages` from split fit block + `StartCard` to
  `FeatureFinalBand`; keeps concrete proof (`C`, `C++`, `Fortran`, `Rust`, `Go`, `Java`, `Bash`,
  `SQL`, `JavaScript`, `TypeScript`, compilers, scripts, notebooks, terminals) and three related
  links (`Jupyter notebooks`, `Teaching`, `Compare operating models`). Validation: focused feature
  Jest 94/94, `pnpm lint:frontend`, `pnpm -C src/packages/static build:dev`, post-commit rebuild
  from `61a12f817e`, and final-band browser QA 94/94 for More Languages/Octave/Julia
  desktop+mobile. Screenshot reviewed from `/tmp/cocalc-public-qa-RYvssK`. Pushed to
  `origin/blaec-synthesis-2026-06-18`; no PR. Worktree clean except known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx`.
- **START 2026-06-21 18:58 PDT:** Continuing the accepted dynamically logged Wave 1 prompt with
  `/features/automations` only. Scope: convert the existing final section from split fit block +
  `StartCard` to `FeatureFinalBand`; keep the existing automation proof around scheduled jobs,
  notebooks, scripts, shell commands, outputs, recurring project work, API/CLI relation, and
  reviewable project results; keep the related links `Terminal workflows`, `Jupyter notebooks`,
  and `Compare operating models`; do not restore `Ask about project automations`. Claimed files:
  `src/packages/frontend/public/features/automations-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: protected home, pitch docs, docs
  routes/content, pricing/compliance, type/palette work, Sage, Teaching, Python, Terminal,
  Jupyter, the untracked dedicated-compute draft, and PRs.
- **END 2026-06-21 19:00 PDT:** Landed the Automations Wave 1 conversion in source: the final
  section now uses `FeatureFinalBand`, keeps the existing fit bullets and primary CTA, and moves
  `Terminal workflows`, `Jupyter notebooks`, and `Compare operating models` into the full-width
  `Related` row. Concrete automation proof remained unchanged. Validation: `git diff --check`,
  focused feature Jest 95/95, `pnpm lint:frontend` from `src`, `pnpm -C src/packages/static
  build:dev`, and browser QA for Automations/Julia/Octave/More Languages desktop+mobile 116/116.
  Screenshots reviewed from `/tmp/cocalc-public-qa-WVAkyF`; no PR.
- **START 2026-06-21:** Following Blaec's approval of the logged Codex prompt at
  `/home/user/cocalc-shared/codex-turn-log.md:4076`. Scope: one-line Octave micro-copy only,
  changing the secondary section headline from `Teach and run Octave without local setup drift.`
  to `Run reproducible Octave work without local setup drift.` and updating the exact route
  canary. Preserve current Octave tool proof and do not add MATPOWER, energy, or grid-modeling
  claims without source/runtime/docs grounding. Claimed files:
  `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`; no PR.
- **END 2026-06-21:** Octave micro-copy landed in source. Updated the Octave secondary section
  headline to `Run reproducible Octave work without local setup drift.` and updated both the
  route canary and browser-QA required text. Did not add MATPOWER/energy/grid claims. Validation:
  `git diff --check`, focused feature Jest 95/95, browser-QA script Jest 5/5, `pnpm lint:frontend`
  from `src`, `pnpm -C src/packages/static build:dev`, and browser QA for `/features/octave`
  desktop+mobile 36/36. Screenshots reviewed from `/tmp/cocalc-public-qa-ucOsFt`; no PR.
- **START 2026-06-21:** Implementing the final Wave-1 `/features/whiteboard` slice from Blaec's
  latest direction and Claude's accepted state. Scope: convert only the Whiteboard final section
  from split fit block + `StartCard` to `FeatureFinalBand`, with fit logic on the left, one
  distinct primary CTA, and a full-width `Related` row (`Slide decks`, `Teaching`,
  `Compare operating models`). Preserve existing proof for editable math, Jupyter cells,
  diagrams, slide-sized pages, computational workflows, shared boards, code/output/math on the
  board, office-hours/live support, and board-to-deck workflows. Claimed files:
  `src/packages/frontend/public/features/whiteboard-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Out of scope: Teaching layout, slide-deck and
  execution-graph sections, protected home, pitch docs, docs routes/content, pricing/compliance,
  type/palette work, Sage, Python, Terminal, Jupyter, the dedicated-compute draft, and PRs.
- **END 2026-06-21:** Whiteboard Wave-1 conversion landed in source. The final section now uses
  `FeatureFinalBand`, keeps the existing fit bullets and primary CTA, and moves `Slide decks`,
  `Teaching`, and `Compare operating models` into the full-width `Related` row. Earlier
  slide-deck and execution-graph sections were untouched; `Ask about whiteboards` stayed removed.
  Validation: `git diff --check`, focused feature Jest 96/96, browser-QA script Jest 5/5,
  `pnpm lint:frontend` from `src`, `pnpm -C src/packages/static build:dev`, and browser QA for
  Whiteboard/Julia/Octave/More Languages/Automations desktop+mobile 152/152. Screenshots reviewed
  from `/tmp/cocalc-public-qa-qczjhA`; no PR.

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

---

## Codex — decision-(a) support-CTA extension (2026-06-22)

- **START 2026-06-22:** Working in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Scope is the Blaec-confirmed support-CTA removal
  extension only: remove final `Ask about X` support CTAs and unused
  `featureSupportPath` plumbing from `ai`, `latex-editor`, `python`, `linux`,
  `terminal`, and `jupyter-notebook`; update route canaries and browser-QA
  guards. No layout/band conversion, no copy rewrite, no cli/api/dedicated-
  compute, no protected home/pitch/docs routes/pricing/compliance/type-palette.
  Known unrelated untracked file remains
  `src/packages/frontend/public/features/dedicated-compute-page.tsx`.
- **END 2026-06-22:** Decision-(a) extension implemented and validated. Removed
  the six remaining support-ask CTAs and dangling support-link plumbing; CLI/API
  contextual support CTAs intentionally remain. Updated feature tests and
  browser-QA forbidText guards. Validation passed: `git diff --check`; focused
  feature Jest 96/96; browser-QA harness Jest 5/5; `pnpm -C src
  lint:frontend`; `pnpm -C src/packages/static build:dev`; browser QA on
  `/features/ai`, `/features/latex-editor`, `/features/python`,
  `/features/linux`, `/features/terminal`, `/features/jupyter-notebook`
  desktop+mobile 228/228. Screenshots inspected. Ready to commit/push/rebuild
  preview; next queued slice is framing-alignment, one cluster at a time.

---

## Codex — framing-alignment batch + Wave-3 (2026-06-22)

- **START 2026-06-22:** Working in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Scope from Blaec: apply finalized
  `site-framing-alignment-slice-2026-06-21.md` in three grouped commits, then
  proceed to Wave-3 final-section assessment/rollout for R, Slides, and Sage.
  Current group: Commit 1 = features-index + languages + tools +
  other-features, plus Octave primary CTA label `Get using Octave` → `Start
  using Octave`. Guardrails: preserve concrete proof, use audience-led broad
  language, no vertical-specific language, avoid protected home/pitch/docs
  routes/pricing/compliance/type-palette and the dedicated-compute draft. Known
  unrelated untracked file remains
  `src/packages/frontend/public/features/dedicated-compute-page.tsx`.
- **END Commit 1 2026-06-22:** Applied the feature-page framing alignment group:
  feature index, languages, tools, and other-feature routes now use the approved
  broad audience-led language while preserving concrete tool proof. Octave's
  primary CTA was already `Start using Octave`; left it unchanged. One stale
  vertical-specific Linux example in the slice file was intentionally replaced
  with a tool-led package-manager line to honor Blaec's latest no-vertical
  instruction. Updated feature Jest canaries and browser-QA rendered-text
  guards. Validation passed: `git diff --check`; focused feature Jest 96/96;
  browser-QA harness Jest 5/5; `pnpm -C src lint:frontend`; `pnpm -C
  src/packages/static build:dev`; browser QA on `/features`,
  `/features/automations`, `/features/jupyter-notebook`, `/features/terminal`,
  `/features/linux`, `/features/python`, `/features/latex-editor`,
  `/features/sage`, `/features/r-statistical-software`, `/features/julia`,
  `/features/octave`, `/features/more-languages`, `/features/whiteboard`, and
  `/features/slides` desktop+mobile passed 540/540. Screenshots inspected from
  `/tmp/cocalc-public-qa-4HSRZz`. Ready for commit/push/rebuild.
- **START/END Commit 2 2026-06-22:** Applied the products + compare +
  supporting framing-alignment group. Claimed files:
  `products/app.tsx`, `features/compare-page.tsx`, `guides/app.tsx`,
  `docs/app.tsx`, `support/app.tsx`, public app/feature tests, and
  `public-site-browser-qa.mjs`. Scope stayed on public landing surfaces; no
  protected home, pitch docs, docs content/routes, pricing/compliance, type or
  palette work, or dedicated-compute draft touched. Updated canaries and
  browser-QA guards for changed text. Validation passed so far: stale
  vertical-specific scan clean for changed files; `git diff --check`; focused
  Jest 150/150 across public app, feature compare, docs, and QA harness;
  `pnpm -C src lint:frontend`; `pnpm -C src/packages/static build:dev`;
  browser QA on `/products`, product detail routes, `/features/compare`,
  `/guides`, `/docs`, and `/support` desktop+mobile passed 350/350 with
  screenshots inspected from `/tmp/cocalc-public-qa-i0foWS`. Ready for
  commit/push/rebuild.
- **START/END Commit 3 2026-06-22:** Applied the approved global footer copy in
  `public/layout/shell.tsx` and updated its layout test plus a browser-QA footer
  canary. No protected home, pitch docs, docs content/routes, pricing/compliance,
  type/palette work, or dedicated-compute draft touched. Validation passed:
  `git diff --check`; focused layout + browser-QA harness Jest 18/18; `pnpm -C
  src lint:frontend`; `pnpm -C src/packages/static build:dev`; browser QA on
  `/products`, `/features`, `/docs`, and `/support` desktop+mobile passed
  174/174. Screenshots inspected from `/tmp/cocalc-public-qa-TxCGI4`; footer
  wraps cleanly on desktop and mobile. Ready for commit/push/rebuild.
- **START/END Wave-3 R 2026-06-22:** Assessed `/features/r-statistical-software`
  as a clean `FeatureFinalBand` candidate. Converted only the final
  `StartCard` section to the shared band, preserving R-specific proof:
  notebooks/scripts, Quarto/RMarkdown, HTML/PDF reports, TimeTravel history,
  Python/LaTeX related paths, and teaching workflows in the CTA body. No
  protected home, pitch docs, docs content/routes, pricing/compliance,
  type/palette, Sage, Slides, or dedicated-compute draft touched. Validation
  passed: `git diff --check`; focused feature Jest 97/97; `pnpm -C src
  lint:frontend`; `pnpm -C src/packages/static build:dev`; browser QA on
  `/features/r-statistical-software` desktop+mobile passed 38/38. Screenshots
  inspected from `/tmp/cocalc-public-qa-q0ji36`; mobile order is fit proof,
  primary CTA, then Related.
- **START/END Wave-3 Slides 2026-06-22:** Assessed `/features/slides` as a
  clean `FeatureFinalBand` candidate. Converted only the final `StartCard`
  section to the shared band, preserving slide-specific proof: slide-sized
  whiteboards, markdown, math, diagrams, Jupyter cells, code, deck flow,
  collaborative editing, and TimeTravel history. No protected home, pitch docs,
  docs content/routes, pricing/compliance, type/palette, Sage, or
  dedicated-compute draft touched. Validation passed: `git diff --check`;
  focused feature Jest 98/98; `pnpm -C src lint:frontend`; `pnpm -C
  src/packages/static build:dev`; browser QA on `/features/slides`
  desktop+mobile passed 34/34. Screenshots inspected from
  `/tmp/cocalc-public-qa-hqubF5`; mobile order is fit proof, primary CTA, then
  Related.
