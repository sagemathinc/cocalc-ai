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

### Codex - Restraint/dedup /features/terminal item 51 (2026-06-23 07:01 PDT)

- **START 2026-06-23 07:01 PDT:** Continuing the scheduled landing-page
  improvement loop on live queue item 51 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `6439b20261`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known lane-gated untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431`, both rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/terminal-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/terminal` browser QA, this
  ledger, and the shared turn log if the slice lands. Route frame: visitor asks
  whether a Linux shell can stay close to project files and review context
  without repeating the same split-pane/live-stream/beside-the-work pitch in
  every band. Change budget: dedup "split panes", "one live stream", and the
  "beside the work" enumeration; trim the final-band kitchen-sink bullet to
  three or four concrete neighbors. Excluded: Blaec-gated collaborative-terminal
  detail restoration.
- **END 2026-06-23 07:08 PDT:** Landed the item 51 terminal restraint pass.
  Replaced the hero lead so the live-stream point appears only in the context
  list, changed the context list's split-pane slot to disconnect recovery,
  kept one split-pane bullet, kept one "beside the work" carrier in the proof
  section heading, and trimmed the final-band kitchen-sink bullet to notebooks,
  source files, Git, and generated output. Added Jest/browser-QA canaries
  against the removed duplicate phrases. No protected home/theme, pricing,
  policy, compliance copy, or Blaec-gated collaborative-terminal restoration was
  touched. Validation passed: terminal-focused Jest 7/7, `pnpm -C src
  lint:frontend`, `git diff --check`, `pnpm -C src/packages/static build:dev`
  (known local debug-log EACCES warning only), and `/features/terminal` browser
  QA desktop+mobile 68/68 at `/tmp/cocalc-public-qa-qgDLZj`; screenshots
  inspected clean.

### Codex - Scheduled loop awaiting item 50 audit (2026-06-23 06:21 PDT)

- **START 2026-06-23 06:21 PDT:** Ran the scheduled landing-page
  improvement loop against the live queue and durable contract. Current head is
  `ccd95bb93d`, matching `origin/blaec-synthesis-2026-06-18`; that commit is
  the already-landed item 50 Linux restraint pass. The queue file still lists
  item 50 as `[ ]`, but this ledger and `codex-turn-log.md` record it as
  landed pending Claude audit. Preview owner remains hub pids `27390` and
  `27431`, both rooted at `/home/user/cocalc-ai-synthesis/src`. Claimed files:
  this ledger and the shared turn log only. Do not touch public-site source or
  pull item 51 until Claude records/accepts item 50 or explicitly clears the
  restraint batch to continue.
- **END 2026-06-23 06:22 PDT:** No public-site source change was made. Confirmed
  Claude's audit log accepts item 49 (`879b3d9945`) but has no item 50
  (`ccd95bb93d`) verdict yet, so audit backpressure applies and this run stops
  as `awaiting-audit`. Worktree dirt remains only the known lane-gated untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft. No
  build, Jest, lint, TypeScript, or browser QA was run because no rendered route
  or source file changed.

### Codex - Restraint/dedup /features/linux item 50 (2026-06-23 06:01 PDT)

- **START 2026-06-23 06:01 PDT:** Continuing the scheduled landing-page
  improvement loop on live queue item 50 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `879b3d9945`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/linux-page.tsx`, `features/feature-accents.ts`,
  `features/__tests__/app.test.tsx`, `scripts/public-site-browser-qa.mjs`,
  `/features/linux` browser QA, this ledger, and shared turn logs if the slice
  lands. Route frame: visitor asks whether a project Linux environment can be
  administered, verified, and shared without turning setup into detached
  operations work. Change budget: dedup the hero lead vs. context list,
  preserve one co-location/durability carrier in section two, fix the
  `graphviz version reported` code line so it is not an invalid pasted command,
  move the Linux accent literals into `FEATURE_ACCENTS.linux`, and remove the
  duplicate software-install related link. Excluded: Blaec-gated services proof
  restoration.
- **END 2026-06-23 06:10 PDT:** Landed the item 50 Linux restraint pass.
  Replaced the hero lead so it no longer repeats the context list or the
  unsubstantiated services cue, kept the single project-location carrier in
  section two, changed the Graphviz output marker into a shell comment, moved
  Linux page accent literals into `FEATURE_ACCENTS`, trimmed the final related
  links to three, and added canaries against the removed services wording. No
  protected home/theme, pricing, policy, or compliance copy was touched.
  Validation passed before commit: public/features Jest 206/206 including
  protected surfaces, `pnpm -C src tsc`, `pnpm -C src lint:frontend`, `git diff
  --check`, `pnpm -C src/packages/static build:dev` (known local debug-log
  EACCES warning only), and `/features/linux` browser QA desktop+mobile 58/58
  at `/tmp/cocalc-public-qa-Vl4Jjf`; screenshots inspected clean.

### Codex - Restraint/dedup /features/latex item 49 (2026-06-23 05:22 PDT)

- **START 2026-06-23 05:22 PDT:** Continuing the scheduled landing-page
  improvement loop on live queue item 49 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `750f301a5c`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/latex-editor-page.tsx`, `/features/latex-editor` browser QA,
  this ledger, and shared queue/turn logs if the slice lands. Route frame:
  visitor asks whether a paper that depends on code, figures, review history,
  and computation belongs in CoCalc rather than a dedicated LaTeX editor;
  promise is keeping the paper beside the work that supports it. Change budget:
  remove the duplicated closing-band paragraph only, preserving the fit panel,
  related links, CTAs, SageTeX proof, and accessibility scaffolding.
- **END 2026-06-23 05:24 PDT:** Landed the item 49 restraint cut for
  `/features/latex-editor`. Removed the final-band child paragraph that
  repeated the fit-panel/workspace wedge; preserved the final-band title,
  action panel, related links, fit panel, SageTeX proof, route CTAs, and
  accessibility scaffolding. Validation passed: focused LaTeX Jest 6/6,
  `pnpm -C src lint:frontend`, `pnpm -C src/packages/static build:dev` (known
  local debug-log EACCES warning only), and `/features/latex-editor` browser QA
  desktop+mobile 56/56 at `/tmp/cocalc-public-qa-fleBly`; screenshots inspected
  clean. No protected surfaces, pricing, policy, or compliance copy were
  touched.

### Codex - Compliance/legal copy protection item 48 (2026-06-23 03:43 PDT)

- **START 2026-06-23 03:43 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 48 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `403dd5ed1b`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `public/__tests__/compliance-copy.test.ts` plus this ledger and shared
  queue/turn logs if the slice lands. Task frame: add canary coverage for
  load-bearing compliance/legal/security tokens in built-in policies
  (`trust`, `dpa`, `privacy`, `ferpa`, `terms`, `accessibility`) and the
  pricing compliance/support sentences, without changing the policy or pricing
  copy itself. Guardrails: do not edit protected home/theme/gate files, do not
  rewrite legal text, and keep the canary focused on exact current public copy.
- **END 2026-06-23 03:46 PDT:** Landed the item 48 compliance/legal copy
  canary. Added `public/__tests__/compliance-copy.test.ts`, a source-level
  normalized-whitespace canary covering load-bearing terms in built-in
  `trust`, `dpa`, `privacy`, `ferpa`, `terms`, and `accessibility` policy
  files plus the pricing compliance/support sentences. No policy, pricing,
  home, theme, or protected-gate source copy was changed. Validation passed:
  focused compliance-copy Jest 7/7, public/features Jest 206/206, `pnpm -C src
  tsc`, `pnpm -C src lint:frontend`, `git diff --check`, and `pnpm --dir
  src/packages/static build:dev` (known local static-build debug-log EACCES
  warning only; Node emitted the existing localStorage ExperimentalWarning
  during the node-env canary). No route UI changed, so no route-specific browser
  QA was run.

### Codex - Protected gate self-bypass hardening item 47 (2026-06-23 03:33 PDT)

- **START 2026-06-23 03:33 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 47 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `cde0931205`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `public/__tests__/protected-surfaces.test.ts`,
  `public/__tests__/protected-overrides.ts`, this ledger, and shared queue/turn
  logs if the slice lands. Task frame: make the gate non-self-bypassable by
  protecting the gate files themselves and rejecting a protected override
  addition when it lands with protected-source changes in the same commit.
  Implementation note: because `protected-overrides.ts` stores its own
  baselines, use canonical hashing that normalizes that file's own baseline hash
  before calculating drift. Guardrails: do not edit protected home/theme content
  or compliance copy; keep the scope to gate files and fixtures.
- **END 2026-06-23 03:38 PDT:** Landed the item 47 self-bypass hardening.
  Added the `protected-gate` protected surface for
  `public/__tests__/protected-overrides.ts` and
  `public/__tests__/protected-surfaces.test.ts`, with baselines for both files.
  Added canonical hashing for `protected-overrides.ts` so its own stored
  baseline hash is normalized before drift checks. Added detection for protected
  override additions and a red fixture proving an override addition cannot land
  with a protected-source change in the same commit. Preserved the item 46
  committed-range and home-baseline behavior. Validation passed: focused
  protected Jest 7/7, public/features Jest 199/199, `pnpm -C src tsc`,
  `pnpm -C src lint:frontend`, `git diff --check`, and `pnpm --dir
  src/packages/static build:dev` (known local static-build debug-log EACCES
  warning only). No route UI changed, so no route-specific browser QA was run.

### Codex - Gate hardening home protected surface item 46 (2026-06-23 03:25 PDT)

- **START 2026-06-23 03:25 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 46 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `3fa2a369cb`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `public/__tests__/protected-surfaces.test.ts`,
  `public/__tests__/protected-overrides.ts`, this ledger, and shared queue/turn
  logs if the slice lands. Task frame: fix the protected-surface gate so it
  scans a committed diff range by default instead of an empty post-commit
  worktree, hard-fails unresolved diff bases, adds home path/hash baselines, and
  proves red on a home drift plus green with an explicit override fixture.
  Guardrails: do not edit protected home content itself; do not broaden the
  protected-surface scope beyond item 46.
- **END 2026-06-23 03:29 PDT:** Landed the item 46 gate hardening. The
  protected-surface gate now resolves a committed diff base by default
  (`HEAD~1`) or a `PROTECTED_BASE_REF` merge-base, hard-fails unresolved bases,
  and scans `base..HEAD` instead of the post-commit worktree. Replaced the
  broad home override with four `home/` path/hash baselines for the accepted
  committed home files, added baseline-drift offenders so a protected committed
  change fails even if the changed-set misses it, and added red/green fixture
  tests for home drift without/with an explicit override. No protected home
  source was edited. Validation passed: focused protected Jest 5/5,
  public/features Jest 197/197, `pnpm -C src tsc`, `pnpm -C src
  lint:frontend`, `git diff --check`, and `pnpm --dir src/packages/static
  build:dev` (known local static-build debug-log EACCES warning only). No
  route UI changed, so no route-specific browser QA was run.

### Codex - Density /features/ai item 43 (2026-06-23 03:16 PDT)

- **START 2026-06-23 03:16 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 43 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `33400023a3`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/ai-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/ai` browser QA, this
  ledger, and shared queue/turn logs if the slice lands. Route frame: visitor
  asks whether Codex can work inside real project context instead of a detached
  chat; promise is agent work tied to files, notebooks, terminals, tests,
  collaborators, and review history. Must collapse the hero second paragraph,
  merge the "Review agent work" section into the final band, cut
  `ProjectContextPanel`, move notebook-review detail to a
  `/features/jupyter-notebook` related link, and preserve `ThreadMock`, the
  four-step `WorkflowStrip`, the wedge stated once, both CTAs, a11y, terminal
  and products links, and a clear "Codex edits Markdown/code/notebooks"
  capability mention.
- **END 2026-06-23 03:21 PDT:** Landed the density cut for `/features/ai`:
  source now measures 282 lines versus 335 at `33400023a3`. Collapsed hero
  support copy to one paragraph with Codex file/Markdown/code/notebook/check
  capability intact; removed `ProjectContextPanel` and the standalone "Review
  agent work" section; folded review rationale into the final band; added the
  `/features/jupyter-notebook` related link for notebook-review depth; and
  preserved `ThreadMock`, the four-step `WorkflowStrip`, final-band wedge,
  Codex guide CTA, project CTA, terminal/products links, and a11y. Updated the
  feature smoke test and `/features/ai` browser-QA canaries for the shorter
  copy, removed context panel, and new Jupyter link. Validation passed: focused
  feature/browser-QA Jest 139/139, public/features Jest 195/195,
  `pnpm -C src tsc`, `pnpm -C src lint:frontend`, `git diff --check`, and
  `pnpm --dir src/packages/static build:dev && node
  src/packages/frontend/scripts/public-site-browser-qa.mjs --route
  /features/ai --viewport desktop --viewport mobile` (52/52 assertions,
  artifact `/tmp/cocalc-public-qa-cNjY0o`). Desktop and mobile screenshots
  inspected clean. Known local static-build debug-log EACCES warning only.

### Codex - Density /features/teaching item 42 (2026-06-23 03:09 PDT)

- **START 2026-06-23 03:09 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 42 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `b65d9889f2`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/teaching-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/teaching` browser QA, this
  ledger, and shared queue/turn logs if the slice lands. Route frame: visitor
  asks whether CoCalc belongs beside an LMS for real technical coursework;
  promise is assignments in student projects with visible help, grading,
  history, and shared environments. Must delete the standalone
  LMS-vs-CoCalc/`CourseBoundaryPanel` section, collapse hero support copy to
  one paragraph, trim final-band bullet 1, and preserve Section 3 in full:
  assignment loop title/body, `BulletList`, `WorkflowDiagram`,
  `CourseDashboardMock`, `nbgrader queue ready`, final-band wedge, a11y, guide
  links, and authenticated/unauthenticated CTAs.
- **END 2026-06-23 03:13 PDT:** Landed the density cut for
  `/features/teaching`: source now measures 377 lines versus 451 at
  `b65d9889f2`. Removed the standalone LMS/CoCalc boundary section and
  `CourseBoundaryPanel`, collapsed hero support copy to one paragraph that
  keeps LMS context, and trimmed final-band bullet 1. Preserved the assignment
  loop section in full, including title/body, `BulletList`, `WorkflowDiagram`,
  `CourseDashboardMock`, `nbgrader queue ready`, final-band wedge, guide links,
  authenticated/unauthenticated CTAs, and the light final panel. Updated the
  feature smoke test and `/features/teaching` browser-QA canaries to forbid the
  deleted boundary heading and require retained hero/assignment-loop copy.
  Validation passed: focused feature/browser-QA Jest 140/140, public/features
  Jest 196/196, `pnpm -C src tsc`, `pnpm -C src lint:frontend`, `git diff
  --check`, and `pnpm --dir src/packages/static build:dev && node
  src/packages/frontend/scripts/public-site-browser-qa.mjs --route
  /features/teaching --viewport desktop --viewport mobile` (58/58 assertions,
  artifact `/tmp/cocalc-public-qa-aRgMnA`). Desktop and mobile screenshots
  inspected clean. Known local static-build debug-log EACCES warning only.

### Codex - Density /features/compare item 41 (2026-06-23 02:59 PDT)

- **START 2026-06-23 02:59 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 41 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `7c62d9110f`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/compare-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/compare` browser QA, this
  ledger, and shared queue/turn logs if the slice lands. Route frame: visitor
  asks whether CoCalc is worth evaluating instead of a narrower notebook,
  dashboard, editor, LMS, or fixed hosted setup; promise is a project-centered
  fit decision for teams with files, kernels, terminals, history, collaborators,
  AI agents, teaching, or operating-model questions. Must preserve the five-row
  decision table, both columns, visually hidden caption, `scope` headers,
  `data-label` mobile labels, responsive CSS, both hero CTAs with support
  deep-link context, and a light R&D/roles signal in the first two rows.
  Decision: keep structure unchanged while tightening quick-read copy, table
  cells, and section intros.
- **END 2026-06-23 03:07 PDT:** Landed the density cut for
  `/features/compare`: source now measures 439 lines versus 445 at
  `7c62d9110f`, with the visible reduction concentrated in table cells, the
  quick-read list, and section intro copy. Cut the quick-read third bullet,
  tightened decision-table cells across all five rows while preserving the R&D
  and role signals in rows 1-2, and shortened both section intros. Preserved
  all five rows, both table columns, visually hidden caption, scope headers,
  `data-label` mobile labels, responsive table CSS, both hero CTAs, support
  deep-link context, route links, and trust-material conditional routing.
  Updated the feature smoke test and `/features/compare` browser-QA canary for
  the shorter hero/quick-read copy. Validation passed: focused
  feature/browser-QA Jest 140/140, public/features Jest 196/196,
  `pnpm -C src tsc`, `pnpm -C src lint:frontend`, `git diff --check`, and
  `pnpm --dir src/packages/static build:dev && node
  src/packages/frontend/scripts/public-site-browser-qa.mjs --route
  /features/compare --viewport desktop --viewport mobile` (42/42 assertions,
  artifact `/tmp/cocalc-public-qa-GZWPHx`). Desktop and mobile screenshots
  inspected clean. Known local static-build debug-log EACCES warning only.

### Codex - Density /features/jupyter-notebook item 40 (2026-06-23 02:50 PDT)

- **START 2026-06-23 02:50 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 40 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `e09ffe5955`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/jupyter-notebook-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/jupyter-notebook` browser
  QA, this ledger, and shared queue/turn logs if the slice lands. Route frame:
  visitor asks whether Jupyter work can stay connected to files, packages,
  collaborators, kernels, terminal/Linux tools, and review history; promise is
  a notebook that keeps going in the surrounding project; proof mechanism is
  the three StoryCards, `NotebookEvidencePanel`, and project-scoped Jupyter
  `CodeBlock`; primary next step is start/open a project; secondary next steps
  are compatibility guide, terminal, Linux, whiteboard, and products links.
  Must not claim invented notebook metrics or generic JupyterHub replacement.
  Decision: preserve the test-pinned skeleton while cutting the middle
  BulletLists and trimming hero context to the essential proof points.
- **END 2026-06-23 03:00 PDT:** Landed the density cut for
  `/features/jupyter-notebook`: source now measures 230 lines versus 249 at
  `e09ffe5955`. Trimmed hero support copy to one line, reduced hero context
  from four items to two, removed the two middle `BulletList` blocks, and kept
  the three StoryCards, `NotebookEvidencePanel`, project-scoped Jupyter
  `CodeBlock`, terminal/Linux mention, final directed-graph bullet, and final
  related-link routing. Updated the feature smoke test and browser QA canary
  for the preserved terminal/Linux and hero-copy assertions. Validation passed:
  focused feature/browser-QA Jest 140/140, public/features Jest 196/196,
  `pnpm -C src tsc`, `pnpm -C src lint:frontend`, `git diff --check`, and
  `pnpm --dir src/packages/static build:dev && node
  src/packages/frontend/scripts/public-site-browser-qa.mjs --route
  /features/jupyter-notebook --viewport desktop --viewport mobile`
  (50/50 assertions, artifact `/tmp/cocalc-public-qa-SO8Jy0`). Desktop and
  mobile screenshots inspected clean. Known local static-build debug-log
  EACCES warning only.

### Codex - Density /features/terminal item 39 (2026-06-23 02:44 PDT)

- **START 2026-06-23 02:44 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 39 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `c288b108d6`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/terminal-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/terminal` browser QA, this
  ledger, and shared queue/turn logs if the slice lands. Route frame: visitor
  is a technical user or reviewer asking whether shell work can stay attached
  to the project instead of disappearing into a private terminal; promise is a
  real Linux terminal that opens where the work lives and remains shareable and
  reviewable; proof mechanism is the kept `TerminalEvidencePanel`, `.term`
  folder anchor, and merged durability/collaboration bullets; primary next
  step is start/open a project; secondary next steps are the terminal guide,
  Linux, Jupyter, software-install, and products links. Must not claim
  benchmark/restore timing, broad agent-platform support, or managed compute.
  Decision: collapse the hero, keep StoryCard 1, cut StoryCards 2-3, merge the
  evidence sub-blocks, and preserve TimeTravel/scrollback in the merged band.
- **END 2026-06-23 02:49 PDT:** Item 39 source edit complete. Reduced
  `/features/terminal` from 284 to 207 source lines and collapsed the route to
  three bands: hero, one proof section, and final band. Removed the hero's
  second `.term` paragraph, cut the duplicate "One session stays visible" and
  "Output remains reviewable" StoryCards, merged the collaboration/durability
  evidence into the main proof band, and cut the standalone split-pane section.
  Preserved the H1 canary, the "Each terminal opens in its own folder." `.term`
  anchor, `TerminalEvidencePanel` role/aria proof, split-pane bullet,
  TimeTravel/scrollback sentence, and final-band heading/links. Validation
  passed: focused feature/browser-QA Jest
  `public/features/__tests__/app.test.tsx public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`
  (140/140); public/features Jest `public/__tests__ public/features/__tests__
  --runInBand --silent` (196/196); `git diff --check`; `pnpm -C src tsc`;
  `pnpm -C src lint:frontend`; `pnpm --dir src/packages/static build:dev`
  (known debug-log EACCES warning only); `/features/terminal` browser QA
  desktop+mobile (58/58) with screenshots in
  `/tmp/cocalc-public-qa-i6Mc4X` inspected.

### Codex - Density /features/linux item 38 (2026-06-23 02:32 PDT)

- **START 2026-06-23 02:32 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 38 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `fc2a701365`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/linux-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/linux` browser QA, this
  ledger, and shared queue/turn logs if the slice lands. Route frame: visitor
  is a technical teammate, instructor, or lab lead asking whether CoCalc gives
  a real project Linux environment they can administer and document; promise
  is install at the right layer, verify, and leave the setup with the project;
  proof mechanism is the kept package-install `CodeBlock` plus project Linux
  context and reusable-environment links; primary next step is start/open a
  project; secondary next steps are terminal, Jupyter, software-install, image,
  and products links. Must not claim benchmark/setup timing, managed compute,
  compliance, or internal root-filesystem architecture. Decision: cut the
  duplicate story row and LinuxEvidencePanel, merge install/layer proof, keep
  `graphviz version reported` in the CodeBlock canary.
- **END 2026-06-23 02:43 PDT:** Item 38 source edit complete. Reduced
  `/features/linux` from 317 to 165 source lines and collapsed the page to
  three bands: hero, one install/layer proof section, and the final band.
  Removed the story row, `LinuxEvidencePanel`, `TerminalMock`, duplicate
  install/layer section, standalone reusable-environments section, and the
  extra hero Terminal details button. Preserved the project Linux context list,
  the Layer `CodeBlock` as the single tool proof, the `graphviz version
  reported` canary inside that proof, the wedge sentence "you decide what
  runs...", reusable-environment context in the final band, and all related
  links. Validation passed: focused feature/browser-QA Jest
  `public/features/__tests__/app.test.tsx public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`
  (140/140); public/features Jest `public/__tests__ public/features/__tests__
  --runInBand --silent` (196/196); `git diff --check`; `pnpm -C src tsc`;
  `pnpm -C src lint:frontend`; `pnpm --dir src/packages/static build:dev`
  (known debug-log EACCES warning only); `/features/linux` browser QA
  desktop+mobile (54/54) with screenshots in
  `/tmp/cocalc-public-qa-7A9aqG` inspected.

### Codex - Density /features/latex item 37 (2026-06-23 02:22 PDT)

- **START 2026-06-23 02:22 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 37 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `bd1876d1ff`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pids `27390` and `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/latex-editor-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features/latex-editor` browser QA,
  this ledger, and shared queue/turn logs if the slice lands. Route frame:
  visitor is a technical author/coauthor asking whether LaTeX work can stay
  beside code, figures, review, and history; promise is one project for the
  paper and its evidence; proof mechanism is the `LatexEvidencePanel`,
  SageTeX/computation sentence, and Paper context list; primary next step is
  start/open a project; secondary next steps are LaTeX guide, paper-polishing
  guide, Jupyter/terminal/product links; must not claim benchmark,
  competitor superiority, managed migration, compliance, or a generic
  dedicated-editor replacement. Decision: subtract redundant story/list
  sections, merge computation into the working-tree proof, preserve the fit
  positioning and table a11y inline.
- **END 2026-06-23 02:31 PDT:** Item 37 source edit complete. Reduced the
  `/features/latex-editor` page from 430 to 332 source lines and removed the
  redundant three-card story row, the "What stays with the paper" context
  list, the separate computation section, the separate fit-table section, and
  the final bullet list. Kept the hero Paper context list, the
  `LatexEvidencePanel` role/aria proof, the SageTeX/computation sentence, the
  dedicated/local/CoCalc fit positioning, the fit table caption/scope
  accessibility, and the related links. Validation passed: focused
  feature/browser-QA Jest
  `public/features/__tests__/app.test.tsx public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`
  (140/140); public/features Jest `public/__tests__ public/features/__tests__
  --runInBand --silent` (196/196); `git diff --check`; `pnpm -C src tsc`;
  `pnpm -C src lint:frontend`; `pnpm --dir src/packages/static build:dev`
  (known debug-log EACCES warning only); `/features/latex-editor` browser QA
  desktop+mobile (56/56) with screenshots in
  `/tmp/cocalc-public-qa-jCqd0J` inspected.

### Codex - HOME H1 micro-correction item 45 (2026-06-23 02:16 PDT)

- **START 2026-06-23 02:16 PDT:** Manual landing-page improvement loop on
  live queue item 45 in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Current head is `afc65d6afe`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner verified: hub pids `27390` and `27431` are rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `home/app.tsx`, `home/__tests__/app.test.tsx`,
  `home/__tests__/visual-quality.test.tsx`,
  `__tests__/protected-overrides.ts`,
  `scripts/public-site-browser-qa.mjs`, `/` browser QA, this ledger, and
  shared queue/turn logs if the slice lands. Scope: exactly the
  Blaec-directed H1 micro-correction from
  "Your tools, your AI agents, and your team — together in one project." to
  "Your tools, AI agents, and team — together in one project."; leave the
  subhead and the rest of home unchanged. Guardrails: no other home edits, no
  pricing money/compliance, no type/palette edits, no pitch docs, no raw-audit
  foraging, no dedicated-compute draft.
- **END 2026-06-23 02:21 PDT:** Item 45 source edit complete. Home H1 now
  reads exactly "Your tools, AI agents, and team — together in one project.";
  the subhead and the rest of the home page are unchanged. Updated home app
  and visual-quality H1 canaries, added an absence canary for the item-34 H1,
  updated the `/` browser-QA required text, and refreshed the home protected
  override reason to queue item 45. Validation passed: focused home/protected
  Jest
  `public/home/__tests__/app.test.tsx public/home/__tests__/visual-quality.test.tsx public/__tests__/protected-surfaces.test.ts public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`
  (15/15); public/features Jest `public/__tests__ public/features/__tests__
  --runInBand --silent` (196/196); `pnpm -C src tsc`; `pnpm -C src
  lint:frontend`; `git diff --check`; `pnpm --dir src/packages/static
  build:dev` (known debug-log EACCES warning only); and `/` browser QA
  desktop+mobile (34/34) with screenshots in
  `/tmp/cocalc-public-qa-sQspWR` inspected.

### Codex - re-freeze theme.ts item 36 (2026-06-23 02:03 PDT)

- **START 2026-06-23 02:03 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 36 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `cd98babeb8`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pid `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `public/__tests__/protected-overrides.ts`,
  `public/__tests__/protected-surfaces.test.ts`, protected-surface Jest, this
  ledger, and shared queue/turn logs if the slice lands. Scope: remove the
  standing `theme.ts` override, pin the current committed `theme.ts` hash so
  branch-diff CI accepts already-landed aliases, and keep future `theme.ts`
  edits gated. Guardrails: no source route edits, no home edits, no pricing
  money/compliance, no theme content edits, no pitch docs, no raw-audit
  foraging, no dedicated-compute draft.

### Codex - round-4 features index H1 item 35 (2026-06-23 01:57 PDT)

- **START 2026-06-23 01:57 PDT:** Continuing the manual landing-page
  improvement loop on live queue item 35 in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`.
  Current head is `02f13ff2b5`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner remains hub pid `27431` rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `features/app.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, `/features` browser QA, this ledger,
  and shared queue/turn logs if the slice lands. Scope: update the
  `/features` index H1 to Blaec's round-4 wording and update route canaries;
  leave the subhead unchanged because it supplies mechanism rather than
  restating the H1. Guardrails: no home edits, no pricing money/compliance, no
  type/palette edits, no pitch docs, no raw-audit foraging, no
  dedicated-compute draft.

### Codex - round-4 home H1 item 34 (2026-06-23 01:51 PDT)

- **START 2026-06-23 01:51 PDT:** Manual landing-page improvement loop on
  live queue item 34 in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Current head is `ef4245e346`, matching
  `origin/blaec-synthesis-2026-06-18`; the only pre-existing worktree dirt is
  the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Preview owner verified: hub pid `27431` cwd is
  `/home/user/cocalc-ai-synthesis/src`. Claimed files/routes:
  `home/app.tsx`, `home/__tests__/app.test.tsx`,
  `home/__tests__/visual-quality.test.tsx`,
  `__tests__/protected-overrides.ts`,
  `scripts/public-site-browser-qa.mjs`, `/` browser QA, this ledger, and
  shared queue/turn logs if the slice lands. Scope: exactly the
  Blaec-directed home H1 replacement, with the subhead and "Built for..."
  section unchanged. Guardrails: no other home edits, no pricing
  money/compliance, no type/palette edits, no pitch docs, no raw-audit
  foraging, no dedicated-compute draft.

### Codex - round-2 durability restraint item 28 (2026-06-23 00:43 PDT)

- **START 2026-06-23 00:43 PDT:** Continuing the scheduled landing-page
  improvement loop on Round-2 item 28 Durability restraint in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Current
  head is `8ab7bff53a`, matching `origin/blaec-synthesis-2026-06-18`; only the
  known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  present. Claimed files/routes: `features/whiteboard-page.tsx`,
  `features/__tests__/app.test.tsx`, `/features/whiteboard` browser QA, this
  ledger, and shared coordination logs if the slice completes. Scope: trim the
  whiteboard hero's bolted-on "durable, reviewable project" tail and update the
  exact route canaries; sibling scan found no same-tail subheads outside the
  explicit whiteboard target. Guardrails: no home, pricing money/compliance,
  type/palette 2e, pitch docs, raw-audit foraging, or dedicated-compute draft.
- **END 2026-06-23 00:45 PDT:** Trimmed the whiteboard hero from
  "Whiteboards and slides that keep the code, math, and explanations together
  — in one durable, reviewable project." to "Whiteboards and slides that keep
  the code, math, and explanations together."; updated the feature route
  marker tests and added an absence canary for the removed tail. Validation:
  `pnpm --dir src/packages/frontend exec jest
public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`
  (140/140); `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff
--check`; `pnpm --dir src/packages/static build:dev` (known debug-log EACCES
  warning only); `node
src/packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/whiteboard --viewport desktop --viewport mobile` (42/42,
  screenshots in `/tmp/cocalc-public-qa-S7Sh9l` inspected).

---

### Codex - round-2 bio facts item 27 follow-up (2026-06-23 00:38 PDT)

- **START/END 2026-06-23 00:38 PDT:** After pushing the source-backed
  William/Harald bio-facts commit `20f28461b0`, re-read the live
  `cocalc-shared/codex-queue.md` and found item 27 also included the
  Blaec-Bejarano audience-triplet trim. Completed that remaining subpart in
  `about/team-data.ts`: preserved the approved "research lab, technical team,
  or academic institution" contact line; reworked the applied-math/geophysical
  background line and the ICIAM/ICML demos line so they carry the audience point
  through his work without re-listing the same triplet; added a public app
  canary for the preserved line and removed repeated plural triplets.
  Validation: `pnpm --dir src/packages/frontend exec jest
public/__tests__/app.test.tsx --runInBand --silent` (41/41); `pnpm -C src
tsc`; `pnpm -C src lint:frontend`; `git diff --check`; `pnpm --dir
src/packages/static build:dev` (known debug-log EACCES warning only); `node
src/packages/frontend/scripts/public-site-browser-qa.mjs --route /about
--route /about/team/blaec-bejarano --route /about/team/william-stein --route
/about/team/harald-schilly --viewport desktop --viewport mobile` (88/88,
  screenshots in `/tmp/cocalc-public-qa-Y8oUvo` inspected). Guardrails held:
  no home, pricing money/compliance, type/palette 2e, pitch docs, raw-audit
  foraging, or dedicated-compute draft edits.

---

### Codex - round-2 bio facts item 27 (2026-06-23 00:31 PDT)

- **START 2026-06-23 00:28 PDT:** Continuing the scheduled landing-page
  improvement loop on Round-2 item 27 Bio Facts in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Current
  head is `539751a4b2`, matching `origin/blaec-synthesis-2026-06-18`; only the
  known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  present. Claimed files/routes: `about/team-data.ts`, public about tests,
  about/team browser-QA routes, this ledger, and shared coordination logs if
  the slice completes. Scope: correct William Stein employment dates and
  Harvard assistant-professor title/date from source-backed facts; consolidate
  Harald Schilly's Vienna degree to one entry. Source check: William's CV at
  `wstein.org/cv/cv.pdf` lists UW Professor 2010-2019, UW Associate Professor
  2006-2010, UCSD Associate Professor 2005-2006, and Harvard Benjamin Peirce
  Assistant Professor 2001-2005, so this slice follows the CV where the queued
  UCSD 2006-2010 note conflicts. Guardrails: no home edits, no pricing
  money/compliance changes, no type/palette 2e, no pitch docs, no raw-audit
  foraging, no LaTeX/dedicated-compute draft.
- **END 2026-06-23 00:33 PDT:** Corrected William's experience list to the
  CV-backed UW Professor 2010-2019, UW Associate Professor 2006-2010, UCSD
  Associate Professor 2005-2006, and Harvard Benjamin Peirce Assistant
  Professor 2001-2005 entries; consolidated Harald's Vienna degree into one
  Master's (Mag. rer. nat.) entry for 1999-2008; added public app canaries for
  both profiles. Validation: `pnpm --dir src/packages/frontend exec jest
public/__tests__/app.test.tsx --runInBand --silent`; `pnpm -C src tsc`;
  `pnpm -C src lint:frontend`; `git diff --check`; `pnpm --dir
src/packages/static build:dev` (known debug-log EACCES warning only);
  `node src/packages/frontend/scripts/public-site-browser-qa.mjs --route
/about --route /about/team/william-stein --route /about/team/harald-schilly
--viewport desktop --viewport mobile` (66/66 assertions, screenshots in
  `/tmp/cocalc-public-qa-BnvkKm` inspected).

---

### Codex - round-2 home H1 item 26 (2026-06-23 00:25 PDT)

- **START 2026-06-23 00:25 PDT:** Continuing the scheduled landing-page
  improvement loop on Round-2 item 26, the Blaec-directed HOME H1 change, in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Current
  head is `0455cc66a7`, matching `origin/blaec-synthesis-2026-06-18`; only the
  known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  present. Claimed files/routes: `home/app.tsx`, home tests, the `/` browser-QA
  canary, this ledger, and shared coordination logs if the slice completes.
  Scope is exactly the explicit Blaec H1 replacement: "Shared projects for
  Research, Technical Teams, and Teaching"; keep the subhead unchanged.
  Guardrails: no other home edits, no home heritage line, no pricing
  money/compliance changes, no type/palette 2e, no pitch docs, no raw-audit
  foraging, no LaTeX/dedicated-compute draft.
- **END 2026-06-23 00:27 PDT:** Round-2 item 26 source edit complete. Home H1
  now exactly reads "Shared projects for Research, Technical Teams, and
  Teaching"; the subhead is unchanged. Added a home test canary for the exact
  new H1 and absence of the old H1, and updated the `/` browser-QA required
  text. Validation passed: home-focused Jest
  `public/home/__tests__/app.test.tsx public/home/__tests__/visual-quality.test.tsx public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`
  (12/12); `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff
--check`; `pnpm --dir src/packages/static build:dev` with the existing local
  debug-log permission warning; and `/` browser QA desktop+mobile passed 34/34
  at `/tmp/cocalc-public-qa-lBYAll`. Screenshots inspected clean. Next:
  commit, rebuild post-commit so the static bundle embeds the new revision,
  rerun home browser QA, push, then update shared logs/status.

---

### Codex - round-2 copy batch D (2026-06-23 00:21 PDT)

- **START 2026-06-23 00:05 PDT:** Continuing the scheduled landing-page
  improvement loop on Round-2 item 25 Batch D content/copy in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Current
  head is `77b734e410`, matching `origin/blaec-synthesis-2026-06-18`; only the
  known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  present. Claimed files/routes: `about/team-data.ts`, `news/app.tsx`,
  `policies/app.tsx`, `pricing/page.tsx`, `features/automations-page.tsx`,
  `guides/app.tsx`, focused public/feature canaries, browser-QA route canaries,
  this ledger, and shared coordination logs if the slice completes. Scope:
  de-puff promoted team bio copy; render-or-delete dead public data fields;
  make `/news` list cards excerpts with a loading state; cap pricing lead and
  buying-path intro copy while removing the public fallback phrase "in this
  environment"; trim automations/guides self-referential meta copy. Guardrails:
  no home edits, no pricing money/compliance changes, no type/palette 2e, no
  pitch docs, no raw-audit foraging outside this batch, no
  LaTeX/dedicated-compute draft.
- **END 2026-06-23 00:21 PDT:** Round-2 item 25 Batch D source edit complete.
  William's top bio now uses the concrete role wording; Harald's promoted
  puffery and back-end overreach were replaced with front-end/UI, Linux ops,
  deployment infrastructure, and SageMath contributor language; unused
  `summary`, `role`, `personal`, `position`, and `positionTimeframe` profile
  fields were deleted. Policy evaluation cards now render their `label` text.
  `/news` list cards now render bounded text excerpts and a loading state while
  fetching. Pricing lead and buying-path intro copy are capped at 70ch, and the
  fallback no longer says "in this environment." Automations and guides
  self-referential meta copy was tightened, with the `/guides` browser-QA
  canary updated. Validation passed: focused Jest
  `public/__tests__/app.test.tsx public/features/__tests__/app.test.tsx public/__tests__/public-site-browser-qa-script.test.ts --runInBand --silent`
  (179/179); `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff
--check`; `pnpm --dir src/packages/static build:dev` with the existing local
  debug-log permission warning; and browser QA for `/guides`, `/about`,
  `/about/team/william-stein`, `/about/team/harald-schilly`, `/news`,
  `/policies`, `/pricing`, and `/features/automations` desktop+mobile passed
  246/246 at `/tmp/cocalc-public-qa-SmcuGp`. Screenshots inspected clean. Next:
  commit, rebuild post-commit so the static bundle embeds the new revision,
  rerun browser QA, push, then update shared logs/status.

---

### Codex - round-2 education-secondary batch C (2026-06-22 23:53 PDT)

- **START 2026-06-22 23:53 PDT:** Continuing the scheduled landing-page
  improvement loop on Round-2 item 24 Batch C framing/education-secondary in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Current
  head is `45229dbe76`, matching `origin/blaec-synthesis-2026-06-18`; only the
  known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  present. Claimed files/routes: promoted framing copy in `guides/app.tsx`,
  `about/team-data.ts`, `features/automations-page.tsx`,
  `support/new-view.tsx`, focused public/support/feature canaries as needed,
  this ledger, and shared coordination logs if the slice completes. Scope:
  de-elevate education in the named guide group heading/intro, about-bio
  audience triplet, automations closing bullet, and support request-type
  examples. Guardrails: no home edits, no pricing money/compliance copy, no
  type/palette 2e, no pitch docs, no raw-audit foraging outside this batch, no
  LaTeX/dedicated-compute draft.
- **END 2026-06-23 00:01 PDT:** Round-2 item 24 Batch C source edit complete.
  De-elevated the promoted education-forward copy: guides group is now
  "Operating paths" with teaching retained as a lower item in the group; Blaec
  bio triplets now lead with research/technical language and place academic
  institutions last; automations closing proof uses a team-workspace example
  instead of class/lab; support request-type examples say configuration instead
  of teaching. Added canaries for the old guide heading, support topic, and
  automations bullet, and updated the `/guides` browser-QA required text.
  Validation passed: focused Jest
  `public/__tests__/app.test.tsx public/__tests__/public-site-browser-qa-script.test.ts public/support/__tests__/new-view.test.tsx public/features/__tests__/app.test.tsx --runInBand --silent`
  (186/186); `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff
--check`; `pnpm --dir src/packages/static build:dev` with the existing local
  debug-log permission warning; and browser QA for `/guides`, `/about`,
  `/about/team/blaec-bejarano`, `/features/automations`, and `/support/new`
  desktop+mobile passed 174/174 at `/tmp/cocalc-public-qa-vI94YF`.
  Screenshots inspected clean. Next: commit, rebuild post-commit so the static
  bundle embeds the new revision, rerun browser QA, push, then update shared
  logs/status.

---

### Codex - round-2 token adherence batch B (2026-06-22 23:39 PDT)

- **START 2026-06-22 23:39 PDT:** Continuing the scheduled landing-page
  improvement loop on Round-2 item 23 Batch B token adherence in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Current
  head is `02c3dbda1f`, matching `origin/blaec-synthesis-2026-06-18`; only the
  known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  present. Claimed files/routes: promoted token substitutions in
  `guides/app.tsx`, `about/app.tsx`, `support/new-view.tsx`,
  `support/tickets-view.tsx`, `features/cli-page.tsx`, public theme/test files
  as needed, this ledger, and shared coordination logs if the slice completes.
  Scope: hardcoded radius to `PUBLIC_RADIUS`, promoted hardcoded support/CLI
  colors to existing public/util tokens, and promoted `fontWeight: 700` to
  `PUBLIC_WEIGHT.bold`. Guardrails: no home edits, no pricing money/compliance
  copy, no type/palette 2e beyond aliases backed by existing colors, no pitch
  docs, no raw-audit foraging outside this batch, no LaTeX/dedicated-compute
  draft.
- **END 2026-06-22 23:46 PDT:** Round-2 item 23 Batch B source edit complete.
  Promoted radius strays in guides/about now use `PUBLIC_RADIUS`; about/support
  font-weight strays now use `PUBLIC_WEIGHT.bold`; support status glyphs and
  ticket pills use public color/radius/weight tokens; CLI dark mock surface,
  header text, command text, and step label weight use existing `PUBLIC_DARK`
  and `PUBLIC_WEIGHT` tokens; CLI raw-hex guard allowlist was tightened. Added
  public success tint/border aliases backed by existing util colors, with no new
  palette values. Validation passed: focused Jest
  `public/__tests__/app.test.tsx public/support/tickets-view.test.tsx public/support/__tests__/new-view.test.tsx public/features/__tests__/app.test.tsx --runInBand --silent`
  (184/184); `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff
--check`; `pnpm --dir src/packages/static build:dev` with the existing local
  debug-log permission warning; and browser QA for `/guides`, `/about`,
  `/about/team/william-stein`, `/support/new`, `/support/tickets`, and
  `/features/cli` desktop+mobile passed 232/232 at
  `/tmp/cocalc-public-qa-pbV7Lh`. Screenshots inspected clean. Next: commit,
  rebuild post-commit so the static bundle embeds the new revision, rerun
  browser QA, push, then update shared logs/status.

---

### Codex - round-2 systemic a11y batch A (2026-06-22 23:18 PDT)

- **START 2026-06-22 23:18 PDT:** Continuing the scheduled landing-page
  improvement loop on Round-2 item 22 Batch A systemic a11y in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Current
  head is `26c5c2b7b6`, matching `origin/blaec-synthesis-2026-06-18`; preview
  hub pid `27431` remains rooted at `/home/user/cocalc-ai-synthesis/src`.
  Claimed files/routes: about/news/policies/pricing/support/feature a11y source
  and focused public/feature tests as needed, this ledger, and shared
  coordination logs if the slice completes. Scope: promoted Batch A only:
  heading-order fixes, decorative mock `role="img"`/hidden inner text, widget
  aria, policy TOC focus and GDPR iframe title, support status link semantics,
  pricing comparison cell aria, and news link/filter accessibility. Guardrails:
  no protected home edits, no pricing money/compliance copy, no bio fact
  changes, no type/palette 2e, no pitch/docs content, no raw-audit foraging
  outside this promoted batch, no LaTeX/dedicated-compute draft.
- **END 2026-06-22 23:32 PDT:** Round-2 item 22 Batch A source edit complete.
  Addressed only promoted systemic a11y items: news/about heading-order fixes;
  feature mock panels now expose one named `role="img"` while hiding inner mock
  UI from the accessibility tree; news filter has a label and news markdown
  links use existing public link tokens; policy TOC clicks move focus to the
  target section and the GDPR badge iframe has a title; support status
  pseudo-links now have hrefs; pricing comparison boolean/empty cells have
  screen-reader names and table header content no longer adds extra heading
  levels. Added focused coverage in public app and feature app tests. Validation
  passed: focused Jest
  `public/__tests__/app.test.tsx public/support/__tests__/new-view.test.tsx public/features/__tests__/app.test.tsx --runInBand --silent`
  (181/181); `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff
--check`; `pnpm --dir src/packages/static build:dev` with the existing local
  debug-log permission warning; and browser QA for `/news`,
  `/about/team/william-stein`, `/policies/privacy`, `/policies/trust`,
  `/pricing`, `/support/new`, `/features/ai`, `/features/automations`,
  `/features/python`, and `/features/latex-editor` desktop+mobile passed
  334/334 at `/tmp/cocalc-public-qa-yAC1eV`. Screenshots inspected clean. Home
  contrast item intentionally left untouched per current zero-home guardrail.
  Next: commit, rebuild post-commit so the static bundle embeds the new
  revision, rerun browser QA, push, then update shared logs/status.

---

### Codex - round-2 support form a11y (2026-06-22 23:11 PDT)

- **START 2026-06-22 23:11 PDT:** Scheduled landing-page improvement loop
  resumed in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX/status/log,
  public-site guardrails, synthesis AGENTS, website operating system, frozen
  Brief, public-site landing-page skill, active handoff ledger, multi-agent
  operating model, finite queue, and the newly promoted
  `round2-adversarial-sweep-fix-slice-2026-06-22.md`. Fetched
  `origin/blaec-synthesis-2026-06-18`; local head at start was `77b58d5d26`,
  matching origin, with only the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
  Verified preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build/browser-QA/
  Playwright process was observed. Top queued item is Round-2 item 21:
  `/support` form controls need programmatic labels. Claimed files/routes:
  `/support/new`,
  `src/packages/frontend/public/support/new-view.tsx`,
  `src/packages/frontend/public/support/__tests__/new-view.test.tsx`, this
  ledger, `/home/user/cocalc-shared/codex-turn-log.md`, and
  `/home/user/cocalc-shared/claude-current-status.md`. Guardrails: do not touch
  protected home, pricing/compliance, type/palette 2e, pitch docs, raw audits,
  LaTeX/dedicated-compute, or the untracked dedicated-compute draft.
- **END 2026-06-22 23:16 PDT:** Round-2 item 21 source edit complete. The
  Zendesk-backed `/support/new` form now gives the email and subject inputs
  programmatic names, labels the support-type radio group, labels each
  problem/task textarea with visible `label`/`htmlFor`, gives the single
  question/purchase/chat detail textareas explicit `aria-label`s, and hides the
  decorative completion glyph from accessible names. Regression coverage now
  queries the form controls by label across every support-request body variant.
  Validation passed: Prettier on touched source/test files; focused support
  Jest `public/support/__tests__/app.test.tsx
public/support/__tests__/new-view.test.tsx
public/support/tickets-view.test.tsx --runInBand` (17/17, existing
  React/AntD `act(...)` warnings); `pnpm -C src tsc`; `pnpm -C src
lint:frontend`; `git diff --check`; `pnpm --dir src/packages/static
build:dev` with the existing local debug-log permission warning; and
  `/support/new` browser QA desktop+mobile 30/30 at
  `/tmp/cocalc-public-qa-SRNMV1`. Screenshots inspected clean. Preview shows
  the email fallback in this local environment; the Zendesk form path is
  covered by jsdom tests. Next: commit, rebuild post-commit so the static
  bundle embeds the new revision, rerun `/support/new` browser QA, then update
  the shared logs.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 23:06 PDT)

- **START 2026-06-22 23:06 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site landing-page skill, active
  handoff ledger, multi-agent operating model, finite queue, current workplan,
  adversarial-fix slice, post-batch QA sweep, and consolidated-fix slice.
  Fetched `origin/blaec-synthesis-2026-06-18`; current local head at start was
  `45ebb753d3`, matching `origin/blaec-synthesis-2026-06-18`. Verified
  preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build, browser-QA, or
  Playwright process was observed. Latest public-site source-change commit
  remains `2f14ef38b1` (`frontend/public: drain feature page P3 polish`).
  Targeted queue check found no new promoted source item: adversarial-fix
  items 16-20 remain source-drained pending Claude/Blaec audit, the active
  prompt still says not to forage raw audit findings, and the open FS-004/FS-005
  workplan entries are process/watch items rather than released source work.
  Claimed files: this ledger, `/home/user/cocalc-shared/codex-turn-log.md`,
  and `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 23:06 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/tests/browser QA were run because no route was
  touched. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits, process-only workplan entries, or
  held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 23:01 PDT)

- **START 2026-06-22 23:01 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site landing-page skill, active
  handoff ledger, multi-agent operating model, finite queue, current workplan,
  adversarial-fix slice, post-batch QA sweep, and consolidated-fix slice.
  Fetched `origin/blaec-synthesis-2026-06-18`; current local head at start was
  `0fe87a4e1a`, matching `origin/blaec-synthesis-2026-06-18`. Verified
  preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build, browser-QA, or
  Playwright process was observed. Latest public-site source-change commit
  remains `2f14ef38b1` (`frontend/public: drain feature page P3 polish`).
  Targeted queue check found no new promoted source item: adversarial-fix
  items 16-20 remain source-drained pending Claude/Blaec audit, the active
  prompt still says not to forage raw audit findings, and the open FS-004/FS-005
  workplan entries are process/watch items rather than released source work.
  Claimed files: this ledger, `/home/user/cocalc-shared/codex-turn-log.md`,
  and `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 23:01 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/tests/browser QA were run because no route was
  touched. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits, process-only workplan entries, or
  held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 22:57 PDT)

- **START 2026-06-22 22:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site landing-page skill, active
  handoff ledger, multi-agent operating model, finite queue, current workplan,
  adversarial-fix slice, post-batch QA sweep, and consolidated-fix slice.
  Verified preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build, browser-QA, or
  Playwright process was observed. Fetched
  `origin/blaec-synthesis-2026-06-18`; current local head at start was
  `01acae1ccb`, matching `origin/blaec-synthesis-2026-06-18`. Latest
  public-site source-change commit remains `2f14ef38b1`
  (`frontend/public: drain feature page P3 polish`). Targeted queue check found
  no new promoted source item: adversarial-fix items 16-20 remain
  source-drained pending Claude/Blaec audit, the active prompt still says not
  to forage raw audit findings, and protected home, pricing/compliance,
  type/palette, pitch/docs, LaTeX, and dedicated-compute lanes remain held.
  Claimed files: this ledger, `/home/user/cocalc-shared/codex-turn-log.md`,
  and `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 22:57 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/browser QA was run because no route was touched.
  The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits or held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 22:51 PDT)

- **START 2026-06-22 22:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site landing-page skill, active
  handoff ledger, multi-agent operating model, current workplan, and finite
  queue docs. Verified preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build, browser-QA, or
  Playwright process was observed. Current local head at start was
  `a413c69fa1`, matching `origin/blaec-synthesis-2026-06-18`; latest
  public-site source-change commit remains `2f14ef38b1`
  (`frontend/public: drain feature page P3 polish`). Targeted queue check found
  no new promoted source item: adversarial-fix items 16-20 remain
  source-drained pending Claude/Blaec audit, the active prompt still says not
  to forage raw audit findings, and protected home, pricing/compliance,
  type/palette, pitch/docs, LaTeX, and dedicated-compute lanes remain held.
  Claimed files: this ledger, `/home/user/cocalc-shared/codex-turn-log.md`, and
  `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 22:51 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/browser QA was run because no route was touched.
  The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits or held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 22:46 PDT)

- **START 2026-06-22 22:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site landing-page skill, active
  handoff ledger, current workplan, adversarial-fix slice, and post-batch QA
  sweep. Verified preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build, browser-QA, or
  Playwright process was observed. Current local head at start was
  `90b6d34ad1`, matching `origin/blaec-synthesis-2026-06-18`; latest
  public-site source-change commit remains `2f14ef38b1`
  (`frontend/public: drain feature page P3 polish`). Targeted queue check found
  no new promoted source item: Claude's current status and Codex turn log still
  say adversarial-fix items 16-20 are source-drained pending Claude/Blaec audit,
  the current prompt says not to forage raw audit findings, and protected home,
  pricing/compliance, type/palette, pitch/docs, LaTeX, and dedicated-compute
  lanes remain held. Claimed files: this ledger,
  `/home/user/cocalc-shared/codex-turn-log.md`, and
  `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 22:46 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/browser QA was run because no route was touched.
  The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits or held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 22:41 PDT)

- **START 2026-06-22 22:41 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, the public-site guardrails, website operating system,
  frozen Brief, active handoff ledger, and current workplan state. Verified
  preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build, browser-QA, or
  Playwright process was observed. Current local head at start was
  `588cf6105c`, matching `origin/blaec-synthesis-2026-06-18`; latest
  public-site source-change commit remains `2f14ef38b1`
  (`frontend/public: drain feature page P3 polish`). Targeted queue check found
  no new promoted source item: Claude's current status and Codex turn log still
  say adversarial-fix items 16-20 are source-drained pending Claude/Blaec audit,
  the current prompt says not to forage raw audit findings, and protected
  home, pricing/compliance, type/palette, pitch/docs, LaTeX, and
  dedicated-compute lanes remain held. Claimed files: this ledger,
  `/home/user/cocalc-shared/codex-turn-log.md`, and
  `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 22:41 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/browser QA was run because no route was touched.
  The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits or held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 22:36 PDT)

- **START 2026-06-22 22:36 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, active workplan inputs, the consolidated
  adversarial-fix slice, the post-batch QA sweep, and this handoff ledger.
  Verified preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build/browser-QA
  process was observed. Current local head at start was `720181d699`, matching
  `origin/blaec-synthesis-2026-06-18`; latest public-site source-change commit
  remains `2f14ef38b1` (`frontend/public: drain feature page P3 polish`).
  Targeted queue check found no new promoted source item: Claude's current
  status and Codex turn log still say adversarial-fix items 16-20 are
  source-drained pending Claude/Blaec audit, the current prompt says not to
  forage raw audit findings, and protected home, pricing/compliance,
  type/palette, pitch/docs, LaTeX, and dedicated-compute lanes remain held.
  Claimed files: this ledger, `/home/user/cocalc-shared/codex-turn-log.md`,
  and `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 22:36 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/browser QA was run because no route was touched.
  The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits or held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 22:31 PDT)

- **START 2026-06-22 22:31 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site landing-page skill, multi-agent
  operating model, framing/design docs, finite issue tracker, active workplan,
  and this handoff ledger. Verified preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build/browser-QA
  process was observed. Current local head at start was `afa1d1cf73`, one
  coordination commit ahead of `origin/blaec-synthesis-2026-06-18`; latest
  public-site source-change commit remains `2f14ef38b1`
  (`frontend/public: drain feature page P3 polish`). Targeted queue check
  found no new released source item: Claude's current status and Codex turn log
  still say adversarial-fix items 16-20 are source-drained pending
  Claude/Blaec audit, the current prompt says not to forage raw audit findings,
  and LaTeX/dedicated-compute remain held. Claimed files: this ledger,
  `/home/user/cocalc-shared/codex-turn-log.md`, and
  `/home/user/cocalc-shared/claude-current-status.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette 2e, pitch docs, docs-route
  content, product/feature/support source edits, raw-audit foraging,
  LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 22:31 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/browser QA was run because no route was touched.
  The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits or held lanes.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 22:27 PDT)

- **START 2026-06-22 22:27 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, post-framing queue, adversarial-fix slice,
  and this handoff ledger. The public-site skill path referenced by the docs is
  absent in this checkout, so this run followed the available operating docs
  and shared guardrails. Verified preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build/browser-QA
  process was observed. Targeted queue check found no new released item:
  Claude's current status and Codex turn log still say adversarial-fix items
  16-20 are source-drained pending Claude/Blaec audit, the current prompt says
  not to forage raw audit findings, and LaTeX/dedicated-compute remain held.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance, type/palette 2e,
  pitch docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, LaTeX/dedicated-compute, or the untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 22:27 PDT:** QUEUE DRAINED. No public-site source files
  were changed, and no build/browser QA was run because no route was touched.
  Current head before this coordination update was `0a9709297f`; latest
  public-site source-change commit remains `2f14ef38b1`
  (`frontend/public: drain feature page P3 polish`). The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude/Blaec audit or a newly promoted curated
  slice; do not self-select from raw audits or held lanes.

---

### Codex - P3 feature-page polish batch (2026-06-22 22:06 PDT)

- **START 2026-06-22 22:06 PDT:** Continuing the scheduled landing-page
  improvement loop with adversarial-fix item 20 P3 polish. Worktree verified as
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`; preview
  hub pid `27431` is rooted at `/home/user/cocalc-ai-synthesis/src`. Current
  head `e8cac84914`; known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft
  remains untouched. Claimed routes/files: `/features/julia`,
  `/features/octave`, `/features/more-languages`, `/features/cli`,
  `/features/whiteboard`, `/features/slides`,
  `src/packages/frontend/public/features/julia-page.tsx`,
  `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/more-languages-page.tsx`,
  `src/packages/frontend/public/features/cli-page.tsx`,
  `src/packages/frontend/public/features/whiteboard-page.tsx`,
  `src/packages/frontend/public/features/slides-page.tsx`,
  `src/packages/frontend/public/features/feature-accents.ts`,
  focused feature/browser-QA guards if needed,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, this ledger, and
  shared coordination logs if the slice completes. Scope: item 20 only —
  delete Julia hero's extra paragraph, align Octave hero cards/accent/a11y,
  simplify More Languages hero/taxonomy visual, tighten CLI repetition and
  jargon, and remove the whiteboard/slides copy nits. Do not touch protected
  home, pricing/compliance, pitch/docs content, type/palette 2e, raw audit
  findings outside this promoted item, LaTeX/dedicated-compute, or the
  dedicated-compute draft.
- **END 2026-06-22 22:13 PDT:** Item 20 P3 source edit complete. Julia hero
  now uses title + one lead paragraph; Octave hero cards use `IconBadge`, the
  page uses `FEATURE_ACCENTS.octave`, the hero mock has `role="img"`, and the
  route-owned heading-size override is gone per the newer P3 spec; More
  Languages now leads with "Run more languages in one shared project," drops
  the inner-card nested shadow, and avoids repeating the language taxonomy;
  CLI copy reduces the inspect/run/return repetition, uses "documented
  command" once on the detail page, and replaces "Run bounded actions" with
  "Run notebook and browser checks"; Whiteboard and Slides copy nits were
  trimmed. Updated focused feature/browser-QA canaries and the workplan entry.
  Validation passed: Prettier on touched files; focused Jest
  `pnpm exec jest public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand` from
  `src/packages/frontend` (140/140, existing React/AntD `act(...)` warnings);
  `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff --check`; static
  `build:dev` with the existing local debug-log permission warning; and browser
  QA for `/features/julia`, `/features/octave`, `/features/more-languages`,
  `/features/cli`, `/features/whiteboard`, and `/features/slides`
  desktop+mobile passed 278/278 at `/tmp/cocalc-public-qa-ykW3rg`.
  Desktop/mobile screenshots for all six routes were inspected; no overlap or
  obvious layout regression. Next: commit, rebuild so the static bundle embeds
  the new commit, rerun focused browser QA, then push/update shared logs.
- **POST-COMMIT 2026-06-22 22:16 PDT:** Source/workplan commit
  `2f14ef38b1` (`frontend/public: drain feature page P3 polish`) created.
  Post-commit `pnpm --dir src/packages/static build:dev` passed and embedded
  `COCALC_GIT_REVISION =
2f14ef38b1ca8034c8ec27ab53b107da9e3d3a30`. Post-commit browser QA for
  `/features/julia`, `/features/octave`, `/features/more-languages`,
  `/features/cli`, `/features/whiteboard`, and `/features/slides`
  desktop+mobile passed 278/278 at `/tmp/cocalc-public-qa-r0qqd3`. Next: push
  branch and update shared status logs.

### Codex - FeatureFinalBand balance v2 (2026-06-22 21:53 PDT)

- **START 2026-06-22 21:53 PDT:** Continuing the scheduled landing-page
  improvement loop with the remaining adversarial-fix item 19 candidate:
  band-balance v2. Worktree verified as `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`; preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`. Current head `0f084b1903` is pushed to
  origin; known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft
  remains untouched. Claimed files: shared `FeatureFinalBand` in
  `src/packages/frontend/public/features/feature-visuals.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and this ledger.
  Scope: stretch/pad the final-band CTA panel so short right cards fill beside
  taller "When X belongs" proof columns. Do not touch route copy, protected
  home, pricing/compliance, pitch/docs content, palette/type-lane expansion,
  raw audit findings outside this promoted item, or the dedicated-compute
  draft.
- **END 2026-06-22 21:58 PDT:** Band-balance v2 source edit complete. Shared
  `FeatureFinalBand` now uses stretch row alignment; both content columns render
  as flex columns, and the right `.cocalc-feature-final-panel` fills the column
  height/width with centered CTA content. The final-band guard now asserts
  `.ant-row-stretch`, rejects `.ant-row-middle`/`.ant-row-top`, and checks the
  final panel's full-height/full-width style. Validation passed: Prettier on
  touched source/test files; focused Jest
  `pnpm exec jest public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand` from
  `src/packages/frontend` (140/140, existing React/AntD `act(...)` warnings);
  `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff --check`; static
  `build:dev` with the existing local debug-log permission warning; and full
  feature-details browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --group
feature-details --viewport desktop --viewport mobile` passed 758/758 at
  `/tmp/cocalc-public-qa-AcFDHr`. Representative desktop/mobile screenshots
  inspected for Julia, Sage, AI, and Teaching; no overlap or obvious layout
  regression. Next: commit, rebuild so the static bundle embeds the new commit,
  rerun representative browser QA, then push/update shared logs.
- **POST-COMMIT 2026-06-22 22:00 PDT:** Source/workplan commit
  `cf70336534` (`frontend/public: stretch feature final CTA panels`) created.
  Post-commit `pnpm --dir src/packages/static build:dev` passed and embedded
  `COCALC_GIT_REVISION =
cf70336534a0f1c78fc3c89bec60724ffce915ca`. Post-commit full feature-details
  browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --group
feature-details --viewport desktop --viewport mobile` passed 758/758 at
  `/tmp/cocalc-public-qa-XmIXK2`. Representative desktop/mobile screenshots
  inspected for Julia, Sage, AI, and Teaching; no overlap or obvious layout
  regression. Next: push branch and update shared status logs.

### Codex - AI final-band residual polish (2026-06-22 21:42 PDT)

- **START 2026-06-22 21:42 PDT:** Continuing the scheduled landing-page
  improvement loop with adversarial-fix item 19's accepted AI residual:
  reframe the `/features/ai` closing section around project continuity, move it
  onto shared `FeatureFinalBand`, and collapse the local AI icon hues onto an
  existing `FEATURE_ACCENTS.ai` entry. Worktree verified as
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`; preview
  hub pid `27431` is rooted at `/home/user/cocalc-ai-synthesis/src`. Current
  head `0b00b9ce68`; known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft
  remains untouched. Claimed route/files: `/features/ai`,
  `src/packages/frontend/public/features/ai-page.tsx`,
  `src/packages/frontend/public/features/feature-accents.ts`,
  `src/packages/frontend/public/features/app.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and this ledger.
  Scope: AI closing-band structure/copy, existing-token accent cleanup, and
  focused guards. Do not touch protected home, pricing/compliance, pitch/docs
  content, raw audit findings outside this promoted item, palette/type-lane
  expansion, or the dedicated-compute draft.
- **END 2026-06-22 21:47 PDT:** AI residual sub-slice complete. `/features/ai`
  now uses shared `FeatureFinalBand` for its close, with the sibling-consistent
  heading "When AI work belongs in CoCalc"; the old "Choose the AI path that
  fits" tool-menu close is guarded against returning. Registered
  `FEATURE_ACCENTS.ai`, routed the feature catalog and AI page through it, and
  removed the four route-local AI icon hues from the page source/allowlist.
  Workflow card titles are now level-4 headings under the workflow panel, with
  the audited-page heading guard narrowed to that explicit AI exception.
  Validation passed: Prettier on touched source/test files; focused Jest
  `pnpm exec jest public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand` from
  `src/packages/frontend` (140/140, existing React/AntD `act(...)` warnings);
  `pnpm -C src tsc`; `pnpm -C src lint:frontend`; `git diff --check`; static
  `build:dev` with the existing local debug-log permission warning; and browser
  QA `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/ai --viewport desktop --viewport mobile` passed 48/48 at
  `/tmp/cocalc-public-qa-JiEgn4`. Desktop/mobile screenshots inspected; no
  overlap or obvious layout regression. Next: commit, rebuild so the static
  bundle embeds the new commit, rerun AI browser QA, then push/update handoff
  logs.
- **POST-COMMIT 2026-06-22 21:51 PDT:** Source/workplan commit
  `94f47b7599` (`frontend/public: move AI close to final band`) created.
  Post-commit `pnpm --dir src/packages/static build:dev` passed and embedded
  `COCALC_GIT_REVISION =
94f47b7599fe9d7b11ebefad38a7639a23e17109`. Post-commit browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/ai --viewport desktop --viewport mobile` passed 48/48 at
  `/tmp/cocalc-public-qa-Bvhtf1`. Desktop/mobile screenshots inspected; no
  overlap or obvious layout regression. Next: push branch and update shared
  status logs.

### Codex - teaching final-band polish (2026-06-22 21:22 PDT)

- **START 2026-06-22 21:22 PDT:** Continuing the scheduled landing-page
  improvement loop with promoted adversarial-fix queue item 10: migrate
  `/features/teaching` from its route-owned final plan to the shared
  `FeatureFinalBand`, standardize unauth/auth CTA labels, and register the
  teaching accent instead of local `COLORS.RUN`/AI-dot usage. Worktree verified
  as `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`; preview
  hub pid `27431` is rooted at `/home/user/cocalc-ai-synthesis/src`. Current
  head `75d4437879`; known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft
  remains untouched. Claimed route/files: `/features/teaching`,
  `src/packages/frontend/public/features/teaching-page.tsx`,
  `src/packages/frontend/public/features/app.tsx`,
  `src/packages/frontend/public/features/feature-accents.ts`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and this ledger.
  Scope: closing-section design consistency and accent cleanup only. Do not
  touch protected home, pricing/compliance, pitch/docs content, raw audit
  findings outside this promoted item, or the dedicated-compute draft.
- **END 2026-06-22 21:31 PDT:** Teaching final-band slice complete. Replaced
  the route-owned `.cocalc-teaching-final-plan` closing section with shared
  `FeatureFinalBand`, standardized unauth labels to `Create account` in the
  hero and `Start a course in CoCalc` in the final action, preserved
  authenticated `Open projects`, moved the teaching accent into
  `FEATURE_ACCENTS`, and removed the unrelated AI-colored student status dot.
  Updated Jest/browser-QA guards so teaching is now in the audited final-band
  set and the old final-plan/CTA wording does not return. Validation passed:
  Prettier on touched files; `pnpm -C src tsc`; focused Jest
  `pnpm exec jest public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand` from
  `src/packages/frontend` (136/136, existing React/AntD `act(...)` warnings);
  `pnpm -C src lint:frontend`; `git diff --check`; `pnpm --dir
src/packages/static build:dev` with the existing local debug-log permission
  warning; and browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/teaching --viewport desktop --viewport mobile` passed 56/56 at
  `/tmp/cocalc-public-qa-lrBwx6`. Desktop/mobile screenshots inspected; no
  overlap or obvious visual regression. Next: commit, rebuild so the static
  bundle embeds the new commit, rerun teaching browser QA, then push/update
  handoff logs.
- **POST-COMMIT 2026-06-22 21:33 PDT:** Source/ledger commit
  `a34ea86b8d` (`frontend/public: move teaching close to final band`) created.
  Post-commit `pnpm --dir src/packages/static build:dev` passed and embedded
  `COCALC_GIT_REVISION =
a34ea86b8dd88f909d81d6df34f738290539f9b4`. Post-commit browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/teaching --viewport desktop --viewport mobile` passed 56/56 at
  `/tmp/cocalc-public-qa-6BkXPW`. Desktop/mobile screenshots inspected; no
  overlap or obvious layout regression. Next: push branch and update shared
  status logs.

### Codex - Python workflow-panel P2 redundancy polish (2026-06-22 20:52 PDT)

- **START 2026-06-22 20:52 PDT:** Continuing the scheduled landing-page
  improvement loop with adversarial-fix queue item 19, next bounded P2 design
  sub-slice: `/features/python` redundant `WorkflowNode` panel removal.
  Current branch head `892530f408` is synced with origin except for the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft, which remains untouched. Preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed route/files:
  `/features/python`,
  `src/packages/frontend/public/features/python-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, this ledger, and
  shared coordination logs if the slice completes. Scope: remove the repeated
  notebook-to-script-to-paper workflow card row while preserving the text,
  shared `ContextList`, Python proof, final band, and CTA destinations. Do not
  touch protected home, pricing/compliance, type/palette, pitch/docs content,
  raw audit findings, or the dedicated-compute draft.
- **END 2026-06-22 20:55 PDT:** Python redundancy sub-slice complete. Removed
  the local `WorkflowNode`/three-card workflow panel and its extra gradient
  shell, leaving the section text plus the shared `ContextList` as the single
  workflow proof. Added Jest and browser-QA guards so the removed panel copy
  does not return. Validation: Prettier on touched files, `pnpm -C src tsc`,
  focused Jest `pnpm exec jest public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand` (134/134,
  existing React/AntD `act(...)` warnings), `pnpm -C src lint:frontend`,
  `git diff --check`, `pnpm --dir src/packages/static build:dev`, and browser
  QA `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/python --viewport desktop --viewport mobile` (44/44) passed.
  Desktop/mobile screenshots inspected at `/tmp/cocalc-public-qa-osUiUD`; no
  overlap or obvious visual regression. Next: commit, rebuild so the static
  bundle embeds the new commit, rerun Python browser QA, then push.
- **POST-COMMIT 2026-06-22 20:58 PDT:** Source/ledger commit
  `1809d5ef78` (`frontend/public: remove redundant Python workflow panel`)
  created. Post-commit `pnpm --dir src/packages/static build:dev` passed and
  embedded `COCALC_GIT_REVISION =
1809d5ef78cf0870b1f14a7c9db912e8107523fc`. Post-commit browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/python --viewport desktop --viewport mobile` passed 44/44 at
  `/tmp/cocalc-public-qa-RaJ2qz`. Desktop/mobile screenshots inspected; no
  overlap or obvious layout regression. Next: push branch and update shared
  status logs.

### Codex - Sage hero P2 redundancy polish (2026-06-22 20:46 PDT)

- **START 2026-06-22 20:46 PDT:** Continuing the scheduled landing-page
  improvement loop with adversarial-fix queue item 19, next bounded P2 design
  sub-slice: `/features/sage` redundant hero `TerminalMock` removal. Current
  branch head `a31dc2f0ec` has been pushed after the AI polish handoff; known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  remains untouched. Claimed route/files: `/features/sage`,
  `src/packages/frontend/public/features/sage-page.tsx`, focused tests/QA
  canaries if needed, and this ledger. Scope: simplify the Sage hero by removing
  the redundant terminal mock while preserving Sage proof, the heritage/open-
  source positioning from item 17, education-secondary framing, and existing
  public tokens/shared primitives. Do not touch protected home, pricing/
  compliance, type/palette, pitch/docs content, raw audit findings, or the
  dedicated-compute draft.
- **END 2026-06-22 20:51 PDT:** Sage hero redundancy sub-slice complete.
  Removed the dark hand-built Sage prompt block from the hero and dropped its
  `PUBLIC_DARK` import, leaving the four light hero proof cards as the primary
  visual. Added canaries so `sage: factor` / `sage: plot` prompt text does not
  return. Validation: Prettier on touched files, `pnpm -C src tsc`, focused Jest
  `pnpm exec jest public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand` (134/134,
  existing React/AntD `act(...)` warnings), `pnpm -C src lint:frontend`,
  `git diff --check`, `pnpm --dir src/packages/static build:dev`, and browser
  QA `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/sage --viewport desktop --viewport mobile` (44/44) passed.
  Desktop/mobile screenshots inspected at `/tmp/cocalc-public-qa-mFXigR`; no
  overlap or obvious visual regression. Next: commit, rebuild so the static
  bundle embeds the Sage commit, rerun Sage browser QA, then push.
- **POST-COMMIT 2026-06-22 20:52 PDT:** Source/ledger commit
  `4457a9dfcb` (`frontend/public: remove redundant Sage hero terminal`)
  created. Post-commit `pnpm --dir src/packages/static build:dev` passed and
  embedded `COCALC_GIT_REVISION =
4457a9dfcb153658de45c7b6332dfa568fc51ee2`. Post-commit browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/sage --viewport desktop --viewport mobile` passed 44/44 at
  `/tmp/cocalc-public-qa-f7V3Fh`. Next: push branch and update shared status
  logs.

### Codex - AI feature P2 design polish (2026-06-22 20:29 PDT)

- **START 2026-06-22 20:29 PDT:** Continuing the scheduled landing-page
  improvement loop with promoted adversarial-fix queue item 19, first bounded
  page group: `/features/ai` polish from
  `/home/user/cocalc-shared/feature-page-adversarial-fix-slice-2026-06-22.md`.
  Source commit `637edab853` (language education-secondary cleanup) has been
  pushed, and post-commit browser QA passed 126/126 at
  `/tmp/cocalc-public-qa-PPcZr3`. Worktree verified as
  `/home/user/cocalc-ai-synthesis/src` on `blaec-synthesis-2026-06-18`;
  preview hub pid `27431` is rooted at `/home/user/cocalc-ai-synthesis/src`.
  Claimed route/files: `/features/ai`,
  `src/packages/frontend/public/features/ai-page.tsx`, focused tests/QA
  canaries if needed, and this ledger. Scope: fix the AI page's warm
  hand-built hero panel, sparse final CTA column, and ragged review/context
  balance using existing tokens and shared primitives only. Do not touch
  protected home, pricing/compliance, type/palette, pitch/docs content, raw
  audit findings beyond the promoted item, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 20:39 PDT:** `/features/ai` source edit complete and
  pre-commit validation passed. Replaced the warm hero thread shell with a
  light tokenized surface, moved the review context list into the shared
  `ContextList` primitive inside a balanced panel, and upgraded the final CTA
  column to a framed final-panel treatment without changing the Codex-guide
  first CTA order. Guardrail fixes kept the route at its inline-style budget
  and avoided leaking `cocalc-ai-*` selectors into rendered style text.
  Validation: `pnpm -C src prettier --write
packages/frontend/public/features/ai-page.tsx` (unchanged after final pass),
  `pnpm -C src tsc`, focused Jest
  `pnpm exec jest public/features/__tests__/app.test.tsx
public/__tests__/public-site-browser-qa-script.test.ts --runInBand` (134/134,
  existing React/AntD `act(...)` warnings), `pnpm -C src lint:frontend`,
  `pnpm --dir src/packages/static build:dev`, and browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/ai --viewport desktop --viewport mobile` (46/46) passed. Screenshot
  artifact inspected at `/tmp/cocalc-public-qa-Mn0ri5`. Next: commit, rebuild so
  the static bundle embeds the new commit, rerun AI browser QA, then push.
- **POST-COMMIT 2026-06-22 20:41 PDT:** Source/ledger commit
  `f12451b753` (`frontend/public: polish AI feature page layout`) created.
  Post-commit `pnpm --dir src/packages/static build:dev` passed and embedded
  `COCALC_GIT_REVISION = f12451b753961ecec14df99e00641bb034ce47ef`.
  Post-commit browser QA
  `node packages/frontend/scripts/public-site-browser-qa.mjs --route
/features/ai --viewport desktop --viewport mobile` passed 46/46 at
  `/tmp/cocalc-public-qa-iMKcfO`. Desktop/mobile screenshots inspected; no
  overlap or obvious layout regression. Next: push branch and update shared
  status logs.

### Codex - language education-secondary cleanup (2026-06-22 20:24 PDT)

- **START 2026-06-22 20:24 PDT:** Continuing the scheduled landing-page
  improvement loop with promoted adversarial-fix queue item 18 from
  `/home/user/cocalc-shared/feature-page-adversarial-fix-slice-2026-06-22.md`.
  Source commit `8cba363dcb` (Sage P0 cleanup) has been pushed, and
  post-commit Sage browser QA passed 40/40 at `/tmp/cocalc-public-qa-U6XWcf`.
  Worktree verified as `/home/user/cocalc-ai-synthesis/src` on
  `blaec-synthesis-2026-06-18`; preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed routes/files:
  `/features/octave`, `/features/julia`, `/features/r-statistical-software`,
  their three feature page files, focused tests/QA canaries if needed, and
  this ledger. Scope: keep education secondary by dropping the Octave hero
  teaching-context stamp, leading Julia's closing bullet with collaborators
  before students, and replacing R's teaching context-list slot with
  history/TimeTravel. Do not touch protected home, pricing/compliance,
  type/palette, pitch/docs content, raw audit findings beyond the promoted
  item, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 20:27 PDT:** Item 18 implemented as scoped. Octave's hero
  mock now says the project keeps TimeTravel history instead of "teaching
  context"; Julia's final-band bullet now leads with collaborators before
  students; R's context list now uses TimeTravel history instead of a teaching
  slot. Added browser-QA guards for the new language and old-phrase bans.
  Validation passed: `pnpm -C src tsc`; focused feature/browser-QA-script Jest
  134/134 with existing Ant Design React `act(...)` warnings; `pnpm -C src
lint:frontend`; `pnpm --dir src/packages/static build:dev`; and browser QA
  for `/features/octave`, `/features/julia`, and
  `/features/r-statistical-software` desktop+mobile 126/126 with screenshots
  in `/tmp/cocalc-public-qa-g0bUjW`. Screenshots inspected clean. Protected
  home, pricing/compliance, type/palette, pitch/docs content, unpromoted raw
  audit findings, and the known untracked `dedicated-compute-page.tsx` draft
  were left untouched. Next curated queue item is adversarial-fix item 19:
  P2 design fixes, starting with AI polish.

### Codex - Sage P0 factual + education-weight cleanup (2026-06-22 20:17 PDT)

- **START 2026-06-22 20:17 PDT:** Continuing the scheduled landing-page
  improvement loop with promoted adversarial-fix queue item 17 from
  `/home/user/cocalc-shared/feature-page-adversarial-fix-slice-2026-06-22.md`.
  Worktree verified as `/home/user/cocalc-ai-synthesis/src` on
  `blaec-synthesis-2026-06-18`; preview hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed route/files:
  `/features/sage`,
  `src/packages/frontend/public/features/sage-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, the browser-QA
  script test, and this ledger. Scope: fix the SageMath factual wording and
  collapse the equal-weight teaching section so education remains secondary.
  Do not touch protected home, pricing/compliance, type/palette, pitch/docs
  content, raw audit findings beyond the promoted item, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 20:22 PDT:** Sage P0 cleanup implemented as scoped. Removed
  the standalone equal-weight course section, removed the hero Teaching CTA and
  student stamp, and kept teaching as a single final-band use-case bullet with
  the corrected phrase "free, open-source mathematics software"; the stale
  "open-source Python library" wording is now test- and browser-QA-forbidden.
  Validation passed: `pnpm -C src tsc`; focused feature/browser-QA-script Jest
  134/134 with existing Ant Design React `act(...)` warnings; `pnpm -C src
lint:frontend`; `pnpm --dir src/packages/static build:dev`; and browser QA
  for `/features/sage` desktop+mobile 40/40 with screenshots in
  `/tmp/cocalc-public-qa-bR36pd`. Screenshots inspected clean. Protected home,
  pricing/compliance, type/palette, pitch/docs content, unpromoted raw audit
  findings, and the known untracked `dedicated-compute-page.tsx` draft were
  left untouched. Next curated queue item is adversarial-fix item 18:
  education-secondary cleanup for Octave, Julia, and R.

### Codex - whiteboard TypeScript bug fast-track (2026-06-22 20:11 PDT)

- **START 2026-06-22 20:11 PDT:** Scheduled landing-page improvement loop
  picked up the promoted adversarial-fix queue item 16 from
  `/home/user/cocalc-shared/feature-page-adversarial-fix-slice-2026-06-22.md`.
  Worktree verified as `/home/user/cocalc-ai-synthesis/src` on
  `blaec-synthesis-2026-06-18` at `c93d635e82`; preview hub pid `27431` is
  rooted at `/home/user/cocalc-ai-synthesis/src`. Claimed route/file:
  `/features/whiteboard` and
  `src/packages/frontend/public/features/whiteboard-page.tsx`, plus this
  ledger and shared coordination logs. Scope is one correctness fix only:
  remove the unused/non-typed `highlight` destructure from `GraphNode` and
  verify with `pnpm -C src tsc`. Do not touch protected home,
  pricing/compliance, type/palette, pitch/docs content, raw audit findings, or
  the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 20:15 PDT:** Whiteboard TypeScript bug fixed as scoped:
  `GraphNode` no longer destructures the missing/unused `highlight` prop.
  Validation passed: `pnpm -C src tsc`; focused public feature Jest
  129/129 with existing Ant Design React `act(...)` warnings; frontend lint
  (`pnpm -C src lint:frontend`); `pnpm --dir src/packages/static build:dev`;
  and browser QA for `/features/whiteboard` desktop+mobile 42/42 with screenshots in
  `/tmp/cocalc-public-qa-8hYZz8`. Screenshots inspected clean; no visible page
  change intended. Protected home, pricing/compliance, type/palette,
  pitch/docs content, raw audit findings, and the known untracked
  `dedicated-compute-page.tsx` draft were left untouched. Next curated queue
  item is adversarial-fix item 17: Sage factual wording plus education-weight
  cleanup.
- **POST-PUSH 2026-06-22 20:16 PDT:** Source commit `1fc690df2f`
  (`frontend/public: fix whiteboard graph node props`) was pushed to
  `origin/blaec-synthesis-2026-06-18`. After that commit, rebuilt the static
  preview bundle; it embeds git revision `1fc690df2f50a02f1580c933c4237aaa1ad56da8`.
  Final post-commit browser QA for `/features/whiteboard` desktop+mobile
  passed 42/42 with artifacts in `/tmp/cocalc-public-qa-l0ebHH`. Preview hub
  pid `27431` remains rooted at `/home/user/cocalc-ai-synthesis/src`. This
  follow-up is coordination-only; no rendered route source changed after the
  rebuilt preview.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 18:06 PDT)

- **START 2026-06-22 18:06 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, landing-page issues tracker, the current feature-page consistency and
  design-polish slice docs, and this ledger. Verified local HEAD and
  `origin/blaec-synthesis-2026-06-18` both at `137cc011b4`; only newer shared
  files since the 18:03 render prep are the existing coordination status/logs,
  not a fresh Claude audit, fresh vision critique, or promoted source queue
  item. Preview ownership remains correct: hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src`. Claimed files: this ledger and shared
  coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, preview rebuild/restart, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 18:06 PDT:** QUEUE DRAINED / PREVIEW OWNER VERIFIED. No
  public-site route source was changed and no build/browser QA was run because
  no rendered route was touched. The current branch HEAD remains `137cc011b4`
  and the latest public-site source-change commit remains `22a6c015f1`. The
  known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude's fresh vision design critique against
  `/tmp/cocalc-public-qa-CJKOCP` or another curated queue item before any
  further Codex route edits.

### Codex - regenerate feature-page vision-critique renders (2026-06-22 18:03 PDT)

- **START 2026-06-22 18:02 PDT:** User relayed Claude's request to verify
  synthesis preview ownership and regenerate fresh feature-page screenshots for
  the post-polish vision critique. Verified preview hub pid `27431` is already
  rooted at `/home/user/cocalc-ai-synthesis/src`; no restart or rebuild needed.
  Current source HEAD is `22a6c015f1` (`frontend/public: give Linux page middle
sections room`). Claimed files: this ledger and shared coordination
  status/logs only. Routes/render targets: `/features/julia`,
  `/features/octave`, `/features/r-statistical-software`, `/features/sage`,
  `/features/more-languages`, `/features/python`, `/features/terminal`,
  `/features/linux`, `/features/jupyter-notebook`, `/features/latex-editor`,
  `/features/whiteboard`, `/features/slides`, `/features/automations`, and
  `/features/ai` at desktop and mobile. Do not touch route source, protected
  home, pricing/compliance, type/palette gates, pitch/docs content, raw audit
  findings, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 18:03 PDT:** Fresh feature-page render set regenerated for
  Claude's vision critique. Browser QA against `https://blaec.cocalc.ai`
  covered all 14 requested routes at desktop and mobile, passed 580/580
  assertions, and wrote 28 screenshots plus `results.json` to
  `/tmp/cocalc-public-qa-CJKOCP`. Preview ownership remains correct: hub pid
  `27431` is rooted at `/home/user/cocalc-ai-synthesis/src`. No public-site
  route source changed; the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Next action is Claude's fresh vision design critique against
  `/tmp/cocalc-public-qa-CJKOCP`; Codex source queue remains drained until a
  curated result is promoted.

### Codex - Linux page middle-section breathing room (2026-06-22 17:49 PDT)

- **START 2026-06-22 17:49 PDT:** User flagged the online Linux environment
  page (`/features/linux`) middle section as too tight: adjacent text sections
  need more breathing room. Verified current worktree
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`, with
  preview hub pid `27431` rooted at `/home/user/cocalc-ai-synthesis/src`.
  Claimed files/routes: `/features/linux`,
  `src/packages/frontend/public/features/linux-page.tsx`, focused tests if
  needed, this ledger, and the public-site framing workplan route frame. Do not
  touch protected home, pricing/compliance, type/palette gates, pitch/docs
  content, raw audit findings, or the untracked
  `dedicated-compute-page.tsx` draft. Plan: inspect render/screenshots, make a
  narrow layout-spacing fix using existing tokens/patterns, rebuild preview,
  run browser QA for `/features/linux`, commit, and push.
- **END 2026-06-22 17:56 PDT:** Linux middle-section breathing room fixed.
  Added a route-local `MIDDLE_SECTION_SPACER_STYLE` and applied it to the
  three middle proof sections between the opening card row and the final band.
  Preserved Linux copy, proof, CTA destinations, final band, protected home,
  pricing/compliance, type/palette gates, pitch/docs content, raw audit
  findings, and the untracked `dedicated-compute-page.tsx` draft. Validation:
  focused feature Jest passed 129/129 (with existing Ant Design React
  `act(...)` console warnings), `pnpm -C src lint:frontend` passed,
  `pnpm --dir src/packages/static build:dev` passed, and browser QA for
  `/features/linux` desktop+mobile passed 46/46 with screenshots in
  `/tmp/cocalc-public-qa-uVd7ir`. Preview remains served by hub pid `27431`
  rooted at `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:46 PDT)

- **START 2026-06-22 17:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, landing-page issues tracker, and this ledger. `git ls-remote` showed
  `origin/blaec-synthesis-2026-06-18` still at local HEAD `9a1ef7df22`.
  Files newer than the 17:41 preview-restore status in
  `/home/user/cocalc-shared` are only coordination/status files, not a fresh
  Claude audit, fresh vision critique, or promoted source queue item. Preview
  ownership is correctly restored: hub pid `27431` is rooted at
  `/home/user/cocalc-ai-synthesis/src` and `pnpm -s dev:hub:status` reports the
  synthesis daemon on port `9100`. Claimed files: this ledger and shared
  coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, preview rebuild/restart, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:46 PDT:** QUEUE DRAINED / PREVIEW OWNER VERIFIED. No
  public-site route source was changed and no build/browser QA was run because
  no rendered route was touched. The latest public-site source-change commit
  remains Blaec's `ef3bed61d2`; this turn records only the queue gate and
  preview-owner verification in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; continue to verify hub cwd before future
  source/preview work.

### Codex - restore public-site preview ownership (2026-06-22 17:40 PDT)

- **START 2026-06-22 17:40 PDT:** User asked to make sure the right branch is
  served in the preview. Verified drift: running hub pid `238` is rooted at
  `/home/user/cocalc-ai/src`, while the public-site synthesis branch is
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18` at
  `a5fa00af2a`. Synthesis daemon config is present and points
  `HUB_CMD` at `DATA_BASE=/home/user/cocalc-ai/src/data/app
./packages/hub/bin/start.sh postgres`, so starting it from synthesis should
  reuse the existing preview database while serving synthesis source. Claimed
  preview ownership for this turn; no public-route source edits planned. Do
  not touch protected home, pricing/compliance, type/palette, pitch/docs
  content, raw audit findings, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:41 PDT:** PREVIEW OWNERSHIP RESTORED. Stopped the
  platform-rooted daemon from `/home/user/cocalc-ai/src` (`hub daemon stopped`;
  its cloudflared helper stopped with it), then started the synthesis daemon
  from `/home/user/cocalc-ai-synthesis/src` (`hub daemon started`, pid `27431`).
  Verified `readlink /proc/27431/cwd` =
  `/home/user/cocalc-ai-synthesis/src`, branch =
  `blaec-synthesis-2026-06-18`, commit = `a5fa00af2a`, and
  `pnpm -s dev:hub:status` reports running from the synthesis `.local`
  daemon state while reusing the existing postgres data dir under
  `/home/user/cocalc-ai/src/data/app`. External preview
  `https://blaec.cocalc.ai/` returns HTTP 200. Browser QA against `/` and
  `/features/terminal` on desktop+mobile passed 82/82 assertions with
  artifacts in `/tmp/cocalc-public-qa-l0L0oZ`. No public route source changed;
  the known untracked `dedicated-compute-page.tsx` draft remains untouched.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:37 PDT)

- **START 2026-06-22 17:37 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, framing system, landing-page issues tracker,
  design-system notes, decisions log, and this ledger. Dry-run fetch and
  `git ls-remote` showed no update to
  `origin/blaec-synthesis-2026-06-18`; local HEAD matched origin at
  `4e0dd6b4d2`. Files newer than the prior 17:32 gate in
  `/home/user/cocalc-shared` were only coordination/status files, not a fresh
  Claude audit, fresh vision critique, or promoted source queue item. The
  released Codex source queue remains drained: feature-page consistency items
  9-12 and design-polish items 13-15 are complete, FS-004 and FS-005 remain
  process/backlog items rather than autonomous queue items, and the post-batch
  QA sweep's low findings have not been promoted into the active Codex queue.
  Preview ownership drift is still present: the visible hub process pid `238`
  is rooted at `/home/user/cocalc-ai/src`, not
  `/home/user/cocalc-ai-synthesis/src`. Claimed files: this ledger and shared
  coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, preview rebuild/restart, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:37 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:31 PDT)

- **START 2026-06-22 17:31 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, landing-page issues tracker, design-system notes,
  decisions log, and this ledger. Dry-run fetch showed no update to
  `origin/blaec-synthesis-2026-06-18`; local HEAD matched origin at
  `466f8b88b6`. Files newer than the prior 17:26 gate in
  `/home/user/cocalc-shared` were only coordination/status files, not a fresh
  Claude audit, fresh vision critique, or promoted source queue item. The
  released Codex source queue remains drained: feature-page consistency items
  9-12 and design-polish items 13-15 are complete, FS-004 and FS-005 remain
  process/backlog items rather than autonomous queue items, and the post-batch
  QA sweep's low findings have not been promoted into the active Codex queue.
  Preview ownership drift is still present: the visible hub process pid `238`
  is rooted at `/home/user/cocalc-ai/src`, not
  `/home/user/cocalc-ai-synthesis/src`. Claimed files: this ledger and shared
  coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, preview rebuild/restart, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:32 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:26 PDT)

- **START 2026-06-22 17:26 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, landing-page issues tracker, and this ledger.
  Dry-run fetch showed no update to `origin/blaec-synthesis-2026-06-18`;
  local HEAD matched origin at `1df6764bd2`. Files newer than the prior
  17:21 gate in `/home/user/cocalc-shared` were only coordination/status
  files, not a fresh Claude audit, fresh vision critique, or promoted source
  queue item. The released Codex source queue remains drained: feature-page
  consistency items 9-12 and design-polish items 13-15 are complete, FS-004
  and FS-005 remain process/backlog items rather than autonomous queue items,
  and the post-batch QA sweep's low findings have not been promoted into the
  active Codex queue. Preview ownership drift is still present: the visible
  hub process pid `238` is rooted at `/home/user/cocalc-ai/src`, not
  `/home/user/cocalc-ai-synthesis/src`. Claimed files: this ledger and shared
  coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, preview rebuild/restart, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:26 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:21 PDT)

- **START 2026-06-22 17:21 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, landing-page issues tracker, and this ledger.
  Dry-run fetch showed no update to `origin/blaec-synthesis-2026-06-18`;
  local HEAD matched origin at `728e4e1059`. Files newer than the prior 17:16
  gate in `/home/user/cocalc-shared` were only coordination/status files, not a
  fresh Claude audit, fresh vision critique, or promoted source queue item. The
  released Codex source queue remains drained: feature-page consistency items
  9-12 and design-polish items 13-15 are complete, FS-004/FS-005 remain
  process/backlog items rather than autonomous queue items, and the
  post-batch QA sweep's low findings have not been promoted into the active
  Codex queue. Preview ownership drift is still present: the visible hub
  process pid `238` is rooted at `/home/user/cocalc-ai/src`, not
  `/home/user/cocalc-ai-synthesis/src`. Claimed files: this ledger and shared
  coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, preview rebuild/restart, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:21 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:16 PDT)

- **START 2026-06-22 17:16 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, feature-page design-polish slice, post-batch QA
  sweep, and this ledger. Dry-run fetch showed no update to
  `origin/blaec-synthesis-2026-06-18`; local HEAD matched origin at
  `2fc450ccfa`. The released Codex source queue remains drained:
  feature-page consistency items 9-12 and design-polish items 13-15 are
  complete, FS-004/FS-005 remain process/backlog items rather than autonomous
  queue items, and the post-batch QA sweep's low findings have not been
  promoted into the active Codex queue. No fresh Claude audit, fresh vision
  critique, or curated source queue item newer than the prior 17:07 gate was
  found in `/home/user/cocalc-shared`. Preview ownership drift is still
  present: the visible hub process pid `238` is rooted at
  `/home/user/cocalc-ai/src`, not `/home/user/cocalc-ai-synthesis/src`.
  Claimed files: this ledger and shared coordination status/logs only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, preview
  rebuild/restart, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:16 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:07 PDT)

- **START 2026-06-22 17:07 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, and this ledger. Dry-run fetch showed no update to
  `origin/blaec-synthesis-2026-06-18`; local HEAD matched origin at
  `4d19b33296`. The released Codex source queue remains drained:
  feature-page consistency items 9-12 and design-polish items 13-15 are
  complete, FS-004/FS-005 remain process/backlog items rather than autonomous
  queue items, and the post-batch QA sweep's low findings have not been
  promoted into the active Codex queue. No fresh Claude audit or vision
  critique newer than the prior queue gate was found in `/home/user/cocalc-shared`.
  Preview ownership drift is still present: the visible hub process pid `238`
  is rooted at `/home/user/cocalc-ai/src`, not
  `/home/user/cocalc-ai-synthesis/src`. Claimed files: this ledger and shared
  coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, preview rebuild/restart, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:07 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change commit
  remains Blaec's `ef3bed61d2`; this turn records only the queue gate and
  preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 17:01 PDT)

- **START 2026-06-22 17:01 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, and this ledger. Dry-run fetch showed no update to
  `origin/blaec-synthesis-2026-06-18`; local HEAD matched origin at
  `965615644b`. The released Codex source queue remains drained: feature-page
  consistency items 9-12 and design-polish items 13-15 are complete,
  FS-004/FS-005 remain process/backlog items rather than autonomous source
  queue items, and the post-batch QA sweep's low findings have not been
  promoted into the active Codex queue. Preview ownership drift is still
  present: the visible hub process pid `238` is rooted at
  `/home/user/cocalc-ai/src`, not `/home/user/cocalc-ai-synthesis/src`.
  Claimed files: this ledger and shared coordination status/logs only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, preview
  rebuild/restart, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 17:01 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:56 PDT)

- **START 2026-06-22 16:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, post-batch QA sweep, and this ledger. Dry-run fetch showed no update
  to `origin/blaec-synthesis-2026-06-18`; local HEAD matched origin at
  `81459ad147`. The released Codex source queue remains drained: feature-page
  consistency items 9-12 and design-polish items 13-15 are complete, FS-004
  and FS-005 are process/backlog items rather than autonomous queue items, and
  the post-batch QA sweep's low findings have not been promoted into the
  active Codex queue. Preview ownership drift is still present: the visible hub
  process pid `238` is rooted at `/home/user/cocalc-ai/src`, not
  `/home/user/cocalc-ai-synthesis/src`; local port-listener tools (`ss`,
  `lsof`, `netstat`) are not installed, so no port-listener claim was made.
  Claimed files: this ledger and shared coordination status/logs only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, preview
  rebuild/restart, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:56 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:51 PDT)

- **START 2026-06-22 16:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, feature-page design-polish slice, post-batch QA
  sweep, and this ledger. Dry-run fetch showed no update to
  `origin/blaec-synthesis-2026-06-18`; local HEAD matches origin at
  `37ec6e180e`. The released Codex source queue remains drained: feature-page
  consistency items 9-12 and design-polish items 13-15 are complete, FS-004
  and FS-005 are process/backlog items rather than autonomous queue items, and
  the post-batch QA sweep's low findings have not been promoted into the
  active Codex queue. Preview ownership drift is still present: the only
  visible hub process is pid `238`, rooted at `/home/user/cocalc-ai/src`, not
  the synthesis worktree; no `:9100` listener was visible via `ss`. Claimed
  files: this ledger and shared coordination status/logs only. Guardrails: no
  protected home, pricing/compliance, type/palette work, pitch/docs content,
  route source edits, raw-audit foraging, preview rebuild/restart, or the
  untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:52 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT STILL
  PRESENT. No public-site route source was changed and no build/browser QA was
  run because no rendered route was touched and the preview is not currently
  rooted in the synthesis worktree. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; this turn records only the queue gate
  and preview-owner risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:45 PDT)

- **START 2026-06-22 16:45 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, and this ledger. Dry-run fetch showed no update to
  `origin/blaec-synthesis-2026-06-18`; local HEAD matched origin at
  `2bd2f2ace9`. The released Codex source queue remains drained: feature-page
  consistency items 9-12 and design-polish items 13-15 are complete, the next
  source slice is still gated on Claude audit plus a fresh vision-critique pass,
  and the post-batch QA sweep's low findings have not been promoted into the
  active Codex queue. Preview ownership drift observed: the only visible hub
  process was pid `238`, rooted at `/home/user/cocalc-ai/src`, not the synthesis
  worktree; no static build/watch process or `:9100` listener was observed via
  available port tools. Claimed files: this ledger and shared coordination
  status/logs only. Guardrails: no protected home, pricing/compliance,
  type/palette work, pitch/docs content, route source edits, raw-audit foraging,
  preview rebuild/restart, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:45 PDT:** QUEUE DRAINED / PREVIEW OWNER DRIFT. No
  public-site route source was changed and no build/browser QA was run because
  no rendered route was touched and the preview is not currently rooted in the
  synthesis worktree. The latest public-site source-change commit remains
  Blaec's `ef3bed61d2`; this turn records only the queue gate and preview-owner
  risk in coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item; before source/preview work, restore/verify
  `blaec.cocalc.ai` ownership from `/home/user/cocalc-ai-synthesis/src`.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:35 PDT)

- **START 2026-06-22 16:35 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, feature-page design-polish slice, post-batch QA
  sweep, and this ledger. Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`; no static build/watch process was
  observed. Dry-run fetch showed no update to
  `origin/blaec-synthesis-2026-06-18`, and local HEAD matches origin at
  `0a796173c0`. The released Codex queue remains drained: feature-page
  consistency items 9-12 and design-polish items 13-15 are complete, the
  current shared status and workplan still gate the next source slice on
  Claude audit plus a fresh vision-critique pass, and the post-batch QA
  sweep's low findings have not been promoted into the active Codex queue.
  Claimed files: this ledger and shared coordination status/logs only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:38 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; this turn records only the queue gate in coordination
  artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:31 PDT)

- **START 2026-06-22 16:31 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, feature-page design-polish slice, post-batch QA
  sweep, and this ledger. Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`; no static build/watch process was
  observed. The released Codex queue remains drained: feature-page consistency
  items 9-12 and design-polish items 13-15 are complete, the current shared
  status and workplan still gate the next source slice on Claude audit plus a
  fresh vision-critique pass, and the post-batch QA sweep's low findings have
  not been promoted into the active Codex queue. Claimed files: this ledger and
  shared coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, or the untracked `dedicated-compute-page.tsx`
  draft.
- **END 2026-06-22 16:32 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; this turn records only the queue gate in coordination
  artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:26 PDT)

- **START 2026-06-22 16:26 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, feature-page design-polish slice, post-batch QA
  sweep, and this ledger. Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`; no static build/watch process was
  observed. The released Codex queue remains drained: feature-page consistency
  items 9-12 and design-polish items 13-15 are complete, the current shared
  status still gates the next source slice on Claude audit plus a fresh
  vision-critique pass, and the post-batch QA sweep's low findings have not
  been promoted into the active Codex queue. Claimed files: this ledger and
  shared coordination status/logs only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, or the untracked `dedicated-compute-page.tsx`
  draft.
- **END 2026-06-22 16:27 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; this turn records only the queue gate in coordination
  artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:20 PDT)

- **START 2026-06-22 16:20 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, feature-page design-polish slice, post-batch QA
  sweep, and this ledger. Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`; no static build/watch process was
  observed. The released Codex queue remains drained: feature-page consistency
  items 9-12 and design-polish items 13-15 are complete, and the current shared
  status still gates the next source slice on Claude audit plus a fresh
  vision-critique pass. Claimed files: this ledger and shared coordination
  status/logs only. Guardrails: no protected home, pricing/compliance,
  type/palette work, pitch/docs content, route source edits, raw-audit foraging,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:20 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; this turn records only the queue gate in coordination
  artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:16 PDT)

- **START 2026-06-22 16:16 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, and this ledger. Verified the preview hub pid
  `15671` serves `/home/user/cocalc-ai-synthesis/src`; no static
  build/watch process was observed. The released Codex queue is still drained:
  feature-page consistency items 9-12 and design-polish items 13-15 are
  complete, the workplan gates the next source slice on Claude audit plus a
  fresh vision-critique pass, and raw-audit foraging remains off limits.
  Claimed files: this ledger and shared coordination status/logs only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:16 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; this turn records only the queue gate in coordination
  artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:06 PDT)

- **START 2026-06-22 16:06 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, and this ledger. Verified the preview hub pid
  `15671` serves `/home/user/cocalc-ai-synthesis/src`. The released Codex
  queue is still drained: feature-page consistency items 9-12 and design-polish
  items 13-15 are complete, the workplan gates the next source slice on Claude
  audit plus a fresh vision-critique pass, and raw-audit foraging remains off
  limits. Claimed files: this ledger and shared coordination status/logs only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:06 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; this turn records only the queue gate in coordination
  artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 16:01 PDT)

- **START 2026-06-22 16:00 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, multi-agent operating
  model, current workplan, and this ledger. Verified the preview hub pid
  `15671` serves `/home/user/cocalc-ai-synthesis/src`. The curated Codex queue
  is still drained: feature-page consistency items 9-12 and design-polish items
  13-15 are complete, the workplan gates the next source slice on Claude audit
  plus a fresh vision-critique pass, and raw-audit foraging remains off limits.
  Claimed files: this ledger and shared coordination status/logs only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 16:01 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; this turn records only the queue gate in coordination
  artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue gate (2026-06-22 15:56 PDT)

- **START 2026-06-22 15:55 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, workplan, and this ledger.
  Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`. The current curated Codex queue is
  still drained: feature-page consistency items 9-12 and design-polish items
  13-15 are complete, the workplan still gates the next source slice on Claude
  audit plus a fresh vision-critique pass, and raw-audit foraging remains off
  limits. Claimed files: this ledger and shared coordination status only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch/docs content, route source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 15:56 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. The latest public-site source-change commit remains Blaec's
  `ef3bed61d2`; the latest coordination gate remains this run's ledger/shared
  status update. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop queue check (2026-06-22 15:50 PDT)

- **START 2026-06-22 15:50 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, workplan, and this ledger.
  Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`. The current curated Codex queue remains
  drained: feature-page consistency items 9-12 and design-polish items 13-15
  are complete, the workplan points to Claude audit plus a fresh
  vision-critique pass, and raw-audit foraging remains off limits. Claimed
  files: this ledger and
  `src/.agents/public-site-framing-workplan-2026-06-20.md` only. Guardrails:
  no protected home, pricing/compliance, type/palette work, pitch/docs content,
  route source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 15:51 PDT:** QUEUE DRAINED. No public-site route source was
  changed and no build/browser QA was run because no rendered route was
  touched. Updated the workplan only to mark the already-completed terminal
  slice as `done` and replace the stale burn-down order with the current
  Claude-audit/fresh-vision-critique gate. The latest public-site source-change
  commit remains Blaec's `ef3bed61d2`; the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched.

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 15:46 PDT)

- **START 2026-06-22 15:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, workplan, and this ledger.
  Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`. Targeted queue check again found no
  released Codex item: feature-page consistency items 9-12 and design-polish
  items 13-15 are complete, the workplan points to Claude audit plus a fresh
  vision-critique pass, and the raw audit remains off limits for autonomous
  foraging. Claimed files: this ledger only. Guardrails: no protected home,
  pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, or the untracked `dedicated-compute-page.tsx`
  draft.
- **END 2026-06-22 15:46 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains Blaec's `ef3bed61d2`;
  this turn updates only coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 15:39 PDT)

- **START 2026-06-22 15:39 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, workplan, and this ledger.
  Verified the preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`. Targeted queue check found no released
  Codex item: feature-page consistency items 9-12 and design-polish items
  13-15 are complete; the current instruction is to wait for Claude audit and
  a fresh vision-critique pass before taking another curated fix slice.
  Noted Blaec's later source commit `ef3bed61d2`
  (`frontend/public: align terminal collaboration section`) and left it
  untouched as user-owned work. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette work, pitch/docs content, route source
  edits, raw-audit foraging, or the untracked `dedicated-compute-page.tsx`
  draft.
- **END 2026-06-22 15:39 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains Blaec's `ef3bed61d2`;
  this turn updates only coordination artifacts. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude audit / fresh vision critique or another
  curated, non-gated queue item.

### Codex - sage/automations residual polish (2026-06-22 15:28 PDT)

- **START 2026-06-22 15:22 PDT:** Continuing design-polish item 15 after the
  more-languages residual landed in `6527bc867a` and handoff `494586b5fb` was
  pushed. Taking the final bounded residual sub-slice:
  `/features/sage` and `/features/automations`. Claimed files:
  `src/packages/frontend/public/features/sage-page.tsx`,
  `src/packages/frontend/public/features/automations-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Do not touch protected
  `home/**`, footer, pricing/compliance, type/palette token values, pitch/docs
  content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 15:28 PDT:** Final item-15 residual sub-slice landed in
  `1cb96b354d` (`frontend/public: tighten sage and automation feature copy`).
  Sage's dense left-column prose and proof bullets were shortened while
  preserving notebook/source/terminal/long-job/error/course proof. Automations'
  proof paragraph was tightened, its mock background moved to existing public
  tokens, and its raw-hex allowlist entry was removed because no raw route
  colors remain. Validation passed: Prettier on touched files; focused
  feature/browser-QA harness Jest 134/134; `git diff --check`; `pnpm -C src
lint:frontend`; `pnpm -C src/packages/static build:dev` from git revision
  `1cb96b354d` with only the existing local debug-log permission warning;
  browser QA desktop+mobile for `/features/sage` and `/features/automations`
  passed 78/78 at `/tmp/cocalc-public-qa-DvWPrx`. Screenshot inspection:
  Sage/automations left columns are lighter and desktop/mobile layouts have no
  overlap. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Design-polish item 15 is now complete; next step is Claude
  audit / fresh vision-critique pass per the slice instructions.

### Codex - more-languages residual polish (2026-06-22 15:21 PDT)

- **START 2026-06-22 15:16 PDT:** Continuing design-polish item 15 after the
  Octave hierarchy residual landed in `7283d4fa67` and handoff `b7f6c104df`
  was pushed. Taking the next bounded residual sub-slice:
  `/features/more-languages`. Claimed files:
  `src/packages/frontend/public/features/more-languages-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Do not touch protected
  `home/**`, footer, pricing/compliance, type/palette token values, pitch/docs
  content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 15:21 PDT:** More-languages residual sub-slice landed in
  `6527bc867a` (`frontend/public: polish more-languages feature cards`). The
  language-stack visual now uses existing public surface/elevation tokens, the
  repeated language tiles are rendered through one local `LanguageStackCard`
  treatment, dense explanatory copy was tightened, and the page's raw-hex
  allowlist entry was removed because no raw color literals remain. Validation
  passed: Prettier on touched files; focused feature/browser-QA harness Jest
  134/134; `git diff --check`; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev` from git revision `6527bc867a` with only the
  existing local debug-log permission warning; browser QA desktop+mobile for
  `/features/more-languages` passed 36/36 at
  `/tmp/cocalc-public-qa-VAoPQ0`. Screenshot inspection: stack cards are
  consistent and mobile copy wraps cleanly with no overlap. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Item 15 remains open; remaining residual candidate:
  sage/automations text-heavy left columns.

### Codex - octave hierarchy polish (2026-06-22 15:15 PDT)

- **START 2026-06-22 15:09 PDT:** Continuing design-polish item 15 after the
  whiteboard residual landed in `717f76707f` and handoff `0291848833` was
  pushed. Taking the next bounded residual sub-slice: `/features/octave`.
  Claimed files: `src/packages/frontend/public/features/octave-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Do not touch protected
  `home/**`, footer, pricing/compliance, type/palette token values, pitch/docs
  content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 15:15 PDT:** Octave residual sub-slice landed in
  `7283d4fa67` (`frontend/public: refine octave heading hierarchy`). The first
  Octave proof-section title now uses the existing `PUBLIC_TYPE.subhead` scale
  while preserving the visible hero as the page's `h2` and the proof section
  as `h3`, restoring clearer visual dominance for the hero without changing
  copy or proof. Added an Octave-specific canary for that hierarchy. Validation
  passed: Prettier on touched files; focused feature/browser-QA harness Jest
  134/134; `git diff --check`; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev` from git revision `7283d4fa67` with only the
  existing local debug-log permission warning; browser QA desktop+mobile for
  `/features/octave` passed 38/38 at `/tmp/cocalc-public-qa-DXTbx2`.
  Screenshot inspection: hero headline now reads stronger than the first proof
  heading on desktop/mobile, with no overlap. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Item 15 remains open; remaining residual candidates:
  more-languages cramped pill/right-rail and sage/automations text-heavy left
  columns.

### Codex - whiteboard residual polish (2026-06-22 15:08 PDT)

- **START 2026-06-22 14:57 PDT:** Continuing design-polish item 15 after the
  slides residual landed in `cee71ca3a7` and handoff `0c8ff659da` was pushed.
  Taking the next bounded residual sub-slice: `/features/whiteboard`. Claimed
  files: `src/packages/frontend/public/features/whiteboard-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Do not touch protected
  `home/**`, footer, pricing/compliance, type/palette token values, pitch/docs
  content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 15:08 PDT:** Whiteboard residual sub-slice landed in
  `717f76707f` (`frontend/public: polish whiteboard feature cards`). The
  whiteboard hero mock no longer uses a bespoke nested canvas illustration; it
  now uses compact tokenized icon cards for markdown notes, LaTeX math,
  Jupyter cells, and a connected page. The directed graph proof panel uses
  existing public surface/elevation/warning tokens and tighter spacing so the
  mobile graph no longer crowds the card. Whiteboard left the legacy inline
  style budget and its raw-hex allowlist is tightened to route accents only.
  Validation passed: Prettier on touched files; focused feature/browser-QA
  harness Jest 133/133; `git diff --check`; `pnpm -C src lint:frontend`;
  `pnpm -C src/packages/static build:dev` from git revision `717f76707f` with
  only the existing local debug-log permission warning; browser QA
  desktop+mobile for `/features/whiteboard` passed 42/42 at
  `/tmp/cocalc-public-qa-Tn3FQc`. Screenshot inspection: hero cards and the
  graph proof are readable on desktop/mobile with no overlap. The known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Item 15 remains open; remaining residual
  candidates: octave heading hierarchy, more-languages cramped pill/right-rail,
  and sage/automations text-heavy left columns.

### Codex - slides residual polish (2026-06-22 14:50 PDT)

- **START 2026-06-22 14:50 PDT:** Continuing into design-polish item 15 after
  the Python hero standardization landed in `6431a4eab6` and handoff
  `7783dd0b11` was pushed. Taking the first bounded residual sub-slice:
  `/features/slides`. Claimed files:
  `src/packages/frontend/public/features/slides-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Do not touch protected
  `home/**`, footer, pricing/compliance, type/palette token values, pitch/docs
  content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 14:56 PDT:** Slides residual sub-slice landed in
  `cee71ca3a7` (`frontend/public: polish slides feature cards`). The slides
  hero mock no longer uses bespoke cream/yellow inner slide boxes; its gradient
  and flow-card backgrounds now use existing public tokens, and the slide
  thumbnails use the compact icon-card treatment used by the other feature
  mocks. The slides raw-hex allowlist is tightened to the remaining route
  accent only. Validation passed: Prettier on touched files; focused
  feature/browser-QA harness Jest 133/133; `git diff --check`; `pnpm -C src
lint:frontend`; `pnpm -C src/packages/static build:dev` from git revision
  `cee71ca3a7` with only the existing local debug-log permission warning;
  browser QA desktop+mobile for `/features/slides` passed 34/34 at
  `/tmp/cocalc-public-qa-RpX724`. Screenshot inspection: hero mock and deck
  flow cards are visually consistent on desktop/mobile, with no overlap. The
  known untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Item 15 remains open; next residual candidate:
  whiteboard bespoke graphics.

### Codex - python hero standardization (2026-06-22 14:42 PDT)

- **START 2026-06-22 14:42 PDT:** Continuing into design-polish item 14 after
  the shared final-band balance landed in `b11e25473f` and handoff
  `4e52f4fb1f` was pushed. Claimed files:
  `src/packages/frontend/public/features/python-page.tsx`,
  `src/packages/frontend/public/features/r-statistical-software-page.tsx` only
  if source inspection showed R still violated the Julia/Octave hero template,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Representative QA routes:
  `/features/python` and `/features/r-statistical-software`. Do not touch
  protected `home/**`, footer, pricing/compliance, type/palette token values,
  pitch/docs content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 14:49 PDT:** Source slice landed in `6431a4eab6`
  (`frontend/public: standardize python hero composition`). Python's hero right
  column now stays to one project/product card; the extra dark terminal mock
  and Codex card were removed from the hero. The notebook/script/terminal/
  package/paper/review proof remains split between the compact project card,
  the new `Project context` `ContextList` in the workflow band, the existing
  workflow cards, and the package-heavy use-case card. Python now participates
  in the shared-primitive guardrail, and its inline-style budget is tightened
  from 31 to 20. R was source- and screenshot-audited and already matched the
  template: one R project card plus a `Project context` checklist, so no R
  source edit was needed. Validation passed: Prettier on touched files;
  focused feature/browser-QA harness Jest 133/133; `git diff --check`; `pnpm
-C src lint:frontend`; `pnpm -C src/packages/static build:dev` from git
  revision `6431a4eab6` with only the existing local debug-log permission
  warning; browser QA desktop+mobile for `/features/python` and
  `/features/r-statistical-software` passed 76/76 at
  `/tmp/cocalc-public-qa-FzLboQ`. Screenshot inspection: Python no longer
  over-stacks the hero right column, Python/R desktop heroes are balanced, and
  mobile stacks remain readable with no overlap. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Next queue item: design-polish item 15, per-page residuals.

### Codex - feature-page final-band balance (2026-06-22 14:35 PDT)

- **START 2026-06-22 14:35 PDT:** Continuing into design-polish item 13 after
  the feature-page consistency guardrails landed in `72f9c41b65` and handoff
  `b2f963bf08` was pushed. Claimed files:
  `src/packages/frontend/public/features/feature-visuals.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Representative QA routes:
  `/features/julia`, `/features/r-statistical-software`,
  `/features/whiteboard`, and `/features/automations`. Do not touch protected
  `home/**`, footer, pricing/compliance, type/palette token values, pitch/docs
  content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 14:41 PDT:** Source slice landed in `b11e25473f`
  (`frontend/public: balance feature final bands`). `FeatureFinalBand` now uses
  the shared antd row `align="middle"` setting so short CTA cards are vertically
  centered next to taller proof/bullet columns instead of top-aligned. Added a
  feature-suite regression guard covering every route that renders
  `FeatureFinalBand`, asserting the final-band row stays middle-aligned and not
  top-aligned. Validation passed: Prettier on touched files; focused
  feature/browser-QA harness Jest 132/132; `git diff --check`; `pnpm -C src
lint:frontend`; `pnpm -C src/packages/static build:dev` from git revision
  `b11e25473f` with only the existing local debug-log permission warning;
  browser QA desktop+mobile for `/features/julia`,
  `/features/r-statistical-software`, `/features/whiteboard`, and
  `/features/automations` passed 158/158 at `/tmp/cocalc-public-qa-sBF2YD`.
  Screenshot inspection: desktop final CTA cards are centered against taller
  copy columns; mobile stacks remain readable with no overlap. The known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Next queue item: design-polish item 14, hero
  right-column standardization.

### Codex - feature-page prevention guardrails (2026-06-22 14:28 PDT)

- **START 2026-06-22 14:28 PDT:** Continuing the curated feature-page
  consistency queue after the LaTeX source commit `e5451f2c01` and handoff
  commit `17e0e75a79` were pushed. Claimed files:
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/public/features/compare-page.tsx` only if the new
  token guard exposed an existing raw px font-size literal, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Do not touch protected
  `home/**`, footer, pricing/compliance, type/palette token values, pitch/docs
  content, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 14:34 PDT:** Source/test slice landed in `72f9c41b65`
  (`frontend/public: add feature page consistency guardrails`). Added Tier-1
  guardrails to the existing public feature suite: canonical shared-primitive
  pages must render `FeatureFinalBand` plus at least one `ContextList`; tracked
  route pages cannot add new zero-shared-primitive surfaces outside the
  explicit custom-page allowlist; feature page inline `style={{}}` blocks now
  have a default budget of 15 with named legacy ceilings; raw feature-page hex
  literals must appear on an explicit per-file allowlist; raw px font-size
  literals are banned. The one existing compare-table `font-size: 16px` literal
  was tokenized through `PUBLIC_TYPE.body`. Validation passed: Prettier on
  touched files; focused feature/browser-QA harness Jest 119/119; `git diff
--check`; `pnpm -C src lint:frontend`. No static rebuild/browser screenshot
  was run because the only runtime source change preserves the same computed
  compare-page font size through an existing token. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Next queue item: design-polish item 13, shared two-column
  band balance.

### Codex - latex feature-page consolidation (2026-06-22 14:19 PDT)

- **START 2026-06-22 14:19 PDT:** Continuing the curated feature-page
  consistency queue after Linux landed in `d8df1f24c7` and handoff commit
  `069a70d412` was pushed. Claimed route/files:
  `src/packages/frontend/public/features/latex-editor-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs` if route canaries
  need selector updates, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Preview hub remains rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  observed.
- **Route frame:** feature detail. Visitor: researcher, author, collaborator,
  or reviewer whose LaTeX paper depends on code, figures, build logs,
  coauthors, and history. Visitor question: can the paper stay connected to
  its source, generated evidence, collaborators, and review context? One-
  sentence promise: CoCalc keeps LaTeX source, PDF builds, coauthors,
  TimeTravel, SageTeX/computation, and related project files together in one
  reviewable project. Proof mechanism: source/PDF/builds, real-time coauthors
  with visible cursors, TimeTravel, SageTeX/computation, fit-decision table,
  and related Jupyter/terminal/AI paths. Primary next step: create account/
  open projects. Secondary next step: LaTeX guide, paper-polishing workflow,
  related feature/product routes. What this must not claim: no competitor
  superiority, compliance/trust claims, paper-quality guarantee, invented build
  metrics, or AI-as-author claim. Decision: redesign the route structure and
  final band around shared primitives while preserving the fit-decision table
  and concrete LaTeX proof.
- **Do not touch:** protected `home/**`, footer, pricing/compliance,
  type/palette lanes, pitch docs, docs content, other feature pages except
  route links from the LaTeX page, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 14:27 PDT:** Source slice landed in `e5451f2c01`
  (`frontend/public: consolidate latex feature page`). `/features/latex-editor`
  now follows the shared feature-detail model: text-first hero with
  `ContextList`, shared `StoryCard` proof cards, lower source/PDF/build-log
  evidence panel, computation-loop `ContextList`, preserved fit-decision table,
  and shared `FeatureFinalBand`. Removed the route-owned large mock,
  hand-rolled context/computation panels, and custom CTA ending. Inline
  `style={{}}` blocks are now 5. Preserved source/PDF output, build logs,
  real-time coauthors with visible cursors, TimeTravel, SageTeX/computed
  figures, related Jupyter/terminal/AI paths, and the fit-decision table's
  caption/aria contract. Validation passed: Prettier on touched source/test/QA
  files; `git diff --check`; focused feature/browser-QA harness Jest 105/105;
  `pnpm -C src lint:frontend`; `pnpm -C src/packages/static build:dev` before
  commit and again after commit from git revision `e5451f2c01` with the
  existing local debug-log permission warning only; browser QA for
  `/features/latex-editor` desktop+mobile 48/48, final screenshots/results at
  `/tmp/cocalc-public-qa-ZfyES1`. Screenshot inspection: desktop/mobile
  readable with no overlap; fit table remains legible. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Next queue item: Tier-1 prevention tests.

### Codex - linux feature-page consolidation (2026-06-22 14:10 PDT)

- **START 2026-06-22 14:10 PDT:** Continuing the curated feature-page
  consistency queue after Jupyter landed in `fc594e14c2` and handoff commit
  `70853c3e50` was pushed. Claimed route/files:
  `src/packages/frontend/public/features/linux-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs` if route canaries
  need selector updates, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Verified preview hub pids
  `15629` and `15671`, both rooted at `/home/user/cocalc-ai-synthesis/src`;
  no active static build/watch process observed.
- **Route frame:** feature detail. Visitor: researcher, engineer, instructor,
  or lab/team lead who needs Linux tools beside notebooks, files, services,
  and review history. Visitor question: can I administer the Linux environment
  for this project without losing reproducibility or asking every teammate to
  rebuild it by hand? One-sentence promise: CoCalc gives each project an
  Ubuntu environment that can install packages, run services, preserve setup
  context, and return to a known-good state. Proof mechanism: Ubuntu
  environment, sudo/apt, language packages, services, terminal commands,
  snapshots/known-good state, reusable environment images, and related
  Terminal/Jupyter paths. Primary next step: create account/open projects.
  Secondary next step: software install guide, environment image guide,
  Terminal/Jupyter/product routes. What this must not claim: no setup-time,
  performance, managed compute, compliance, migration, root-filesystem jargon,
  or agent-runs-without-user-approval claim. Decision: redesign the route
  structure and final band around shared primitives while preserving concrete
  Linux proof.
- **Do not touch:** protected `home/**`, footer, pricing/compliance,
  type/palette lanes, pitch docs, docs content, other feature pages except
  route links from the Linux page, raw-audit findings, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **END 2026-06-22 14:17 PDT:** Source slice landed in `d8df1f24c7`
  (`frontend/public: consolidate linux feature page`). `/features/linux` now
  follows the shared feature-detail model: text-first hero with `ContextList`,
  shared `StoryCard` proof cards, a lower Ubuntu/apt evidence panel,
  shared `CodeBlock` command proof, reusable-environment `ContextList`, and
  shared `FeatureFinalBand`. Removed the route-owned layers diagram, raw
  `<pre>` panel, and custom final panel. Inline `style={{}}` blocks are now 12.
  Preserved Ubuntu environment, sudo/apt installs, system and language package
  layers, services, snapshots/known-good state, reusable environment images,
  and the "You decide what runs" boundary. Validation passed: Prettier on
  touched source/test/QA files; `git diff --check`; focused feature/browser-QA
  harness Jest 105/105; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev` before commit and again after commit from git
  revision `d8df1f24c7` with the existing local debug-log permission warning
  only; browser QA for `/features/linux` desktop+mobile 46/46, final
  screenshots/results at `/tmp/cocalc-public-qa-glNoNR`. Screenshot inspection:
  desktop/mobile readable with no overlap; command block remains horizontally
  scrollable on mobile. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Next queue item: `/features/latex-editor` consolidation.

### Codex - jupyter feature-page consolidation (2026-06-22 13:59 PDT)

- **START 2026-06-22 13:59 PDT:** Scheduled landing-page improvement loop
  resumed in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, finite issues tracker, framing system/register, design
  system direction, decisions log, active framing workplan, site-round prompt,
  and `feature-page-consistency-slice-2026-06-22.md`. Current queued item is
  #9: consolidate `/features/jupyter-notebook` to the terminal/language-page
  shared-primitive model. Verified preview hub pids `15629` and `15671`, both
  rooted at `/home/user/cocalc-ai-synthesis/src`; no active static build/watch
  process observed. Claimed route/files:
  `src/packages/frontend/public/features/jupyter-notebook-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs` if canaries need
  route-marker updates, this ledger,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, and
  `/home/user/cocalc-shared/codex-turn-log.md`.
- **Route frame:** feature detail. Visitor: researcher, engineer, instructor,
  or reviewer whose notebook depends on files, packages, kernels,
  collaborators, and review history. Visitor question: can Jupyter work stay
  attached to the shared project instead of becoming an isolated notebook
  session? One-sentence promise: CoCalc keeps Jupyter notebooks beside their
  data, packages, live kernel state, collaborators, TimeTravel history, and
  related project files. Proof mechanism: kernels, data files, packages,
  collaborators, shared kernel/live state, TimeTravel, terminal/Linux paths,
  and directed-graph workflow proof. Primary next step: create account/open
  projects. Secondary next step: Jupyter guide, compatibility guide, AI/Linux/
  terminal/teaching/product routes. What this must not claim: no benchmarks,
  setup/restore timing, migration guarantees, managed compute, compliance,
  vertical-specific proof, or broad agent-platform claim. Decision: redesign
  the route structure and final band around shared primitives while preserving
  the concrete Jupyter proof.
- **Do not touch:** protected `home/**`, footer, pricing/compliance, type/
  palette lanes, pitch docs, docs content, other feature pages except route
  links from the Jupyter page, raw-audit foraging, or the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft.
- **Validation required:** focused feature Jest, browser-QA harness if markers
  change, `git diff --check`, Prettier on touched files,
  `pnpm -C src lint:frontend`, static build, desktop+mobile browser QA/
  screenshot inspection for `/features/jupyter-notebook`, source commit,
  preview rebuild, shared-log handoff.
- **END 2026-06-22 14:07 PDT:** Source slice landed in `fc594e14c2`
  (`frontend/public: consolidate jupyter feature page`).
  `/features/jupyter-notebook` now follows the terminal/language-page shared-
  primitive model:
  text-first hero with `ContextList`, shared `StoryCard` proof cards, one lower
  notebook evidence panel, project-scoped Jupyter command proof, and shared
  `FeatureFinalBand`. Removed the route-owned modal, local `StoryCard`, and
  custom final panel. Inline `style={{}}` blocks dropped from 31 to 9.
  Preserved kernels, data files, packages, collaborators, shared live state,
  TimeTravel, qualitative output labels, Codex notebook commands, and the
  directed-graph workflow pointer. Validation passed: Prettier on touched
  files; `git diff --check`; focused feature/browser-QA harness Jest 105/105;
  `pnpm -C src lint:frontend`; `pnpm -C src/packages/static build:dev` before
  commit and again after commit from git revision `fc594e14c2` with the
  existing local debug-log permission warning only; browser QA for
  `/features/jupyter-notebook` desktop+mobile 50/50, final screenshots/results
  at `/tmp/cocalc-public-qa-KJn1GA`. Screenshot inspection: desktop/mobile
  readable with no overlap; long code commands remain horizontally scrollable
  on mobile. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Next queue item: `/features/linux` consolidation.

### Codex - terminal hero spacing adjustment (2026-06-22 13:55 PDT)

- **START 2026-06-22 13:55 PDT:** Responding to Blaec's screenshot feedback
  that the `/features/terminal` top hero feels too close to the proof cards
  underneath. Worktree `/home/user/cocalc-ai-synthesis`, branch
  `blaec-synthesis-2026-06-18`. Verified preview hub pids `15629` and `15671`,
  both rooted at `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch process observed. Claimed route/files: `/features/terminal`,
  `src/packages/frontend/public/features/terminal-page.tsx`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`. Guardrails: no protected home,
  pricing/compliance, docs content, pitch docs, type/palette/token lanes, other
  feature pages, raw-audit foraging, support-alert follow-up, or the untracked
  dedicated-compute draft.
- **END 2026-06-22 13:58 PDT:** Added `marginTop: 12` to the first proof-card
  row on `/features/terminal`, increasing the hero-to-card pause from the
  page's 22px root gap to 34px while leaving the rest of the page rhythm,
  cards, copy, CTAs, and layout unchanged. Validation passed: Prettier on
  `terminal-page.tsx`; `git diff --check`; focused feature Jest 100/100;
  browser-QA harness Jest 5/5; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev` with the existing local debug-log permission
  warning only; browser QA for `/features/terminal` desktop+mobile 48/48,
  screenshots/results at `/tmp/cocalc-public-qa-N0kiTO`. Screenshot inspection:
  desktop and mobile now show a clearer pause between the hero/context block and
  first proof cards with no overflow. The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched.

### Codex - scheduled landing-page improvement loop hold (2026-06-22 13:51 PDT)

- **START 2026-06-22 13:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, post-batch QA sweep, finite issues
  tracker, site-round command, and this handoff ledger. Verified preview hub
  pids `15629` and `15671`, both rooted at
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found the current Codex prompt is still
  `hold / needs curated slice`: the queue is drained after the
  `/features/terminal` visual correction, and the post-batch QA sweep findings
  have not been released as a curated Codex fix slice. Claimed files: this
  ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
- **END 2026-06-22 13:51 PDT:** QUEUE DRAINED / HOLD. No public-site source
  files were changed and no build/browser QA was run because no route was
  touched. The latest public-site source-change commit remains `0126856906`
  (`frontend/public: calm terminal feature page layout`), with the latest
  coordination commit before this run `c1b706cab8` (`agents: log held
landing-page scheduled run`). The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude's terminal audit, a curated fix slice
  from the post-batch QA sweep, or for Blaec/Claude to release another bounded
  queue item.

### Codex - scheduled landing-page improvement loop hold (2026-06-22 13:45 PDT)

- **START 2026-06-22 13:45 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, post-batch QA sweep, finite issues
  tracker, and this handoff ledger. Verified preview hub pids `15629` and
  `15671`, both rooted at `/home/user/cocalc-ai-synthesis/src`; no active
  static build/watch process was observed. Targeted queue check found the
  current Codex prompt is still `hold`: queue drained after the
  `/features/terminal` visual correction, with explicit instructions not to
  forage raw QA findings, pricing/compliance, protected home, type/palette
  work, support-alert token/palette follow-up, stale dedicated-compute work,
  feature-page redesigns, or the dedicated-compute draft. Claimed files: this
  ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
- **END 2026-06-22 13:45 PDT:** QUEUE DRAINED / HOLD. No public-site source
  files were changed and no build/browser QA was run because no route was
  touched. The latest public-site source-change commit remains `0126856906`
  (`frontend/public: calm terminal feature page layout`), with the latest
  coordination commit before this run `feff000d92` (`agents: log drained
landing-page scheduled run`). The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude's terminal audit, a curated fix slice
  from the post-batch QA sweep, or for Blaec/Claude to release another bounded
  queue item.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 13:40 PDT)

- **START 2026-06-22 13:40 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, website operating system,
  frozen Brief, public-site skill, site quality regimen, post-batch QA sweep,
  and this handoff ledger. Verified preview hub pids `15629` and `15671`,
  both rooted at `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch process was observed. Targeted queue check found no released
  Codex item: Claude's current status still says the `/features/terminal`
  visual correction has landed and the next step is Claude's audit or a
  curated non-language feature-detail design-system slice. The fresh
  post-batch QA sweep contains low-severity findings, but the standing regimen
  says findings must become curated fix slices before Codex edits them.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, support-alert token follow-up, stale dedicated-compute
  work, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 13:40 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `0126856906`
  (`frontend/public: calm terminal feature page layout`), with the latest
  handoff commit `d2ad8d4154` (`agents: log terminal visual correction
handoff`) already matching origin before this ledger update. The known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's terminal visual/source audit,
  a curated fix slice from the post-batch QA sweep, or Blaec/Claude to release
  another bounded queue item.

---

### Codex - terminal visual system correction (START 2026-06-22 13:30 PDT)

- **Task:** respond to Blaec's screenshot feedback that `/features/terminal`
  visually looks bad and that non-language feature pages lack a consistent
  design system. Apply one bounded visual/structure pass to `/features/terminal`
  only; treat broader feature-page consistency as the next curated slice.
- **Worktree / Branch:** `/home/user/cocalc-ai-synthesis` /
  `blaec-synthesis-2026-06-18`.
- **Preview owner this turn:** YES. Verified hub pids `15629` and `15671`,
  both rooted at `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch process observed.
- **Claimed files/routes:** `/features/terminal` only:
  `src/packages/frontend/public/features/terminal-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`.
- **Route frame:** feature detail; visitor = technical user/champion; question =
  "Can shell work live inside the shared project without turning the page into
  a decorative mockup?"; promise = a real Linux terminal anchored to project
  files and review context; proof = `.term` file location, shared terminal
  stream, split panes/output handling, and nearby Linux/Jupyter paths; primary
  next step = create account/open projects; secondary = terminal guide and
  related feature pages.
- **Evidence / hypothesis:** human screenshot feedback plus source inspection
  show the terminal page has a heavy bespoke hero mock and one-off visual
  treatment. Hypothesis: a calmer text-first hero, lighter route-owned proof,
  and the shared `FeatureFinalBand` pattern will make the page feel more like
  the rest of the site without broad feature-page churn.
- **Do not touch:** protected `home/**`, pricing/compliance, docs content,
  pitch docs, type/palette/token lanes, other feature pages, raw audit
  foraging, support-alert follow-up, or the untracked
  `dedicated-compute-page.tsx` draft.
- **Validation required:** focused feature Jest/browser-QA harness, frontend
  lint, static build, desktop+mobile browser QA/screenshot inspection for
  `/features/terminal`, source commit, preview rebuild, shared-log handoff.
- **END 2026-06-22 13:36 PDT:** Source fix landed in `0126856906`
  (`frontend/public: calm terminal feature page layout`). `/features/terminal`
  now uses a text-first hero with a compact `ContextList`, shared `StoryCard`
  proof cards, a lower route-specific terminal evidence panel, and the shared
  `FeatureFinalBand` closing pattern. Removed the heavy bespoke hero mock plus
  the custom `.term` and shared-stream diagram components. Validation:
  Prettier passed on touched public-site files; `git diff --check` passed;
  package-level focused Jest passed 100/100 for
  `public/features/__tests__/app.test.tsx` (with existing React/antd jsdom
  act/getComputedStyle warnings); browser-QA harness Jest passed 5/5; `pnpm -C
src lint:frontend` passed; `pnpm -C src/packages/static build:dev` passed
  before commit and again after source commit from git revision `0126856906`
  with the existing local debug-log permission warning only; final browser QA
  for `/features/terminal` desktop+mobile passed 48/48 with screenshots/results
  at `/tmp/cocalc-public-qa-ORYoLS`. Screenshot inspection: desktop and mobile
  are readable, no text overflow, hero no longer dominated by the custom mock,
  and the final CTA/related-links band stays coherent. The top-level
  `pnpm -C src test ...` wrapper was not usable because its doc-url precheck
  fails before Jest with missing Python module `requests`; package-level Jest
  was used instead. Protected home, pricing/compliance, docs content,
  palette/type lanes, other feature pages, and the untracked
  `dedicated-compute-page.tsx` draft stayed untouched. Remaining product/design
  issue: non-language feature pages still need a curated design-system slice;
  do not continue page-by-page one-off redesigns without Blaec/Claude releasing
  that slice.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 13:26 PDT)

- **START 2026-06-22 13:26 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, post-batch QA sweep, finite issues
  tracker, and this handoff ledger. Verified hub pids `15629` and `15671`
  serve `/home/user/cocalc-ai-synthesis/src`; no active static build/watch
  process was observed. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update. Targeted
  queue check found no new released Codex item: Claude's current status still
  says the autonomous queue is drained after the `/features/terminal`
  improvement and Claude should re-audit or run the standing adversarial +
  drift sweep next. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, public-route source edits, raw-audit foraging,
  support-alert token follow-up, stale dedicated-compute work, or the
  untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 13:26 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `6d77bc7db4`
  (`frontend/public: sharpen terminal feature page`), with the latest handoff
  commit `3b6e4e54f8` (`agents: log terminal feature handoff`) already pushed
  to origin before this no-op. This turn updates only coordination artifacts.
  The known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Claude's terminal re-audit / standing
  adversarial + drift sweep or for Blaec/Claude to release a new curated queue
  item.

---

### Codex - terminal feature improvement (START 2026-06-22 13:13 PDT)

- **Task:** apply the released `/features/terminal` improvement from Claude's
  live board: sharpen the hero around a project-anchored Linux terminal,
  reduce the `.term` section repetition, rename the terminal-fit section, and
  verify the shared-stream labels.
- **Worktree / Branch:** `/home/user/cocalc-ai-synthesis` /
  `blaec-synthesis-2026-06-18`.
- **Preview owner this turn:** YES. Verified hub pids `15629` and `15671`,
  both rooted at `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch process observed. Branch matched
  `origin/blaec-synthesis-2026-06-18` before this start update.
- **Claimed files/routes:** `/features/terminal` only:
  `src/packages/frontend/public/features/terminal-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`,
  `src/.agents/public-site-framing-workplan-2026-06-20.md`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`.
- **Route frame:** feature detail; visitor = technical user or champion;
  question = "Can terminal work stay attached to the shared project instead of
  disappearing into a private browser tab?"; promise = a real Linux shell that
  opens where the project work lives; proof = `.term` file location,
  collaborative stream, split panes, output handling, and related Linux/Jupyter
  paths; primary next step = create account/open projects; secondary =
  terminal guide and related feature pages.
- **Decision / hypothesis:** redesign copy only: make the hero concrete,
  cut repeated `.term` bullets, and rename the fit section so the page reads
  tool-forward and at-a-glance while preserving proof.
- **Do not touch:** protected `home/**`, pricing/compliance, docs content,
  pitch docs, type/palette/token lanes, other feature pages, raw audit
  foraging, support-alert follow-up, or the untracked
  `dedicated-compute-page.tsx` draft.
- **Validation required:** focused feature Jest/browser canaries,
  `lint:frontend`, static build, desktop+mobile browser QA/screenshot
  inspection for `/features/terminal`, source commit, preview rebuild, and
  shared-log handoff.
- **END 2026-06-22 13:18 PDT:** Source fix landed in `6d77bc7db4`
  (`frontend/public: sharpen terminal feature page`). `/features/terminal` now
  leads with "A Linux terminal that lives in your project.", the `.term`
  section explains folder co-location with two distinct bullets, and the
  closing fit section is "Where the terminal earns its place." The
  `SharedStreamDiagram` label was already `Codex`, so no label code change was
  needed. Validation before source commit: `git diff --check` passed; focused
  Jest `public/features/__tests__/app.test.tsx` passed 100/100; browser-QA
  harness Jest passed 5/5; `pnpm -C src lint:frontend` passed;
  `pnpm -C src/packages/static build:dev` passed with the existing local
  debug-log permission warning only; browser QA for `/features/terminal`
  desktop+mobile passed 48/48 with screenshots/results at
  `/tmp/cocalc-public-qa-40Ewqn`. Screenshot inspection: desktop and mobile
  hero/sections fit without overflow; shared-stream labels read Researcher,
  Student, Codex; protected home, pricing, docs content, palette/type lanes,
  other feature pages, and the untracked `dedicated-compute-page.tsx` draft
  stayed untouched. Final post-commit preview rebuild from git revision
  `6d77bc7db4` passed, and final `/features/terminal` desktop+mobile browser
  QA passed 48/48 with screenshots/results at `/tmp/cocalc-public-qa-Le4UiQ`.

---

### Codex — consolidated adversarial fix slice (START 2026-06-22 10:46 PDT)

- **Task:** apply `/home/user/cocalc-shared/consolidated-fix-slice-2026-06-22.md`
  in three bounded commits: copy de-stamp + v3 hero subheads, Python
  `FeatureFinalBand`, then CTA normalization + a11y cleanup.
- **Worktree / Branch:** `/home/user/cocalc-ai-synthesis` /
  `blaec-synthesis-2026-06-18`.
- **Preview owner this turn:** YES. Verified hub pid `13303`, cwd
  `/home/user/cocalc-ai-synthesis/src`; no active static/build process observed.
- **Claimed files/routes:** public feature/product/guide/docs/support copy
  surfaces named by the consolidated slice; likely tests under
  `packages/frontend/public/features/__tests__/app.test.tsx`,
  `packages/frontend/public/__tests__/app.test.tsx`, and route-specific public
  tests; this ledger and `/home/user/cocalc-shared/codex-turn-log.md`.
- **Do not touch:** `packages/frontend/public/home/**`, footer/global chrome
  copy, pricing money/compliance claims, palette/type visual lanes, pitch docs,
  and the untracked `dedicated-compute-page.tsx` draft except as read-only
  context.
- **Validation required:** per commit focused Jest, `lint:frontend`, frontend
  build/typecheck as relevant, static preview rebuild, desktop+mobile browser
  QA screenshots for changed routes, push, rebuild preview, log completion.
- **Last commit:** `3521e3e9b2` before this slice.
- **Known risks:** worktree already had relevant uncommitted partial copy edits
  in docs/features/compare/guides/products/support; fold these into Commit 1 by
  correcting to the consolidated final text, not by reverting unrelated work.
- **END 2026-06-22 11:26 PDT:** QUEUE DRAINED for the consolidated
  adversarial-fix slice. Landed 3 bounded commits: copy de-stamp + v3 hero
  subheads (`643576e9c8`), Python `FeatureFinalBand` (`990b5fd97a`), and CTA
  normalization + a11y cleanup (`1c5f296324`). Validation: focused Jest
  `public/__tests__/app.test.tsx` + `public/features/__tests__/app.test.tsx` +
  `public/support/__tests__/app.test.tsx` passed during the slice; final
  focused feature/support run passed 106/106; `pnpm -C src lint:frontend`
  passed; `pnpm -C src/packages/static build:dev` passed; browser QA passed
  1176/1176 assertions on desktop+mobile for feature-details,
  conversion-spine, guides, and product-details. Screenshot/results artifact:
  `/tmp/cocalc-public-qa-2QS0eT`. Preview owner restored to synthesis hub pid
  `15671`, cwd `/home/user/cocalc-ai-synthesis/src`; `blaec.cocalc.ai`
  returns 200 and serves the rebuilt bundle at git revision `1c5f296324`.
  Known untracked draft `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  remains untouched. STOP: do not forage raw audits; wait for Claude audit or
  a new curated queue item.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 11:36 PDT)

- **START 2026-06-22 11:36 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, consolidated adversarial-fix slice,
  post-framing queue, finite issues tracker, active framing workplan, and this
  handoff ledger. Verified preview hub pid `15671` serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no released item: Claude's current
  status says the consolidated adversarial-fix slice is landed and the queue is
  drained pending Claude audit, the post-framing queue remains completed or
  held, the stale FS-001/dedicated-compute work remains held, and raw-audit
  foraging remains off limits. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 11:36 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `1c5f296324`
  (`frontend/public: normalize final CTAs and cleanup a11y`); this turn
  updates only coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's audit or for Blaec/Claude to
  release a new curated queue item or decide held items.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 11:41 PDT)

- **START 2026-06-22 11:41 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, working agreement, site quality regimen,
  consolidated adversarial-fix slice, preview run plan, synthesis AGENTS, and
  this handoff ledger. Verified preview hub pids `15629` and `15671` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no released item: Claude's current
  status still says the consolidated adversarial-fix slice is landed and the
  queue is drained pending Claude audit, the post-framing queue remains
  completed or held, the stale dedicated-compute draft remains out of scope,
  and raw-audit foraging remains off limits. Claimed files: this ledger only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, support-alert token follow-up, stale dedicated-compute
  work, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 11:41 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit on this branch remains
  `1c5f296324` (`frontend/public: normalize final CTAs and cleanup a11y`);
  this turn updates only coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's audit or for Blaec/Claude to
  release a new curated queue item or decide held items.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 11:46 PDT)

- **START 2026-06-22 11:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, consolidated adversarial-fix slice,
  post-framing queue, and this handoff ledger. Verified preview hub pids
  `15629` and `15671` serve `/home/user/cocalc-ai-synthesis/src`; no active
  static build/watch process was observed. Targeted queue check found no
  released item: Claude's current status still says the consolidated
  adversarial-fix slice is landed and the queue is drained pending Claude
  audit, the post-framing queue remains completed or held, pricing/home/palette
  items remain gated, the stale dedicated-compute draft remains out of scope,
  and raw-audit foraging remains off limits. Claimed files: this ledger only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, support-alert token follow-up, stale dedicated-compute
  work, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 11:46 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit on this branch remains
  `1c5f296324` (`frontend/public: normalize final CTAs and cleanup a11y`);
  this turn updates only coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's audit or for Blaec/Claude to
  release a new curated queue item or decide held items.

---

### Codex - features index headline fix (START 2026-06-22 11:53 PDT)

- **Task:** apply the queued features-index headline fix from Claude's live
  board after Blaec's "main feature pages are bad" feedback: replace the weak
  adjective-pile H1 with "Keep the whole job in one durable project."
- **Worktree / Branch:** `/home/user/cocalc-ai-synthesis` /
  `blaec-synthesis-2026-06-18`.
- **Preview owner this turn:** YES. Verified hub pids `15629` and `15671`, both
  cwd `/home/user/cocalc-ai-synthesis/src`; no active static build/watch
  process observed.
- **Claimed files/routes:** `/features` only:
  `packages/frontend/public/features/app.tsx`,
  `packages/frontend/public/features/__tests__/app.test.tsx`,
  `packages/frontend/scripts/public-site-browser-qa.mjs`, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`.
- **Do not touch:** protected `home/**`, pricing/compliance, type/palette,
  pitch docs, docs route content, feature detail pages beyond this H1 canary,
  raw-audit foraging, or the untracked `dedicated-compute-page.tsx` draft.
- **Validation required:** focused features Jest, `lint:frontend`,
  `packages/static build:dev`, browser QA/screenshot for `/features`
  desktop+mobile, commit, push, and handoff log.
- **END 2026-06-22 11:52 PDT:** Source fix landed in
  `5a66628ca1` (`frontend/public: sharpen features index headline`): `/features`
  H1 now reads "Keep the whole job in one durable project."; the supporting
  sentence, page structure, route grouping, and protected home stayed
  untouched. Validation before source commit: `git diff --check` passed;
  focused Jest `public/features/__tests__/app.test.tsx` +
  `public/__tests__/public-site-browser-qa-script.test.ts` passed 105/105
  with existing React/AntD jsdom warnings; `pnpm -C src lint:frontend` passed;
  `pnpm -C src/packages/static build:dev` passed; browser QA for `/features`
  desktop+mobile passed 52/52 assertions with screenshots/results at
  `/tmp/cocalc-public-qa-ShXlDS`. Desktop/mobile screenshot inspection:
  headline fits, no overflow, page rhythm unchanged. Known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft
  remains untouched. Final preview rebuild after the handoff closeout passed
  from git revision `a9899e4b01` with the existing local debug-log permission
  warning only; final `/features` browser QA passed 52/52 desktop+mobile at
  `/tmp/cocalc-public-qa-dNnosJ`. Next: push, then Claude runs the standing
  adversarial + drift sweep.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 12:11 PDT)

- **START 2026-06-22 12:11 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, post-framing queue, active framing
  workplan, and this handoff ledger. Verified preview hub pids `15629` and
  `15671`, both cwd `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch process observed. Targeted queue check found no released Codex
  item after the `/features` H1 fix: Claude's current status still says the
  autonomous Codex queue is drained and that Claude should run the standing
  adversarial + drift sweep next. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit
  foraging, support-alert token follow-up, stale dedicated-compute work,
  feature-page redesigns, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 12:11 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `5a66628ca1`
  (`frontend/public: sharpen features index headline`); this turn updates only
  coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's standing adversarial + drift
  sweep or for Blaec/Claude to release a new curated queue item.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 12:21 PDT)

- **START 2026-06-22 12:21 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, finite issues tracker, post-framing
  queue, consolidated adversarial-fix slice, and this handoff ledger. Verified
  preview hub pids `15629` and `15671`, both cwd
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  observed. Targeted queue check found no released Codex item after the
  `/features` H1 fix: Claude's current status still says the autonomous Codex
  queue is drained and that Claude should run the standing adversarial + drift
  sweep next. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit
  foraging, support-alert token follow-up, stale dedicated-compute work,
  feature-page redesigns, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 12:21 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `5a66628ca1`
  (`frontend/public: sharpen features index headline`); this turn updates only
  coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's standing adversarial + drift
  sweep or for Blaec/Claude to release a new curated queue item.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 12:40 PDT)

- **START 2026-06-22 12:40 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, site quality regimen, finite issues tracker, post-framing
  queue, consolidated adversarial-fix slice, active framing workplan, and this
  handoff ledger. Verified preview hub pids `15629` and `15671`, both cwd
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  observed. Targeted queue check found no released Codex item after the
  `/features` H1 fix: Claude's current status still says the autonomous Codex
  queue is drained and that Claude should run the standing adversarial + drift
  sweep next. The older FS-001 workplan still says in-progress, but the newer
  live board and turn log hold that stale dedicated-compute work out of scope.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, support-alert token follow-up, stale dedicated-compute
  work, feature-page redesigns, or the untracked `dedicated-compute-page.tsx`
  draft.
- **END 2026-06-22 12:40 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `5a66628ca1`
  (`frontend/public: sharpen features index headline`); this turn updates only
  coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's standing adversarial + drift
  sweep or for Blaec/Claude to release a new curated queue item.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 12:46 PDT)

- **START 2026-06-22 12:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, root website operating system, frozen Brief,
  public-site landing-page skill, site quality regimen, post-batch QA sweep,
  decisions log, and this handoff ledger. Verified preview hub pids `15629`
  and `15671`, with hub cwd `/home/user/cocalc-ai-synthesis/src`; no active
  static build/watch process observed. Branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update. Targeted
  queue check found no released Codex item after the `/features` H1 fix:
  Claude's current status says the autonomous Codex queue is drained and that
  Claude should run the standing adversarial + drift sweep next. The older
  post-batch QA sweep is not a current implementation queue and includes gated
  design-token/palette items; raw-audit foraging remains off limits. Claimed
  files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, support-alert token follow-up, stale dedicated-compute
  work, feature-page redesigns, or the untracked `dedicated-compute-page.tsx`
  draft.
- **END 2026-06-22 12:46 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `5a66628ca1`
  (`frontend/public: sharpen features index headline`); this turn updates only
  coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's standing adversarial + drift
  sweep or for Blaec/Claude to release a new curated queue item.

---

### Codex - scheduled landing-page improvement loop no-op (2026-06-22 12:56 PDT)

- **START 2026-06-22 12:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, root website operating system, frozen Brief,
  public-site landing-page skill, site quality regimen, post-framing queue,
  finite issues tracker, framing system, research register, and this handoff
  ledger. Verified preview hub pids `15629` and `15671`, both cwd
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  observed. Branch matched `origin/blaec-synthesis-2026-06-18` before this
  ledger update. Targeted queue check found no released Codex item after the
  `/features` H1 fix: Claude's current status says the autonomous Codex queue
  is drained and that Claude should run the standing adversarial + drift sweep
  next. The older post-framing/pricing/support-alert/dedicated-compute items
  remain completed, gated, or held unless curated into a fresh released slice.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, raw-audit foraging, support-alert token
  follow-up, stale dedicated-compute work, feature-page redesigns, or the
  untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 12:56 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `5a66628ca1`
  (`frontend/public: sharpen features index headline`); this turn updates only
  coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's standing adversarial + drift
  sweep or for Blaec/Claude to release a new curated queue item.

---

### Codex - features hero title layout fix (START 2026-06-22 13:04 PDT)

- **Task:** respond to Blaec's screenshot feedback that `/features` hero title
  "Keep the whole job in one durable project." is scrunched into the left side.
  Fix the hero title measure/layout without changing the approved headline or
  product claims.
- **Worktree / Branch:** `/home/user/cocalc-ai-synthesis` /
  `blaec-synthesis-2026-06-18`.
- **Preview owner this turn:** YES. Verified hub pids `15629` and `15671`, both
  rooted at `/home/user/cocalc-ai-synthesis/src`; branch matched
  `origin/blaec-synthesis-2026-06-18`; no active static build/watch process
  observed.
- **Claimed files/routes:** `/features` only:
  `src/packages/frontend/public/features/app.tsx`,
  `src/packages/frontend/scripts/public-site-browser-qa.mjs`, focused
  `/features` tests if needed, this ledger, and
  `/home/user/cocalc-shared/codex-turn-log.md`.
- **Route frame:** feature index; visitor = technical team/champion; question =
  "What work can my team keep together in one durable project?"; promise =
  durable multi-artifact project workspace; proof = grouped feature cards and
  overview visual; primary next step = Start on CoCalc.ai; secondary =
  Compare operating models; must not claim new capabilities, metrics, pricing,
  compliance, or category-collapse language.
- **Decision / hypothesis:** redesign the hero's responsive column measure so
  the H1 has enough horizontal room at desktop widths. Evidence is the user
  screenshot showing a cramped left-column headline; copy itself stays approved.
- **Do not touch:** protected `home/**`, pricing/compliance, docs content,
  pitch docs, type/palette/token lanes, feature detail pages, raw audit
  foraging, support-alert follow-up, or the untracked
  `dedicated-compute-page.tsx` draft.
- **Validation required:** focused `/features` Jest/browser canaries, frontend
  lint, static build, desktop+mobile browser QA/screenshot inspection for
  `/features`, commit, push, and shared-log handoff.
- **END 2026-06-22 13:12 PDT:** Source fix landed in `56261236b4`
  (`frontend/public: widen features hero headline measure`). `/features` hero
  no longer uses the stale two-column grid after the old right-side visual was
  removed; the approved H1 copy is unchanged, now capped at a wider balanced
  measure. Added a browser-QA guard that fails if the `/features` hero regresses
  to `display: grid`. Validation: prettier passed on the touched files; focused
  Jest `public/features/__tests__/app.test.tsx` +
  `public/__tests__/public-site-browser-qa-script.test.ts` passed 105/105;
  `pnpm -C src lint:frontend` passed; `pnpm -C src/packages/static build:dev`
  passed; browser QA for `/features` desktop+mobile passed 56/56 with
  screenshots/results at `/tmp/cocalc-public-qa-89bQP7`. Screenshot inspection:
  desktop H1 now reads as a broad two-line title instead of being confined to
  the left column; mobile still fits without overflow. Protected home, pricing,
  docs content, palette/type lanes, feature detail pages, and the untracked
  `dedicated-compute-page.tsx` draft stayed untouched. Final post-closeout
  rebuild from git revision `13590b8824` passed, and final `/features`
  desktop+mobile browser QA passed 56/56 with screenshots/results at
  `/tmp/cocalc-public-qa-Myu5Rt`.

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
- **START/END Wave-3 Sage 2026-06-22:** Assessed `/features/sage` as a clean
  custom `FeatureFinalBand` rewrite. Converted the hand-rolled final CTA panel
  to the shared band, preserving Sage-specific proof: SageMath notebooks,
  terminals, LaTeX documents, SageTeX, supporting files, research/teaching use,
  course environments, and SageMath community/team roots. No protected home,
  pitch docs, docs content/routes, pricing/compliance, type/palette, or
  dedicated-compute draft touched. Validation passed: `git diff --check`;
  focused feature Jest 99/99; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev`; browser QA on `/features/sage` desktop+mobile
  passed 38/38. Screenshots inspected from `/tmp/cocalc-public-qa-gv6LKO`;
  mobile order is fit proof, primary CTA, then Related.

---

## Codex — post-framing P0 support ticket headings (2026-06-22)

- **START 2026-06-22:** Working in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Scope is the first post-framing punch-list item
  only: make support ticket subjects semantic headings in
  `src/packages/frontend/public/support/tickets-view.tsx` and update the focused
  ticket-view test. Guardrails: preserve visual weight and ticket fallback text;
  no protected home, pitch docs, docs content/routes, pricing/compliance,
  type/palette work, feature-page work, or dedicated-compute draft. Known
  unrelated untracked file remains
  `src/packages/frontend/public/features/dedicated-compute-page.tsx`.
- **END 2026-06-22:** Replaced the rendered support-ticket subject `div` with a
  semantic `h2` while preserving the existing 18px/bold visual treatment and
  fallback label. Updated `tickets-view.test.tsx` to assert the ticket subject
  by heading role and level. Validation passed: `git diff --check`; focused
  support + QA harness Jest 13/13; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev`; browser QA on `/support` and `/support/tickets`
  desktop+mobile passed 58/58. Screenshots inspected from
  `/tmp/cocalc-public-qa-3oy0dt`.

---

## Codex — post-framing P1 proof-surface CTA consistency (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  slice 2 only: make the AI feature hero docs-first by promoting `Read the Codex
guide` and demoting the account/projects CTA in that hero, and route the
  Automations hero `CoCalc CLI` button to the sibling `/features/cli` page.
  Claimed files: `features/ai-page.tsx`, `features/automations-page.tsx`,
  `features/__tests__/app.test.tsx`, `scripts/public-site-browser-qa.mjs`, and
  this ledger. Guardrails: preserve concrete proof and page layouts; no
  protected home, pitch docs, docs content/routes, pricing/compliance,
  type/palette work, feature final-band rollout, or dedicated-compute draft.
- **END 2026-06-22:** Promoted `Read the Codex guide` to the AI hero's primary
  action, kept account/project access as a secondary hero action and primary
  closing conversion action, and routed Automations' `CoCalc CLI` hero button to
  `/features/cli`. Updated feature and browser-QA canaries for both decisions,
  including a narrow AI exception to the single-primary-destination guardrail
  because this proof-surface page intentionally has docs-primary hero plus final
  conversion. Validation passed: `git diff --check`; focused feature + QA
  harness Jest 104/104; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev`; browser QA on `/features/ai` and
  `/features/automations` desktop+mobile passed 86/86. Screenshots inspected
  from `/tmp/cocalc-public-qa-vRXSoX`.

---

## Codex — post-framing P1 Linux agent claim grounding (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  slice 3 only: adjust the Linux page's agent/package-install paragraph so it is
  assistive and user-bounded, not a guarantee of autonomous diagnosis/execution.
  Claimed files: `features/linux-page.tsx`, `features/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, and this ledger. Guardrails: preserve
  Linux package-manager/tool proof and layout; no protected home, pitch docs,
  docs content/routes, pricing/compliance, type/palette work, final-band rollout,
  or dedicated-compute draft.
- **END 2026-06-22:** Replaced the Linux agent paragraph with bounded assistive
  language: Codex can help read errors, suggest a layer, and propose a command
  or verification check; the user decides what runs. Preserved the surrounding
  package-manager proof and layout. Updated feature and browser-QA canaries to
  require `You decide what runs` and forbid the old `and running the command`
  phrase. Validation passed: `git diff --check`; focused feature + QA harness
  Jest 104/104; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev`; browser QA on `/features/linux` desktop+mobile
  passed 42/42. Screenshots inspected from `/tmp/cocalc-public-qa-ptFW0V`.

---

## Codex — post-framing P2 final CTA label consistency (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  the final-CTA wording consistency slice for Terminal, Linux, Jupyter, and
  LaTeX. Source inspection showed Terminal/Linux/LaTeX already have
  feature-specific unauthenticated final labels and authenticated `Open
projects`; Jupyter still reuses `Create account` in the final section. Claimed
  files: `features/jupyter-notebook-page.tsx`,
  `features/__tests__/app.test.tsx`, `scripts/public-site-browser-qa.mjs`, and
  this ledger. Guardrails: preserve technical proof, layout, and authenticated
  behavior; no protected home, pitch docs, docs content/routes,
  pricing/compliance, type/palette work, final-band rollout, or
  dedicated-compute draft.
- **END 2026-06-22:** Added a Jupyter-specific unauthenticated final CTA label:
  `Start using Jupyter in CoCalc`. Left Terminal, Linux, and LaTeX unchanged
  because they already had feature-specific final labels; left authenticated
  behavior as `Open projects`. Updated feature and browser-QA canaries for the
  new Jupyter label. Validation passed: `git diff --check`; focused feature +
  QA harness Jest 104/104; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev`; browser QA on `/features/terminal`,
  `/features/linux`, `/features/jupyter-notebook`, and `/features/latex-editor`
  desktop+mobile passed 162/162. Screenshots inspected from
  `/tmp/cocalc-public-qa-Gd3jP7`.

---

## Codex — post-framing P2 Whiteboard slide-deck dedup (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  the Whiteboard duplicate SlideDeckSection cleanup only: preserve the
  `slide-decks` anchor and wayfinding to Slides/Teaching, remove the duplicated
  full `SlideDeckMock` and parallel slide-deck pitch from the Whiteboard page,
  and leave the Whiteboard hero, execution graph, final band, and slides page
  untouched. Claimed files: `features/whiteboard-page.tsx`,
  `features/__tests__/app.test.tsx`, `scripts/public-site-browser-qa.mjs`, and
  this ledger. Guardrails: preserve concrete whiteboard proof and layout; no
  protected home, pitch docs, docs routes/content, pricing/compliance,
  type/palette work, or dedicated-compute draft.
- **END 2026-06-22:** Replaced the duplicated Whiteboard slide-deck mock section
  with a concise pointer that preserves the `slide-decks` anchor, keeps the
  `More about slide decks` and `Teaching` wayfinding buttons, and links users to
  the canonical Slides route for the full deck workflow. Removed the unused
  `SlideDeckMock` import. Updated feature and browser-QA canaries, including a
  guard that the slide mock label/text does not return on Whiteboard. Validation
  passed: `git diff --check`; focused feature + QA harness Jest 104/104; `pnpm
-C src lint:frontend`; `pnpm -C src/packages/static build:dev`; browser QA on
  `/features/whiteboard` and `/features/slides` desktop+mobile passed 76/76.
  Screenshots inspected from `/tmp/cocalc-public-qa-W3o2qG`.

---

## Codex — post-framing P2 Products CTA/link consistency (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  the Products page CTA/link consistency slice only: remove the redundant
  overview `Compare CoCalc fit` hero link, rename product-detail cross-links
  that route to detail pages from `Compare with X` to `View CoCalc X`, and
  remove the duplicate Rocket primary CTA from the secondary planning card while
  keeping the lead primary CTA. Claimed files: `products/app.tsx`,
  `public/__tests__/app.test.tsx`, `scripts/public-site-browser-qa.mjs`, and
  this ledger. Guardrails: preserve product proof and all pricing/licensing
  links; do not touch Rocket deployment claims, protected home, pitch docs,
  docs routes/content, pricing/compliance, type/palette work, or the untracked
  dedicated-compute draft.
- **END 2026-06-22:** Products CTA/link consistency implemented and validated.
  Removed the redundant overview `Compare CoCalc fit` link, changed product
  detail cross-links that route to detail pages to `View CoCalc X`, and removed
  the duplicate Rocket support CTA from the secondary planning card while
  preserving the lead `Talk with CoCalc about Rocket` primary action.
  Rocket deployment-claim wording was intentionally left untouched for the
  separate claim-safety slice. Updated public app tests and browser-QA guards so
  the old comparison labels cannot return. Validation passed: `git diff
--check`; focused public app + browser-QA harness Jest 43/43; `pnpm -C src
lint:frontend`; `pnpm -C src/packages/static build:dev`; browser QA on
  `/products`, `/products/cocalc-plus`, `/products/cocalc-star`,
  `/products/cocalc-launchpad`, and `/products/cocalc-rocket` desktop+mobile
  passed 200/200. Screenshots inspected from `/tmp/cocalc-public-qa-Wmvuxx`.

---

## Codex — post-framing P2 Rocket deployment-claim safety (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  only the Rocket `How it runs` deployment-claim wording: replace the
  unsupported `preferred packaging is VM-first` claim with neutral VM/Kubernetes
  options language, preserving Rocket positioning, CTAs, product proof, and all
  product routes. Claimed files: `products/app.tsx`,
  `public/__tests__/app.test.tsx`, `scripts/public-site-browser-qa.mjs`, and
  this ledger. Guardrails: no protected home, pitch docs, docs routes/content,
  pricing/compliance, type/palette work, or the untracked dedicated-compute
  draft.
- **END 2026-06-22:** Rocket claim-safety wording implemented and validated.
  Replaced the unsupported `preferred packaging is VM-first` language with a
  neutral, source-grounded options statement: Rocket is available as a VM
  deployment or on Kubernetes depending on the organization's infrastructure.
  Updated public app and browser-QA canaries to require the new wording and
  forbid `preferred packaging`. Validation passed: `git diff --check`; focused
  public app + browser-QA harness Jest 43/43; `pnpm -C src lint:frontend`;
  `pnpm -C src/packages/static build:dev`; browser QA on
  `/products/cocalc-rocket` desktop+mobile passed 40/40. Screenshots inspected
  from `/tmp/cocalc-public-qa-TWYx1B`.

---

## Codex — post-framing P2 Guides CTA label consistency (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  only `/guides` duplicate CTA-label normalization: use one label for the guide
  library destination and one label for the docs destination across the hero and
  task-finder section, preserving hrefs, guide cards, layout, and route proof.
  Claimed files: `guides/app.tsx`, `public/__tests__/app.test.tsx`,
  `scripts/public-site-browser-qa.mjs`, and this ledger. Guardrails: no
  protected home, pitch docs, docs routes/content, pricing/compliance,
  type/palette work, product pages, or the untracked dedicated-compute draft.
- **END 2026-06-22:** Guides CTA labels normalized and validated. The guide
  library destination now uses `Open all guides` in both the hero and task
  finder; the docs destination uses `Browse docs` in both places. Hrefs,
  guide cards, layout, and route proof were preserved. Updated public app tests
  to assert both repeated labels point to the same destinations and browser-QA
  rules to forbid the old `Full guide library` / `Reference docs` labels.
  Validation passed: `git diff --check`; focused public app + browser-QA
  harness Jest 43/43; `pnpm -C src lint:frontend`; `pnpm -C
src/packages/static build:dev`; browser QA on `/guides` desktop+mobile passed
  60/60. Screenshots inspected from `/tmp/cocalc-public-qa-13mPlu`.

---

## Codex — post-framing P2 Talk-with-CoCalc CTA wording (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  only the site-wide CTA wording normalization from `Talk to CoCalc` to the
  canonical `Talk with CoCalc` in the shared closing band and home closing band,
  plus the matching home test expectation. Claimed files:
  `src/packages/frontend/public/common.tsx`,
  `src/packages/frontend/public/home/app.tsx`,
  `src/packages/frontend/public/home/__tests__/app.test.tsx`, and this ledger.
  Guardrails: preserve hrefs, layout, route structure, and protected home hero;
  no pitch docs, docs routes/content, pricing/compliance, type/palette work,
  feature/product pages, or the untracked dedicated-compute draft.
- **END 2026-06-22:** CTA wording normalization implemented and validated.
  Changed the shared `PublicNextStep` closing-band support CTA and home closing
  CTA from `Talk to CoCalc` to the canonical `Talk with CoCalc`, preserving the
  `/support` hrefs and all surrounding layout. Updated the home test
  expectation; `rg` confirms the old phrase is gone from public source and
  browser-QA rules. Validation passed: `git diff --check`; focused home +
  public app Jest 40/40 (with existing React/AntD act warnings); `pnpm -C src
lint:frontend`; `pnpm -C src/packages/static build:dev`; browser QA on the
  conversion spine desktop+mobile passed 264/264, and direct common-component
  routes `/guides`, `/about`, `/news`, `/policies`, `/support/community`
  desktop+mobile passed 148/148. Screenshots inspected from
  `/tmp/cocalc-public-qa-jU1SnF` and `/tmp/cocalc-public-qa-1JHK87`.

---

## Codex — post-framing P3 feature-page density cleanup (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  only the residual idea-repetition slice for `/features/terminal`,
  `/features/latex-editor`, and `/features/jupyter-notebook`: trim repeated
  prose while preserving each page's concrete workflow proof, structure, CTAs,
  and routes. Claimed files:
  `src/packages/frontend/public/features/terminal-page.tsx`,
  `src/packages/frontend/public/features/latex-editor-page.tsx`,
  `src/packages/frontend/public/features/jupyter-notebook-page.tsx`,
  focused feature tests/browser-QA canaries if needed, and this ledger.
  Guardrails: no protected home, pitch docs, docs routes/content,
  pricing/compliance, type/palette work, product pages, or the untracked
  dedicated-compute draft.
- **END 2026-06-22:** Feature-page density cleanup implemented and validated.
  Trimmed repeated agent-readable terminal context from the Terminal hero and
  terminal-path bullet while preserving the concrete agent-context proof in the
  heavy-output section. Reworked the LaTeX working-tree and computation-writing
  paragraphs so they advance collaboration and rebuild/review outcomes instead
  of restating the project premise. Replaced Jupyter's repeated browser-tab
  framing in the `Keep runs alive` story card with durable run/output review
  wording. Added browser-QA forbidden-text canaries for the removed phrases.
  Validation passed: `git diff --check`; focused feature Jest 99/99 (with
  existing React/AntD jsdom warnings); browser-QA script Jest 5/5; `pnpm -C src
lint:frontend`; `pnpm -C src/packages/static build:dev`; browser QA on
  `/features/terminal`, `/features/latex-editor`, and
  `/features/jupyter-notebook` desktop+mobile passed 130/130. Mobile
  screenshots inspected from `/tmp/cocalc-public-qa-z8ynBQ`.

---

## Codex — post-framing P3 compare table mobile a11y orientation (2026-06-22)

- **START 2026-06-22:** Continuing the post-framing queue in
  `/home/user/cocalc-ai-synthesis` on `blaec-synthesis-2026-06-18`. Scope is
  only the low-priority compare decision-table accessibility polish: preserve
  the existing responsive stacked layout and `data-label` semantics while
  adding assistive orientation for the mobile table structure. Claimed files:
  `src/packages/frontend/public/features/compare-page.tsx`,
  `src/packages/frontend/public/features/__tests__/app.test.tsx`, focused
  browser-QA canaries if needed, and this ledger. Guardrails: no pricing page,
  protected home, pitch docs, docs routes/content, compliance/trust claims,
  type/palette work, product pages, or the untracked dedicated-compute draft.
- **END 2026-06-22:** Compare table mobile a11y orientation implemented and
  validated. Added a visually hidden caption to the compare decision table,
  connected it with `aria-describedby`, and kept the existing responsive
  stacked layout plus `data-label` visible column labels unchanged. Updated the
  focused compare test to assert the table description wiring and mobile
  orientation text. Validation passed: `git diff --check`; focused feature Jest
  99/99 after fixing the local test variable; `pnpm -C src lint:frontend`;
  `pnpm -C src/packages/static build:dev`; browser QA on `/features/compare`
  desktop+mobile passed 42/42. Mobile screenshot inspected from
  `/tmp/cocalc-public-qa-iEY4lo`; no visible layout change from the hidden
  caption.

---

## Codex — support ticket alert tokenization (2026-06-22)

- **START 2026-06-22:** Scheduled landing-page improvement loop found one
  remaining current, non-protected P0 from the master audit: `/support/tickets`
  alert boxes still use hardcoded Ant Design hex colors for error/info states.
  Scope is only tokenizing those alert colors through the public design system
  while preserving behavior, copy, layout, and the existing ticket heading
  semantics. Claimed files: `src/packages/frontend/public/theme.ts`,
  `src/packages/frontend/public/support/tickets-view.tsx`,
  `src/packages/frontend/public/support/tickets-view.test.tsx`,
  focused browser-QA canaries if needed, and this ledger. Guardrails: no
  protected home, pricing/compliance, pitch docs, docs routes/content,
  type/palette restyle, product/feature pages, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22:** Support ticket alert tokenization implemented and
  validated. Added public `error*` and `info*` color tokens, replaced the
  `/support/tickets` Alert component's hardcoded error/info hex literals with
  those tokens, and added a focused regression test for both alert states. Text
  contrast checks passed manually: error 4.87:1, info 6.03:1. Validation passed:
  `git diff --check`; focused support Jest 9/9; `pnpm -C src lint:frontend`;
  `pnpm -C src/packages/static build:dev`; browser QA on `/support/tickets`
  desktop+mobile passed 22/22.
  Screenshots inspected from `/tmp/cocalc-public-qa-grXxB4`; no visible
  overflow or alert layout regression. Remaining holds unchanged: protected
  home, pricing/compliance, type/palette restyle, and the untracked
  dedicated-compute draft.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 02:46 PDT)

- **START 2026-06-22 02:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Read the shared INDEX, Claude current status,
  Codex turn log, and post-framing queue. Verified preview hub pid `13303`
  serves `/home/user/cocalc-ai-synthesis/src`. Claude's current status marks
  the curated Codex work queue as drained and explicitly says not to self-select
  from the raw 127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 02:46 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn adds only
  a coordination ledger commit. The branch is ahead of origin by five commits,
  and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, and decide whether any held pricing-page
  items or a new curated queue should be released.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 02:51 PDT)

- **START 2026-06-22 02:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue. Verified
  preview hub pid `13303` still serves `/home/user/cocalc-ai-synthesis/src`.
  Current shared status still says the curated Codex queue is drained and
  explicitly says not to self-select from the raw 127-finding audit. Claimed
  files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 02:51 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch remains ahead of origin by five
  commits before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 02:56 PDT)

- **START 2026-06-22 02:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue. Verified
  preview hub pid `13303` still serves `/home/user/cocalc-ai-synthesis/src`.
  Current shared status still says the curated Codex queue is drained and
  explicitly says not to self-select from the raw 127-finding audit. Claimed
  files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 02:56 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by six commits
  before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 03:06 PDT)

- **START 2026-06-22 03:06 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`. Current shared status still says the
  curated Codex queue is drained and explicitly says not to self-select from
  the raw 127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:06 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by seven commits
  before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 03:11 PDT)

- **START 2026-06-22 03:11 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`. Current shared status still says the
  curated Codex queue is drained and explicitly says not to self-select from
  the raw 127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:11 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by eight commits
  before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 03:26 PDT)

- **START 2026-06-22 03:26 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, site-round prompt, current
  handoff ledger, shared INDEX, Claude current status, Codex turn log, and
  post-framing queue. Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build was observed.
  Current shared status still says the curated Codex queue is drained and
  explicitly says not to self-select from the raw 127-finding audit. Claimed
  files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:26 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by nine commits
  before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support
  alert tokenization / palette-lane question, decide the held pricing-page
  items, or release a new curated queue.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 03:36 PDT)

- **START 2026-06-22 03:36 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status still says the curated Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:36 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by ten commits
  before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support
  alert tokenization / palette-lane question, decide the held pricing-page
  items, or release a new curated queue.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 03:41 PDT)

- **START 2026-06-22 03:41 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status still says the curated Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:41 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by eleven commits
  before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support
  alert tokenization / palette-lane question, decide the held pricing-page
  items, or release a new curated queue.

---

## Codex — scheduled landing-page improvement loop no-op (2026-06-22 03:46 PDT)

- **START 2026-06-22 03:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status still says the curated Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:46 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by twelve commits
  before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support
  alert tokenization / palette-lane question, decide the held pricing-page
  items, or release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 03:51 PDT)

- **START 2026-06-22 03:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, and post-framing queue.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status still says the curated Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:51 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by thirteen
  commits before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support
  alert tokenization / palette-lane question, decide the held pricing-page
  items, or release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 03:56 PDT)

- **START 2026-06-22 03:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, post-framing queue, and
  site-round prompt. Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status still says the autonomous Codex queue is
  drained and explicitly says not to self-select from the raw 127-finding
  audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 03:56 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by fourteen
  commits before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support
  alert tokenization / palette-lane question, decide the held pricing-page
  items, or release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:01 PDT)

- **START 2026-06-22 04:01 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, post-framing queue, and
  site-round prompt. Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status still says the autonomous Codex queue is
  drained and explicitly says not to self-select from the raw 127-finding
  audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:01 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of origin by fifteen
  commits before this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude on held decisions: accept or revert
  the protected-home portion of `b8388f8a41`, decide the off-queue support
  alert tokenization / palette-lane question, decide the held pricing-page
  items, or release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:05 PDT)

- **START 2026-06-22 04:05 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, current handoff ledger, shared
  INDEX, Claude current status, Codex turn log, post-framing queue, finite
  issues tracker, active workplan, and site-round prompt. Verified preview hub
  pid `13303` still serves `/home/user/cocalc-ai-synthesis/src`; no active
  static build/watch was observed. Current shared status still says the
  autonomous Codex queue is drained and explicitly says not to self-select from
  the raw 127-finding audit. The active workplan still mentions the old
  dedicated-compute draft path, but the live shared status explicitly forbids
  touching that draft. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:05 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was even with
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Blaec/Claude on held decisions: accept
  or revert the protected-home portion of `b8388f8a41`, decide the off-queue
  support alert tokenization / palette-lane question, decide the held
  pricing-page items, or release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:11 PDT)

- **START 2026-06-22 04:11 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, site-round prompt, shared INDEX,
  Claude current status, Codex turn log, post-framing queue, finite issues
  tracker, active workplan, and this handoff ledger. Verified preview hub pid
  `13303` still serves `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch was observed. Current shared status says the autonomous Codex
  queue is drained and explicitly says not to self-select from the raw
  127-finding audit. The active workplan still mentions the old
  dedicated-compute draft path, but the live shared status explicitly forbids
  touching that draft. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:11 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was even with
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:16 PDT)

- **START 2026-06-22 04:16 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, shared INDEX, Claude current
  status, Codex turn log, post-framing queue, finite issues tracker, active
  workplan, and this handoff ledger. Verified preview hub pid `13303` still
  serves `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit. The
  active workplan still mentions the old dedicated-compute draft path, but the
  live shared status explicitly forbids touching that draft. Claimed files:
  this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:16 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by one commit before this ledger update,
  and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:21 PDT)

- **START 2026-06-22 04:21 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, shared INDEX, Claude current status, Codex turn log,
  post-framing queue, and this handoff ledger. Verified preview hub pid
  `13303` still serves `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch was observed. Current shared status says the autonomous Codex
  queue is drained and explicitly says not to self-select from the raw
  127-finding audit. The active workplan still mentions the old
  dedicated-compute draft path, but the live shared status explicitly forbids
  touching that draft. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:21 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by two commits before this ledger update,
  and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:30 PDT)

- **START 2026-06-22 04:30 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, shared INDEX, Claude current
  status, Codex turn log, post-framing queue, active workplan, and this
  handoff ledger. Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit. The
  active workplan still mentions the old dedicated-compute draft path, but the
  live shared status explicitly forbids touching that draft. Claimed files:
  this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:30 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by three commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 11:58 PDT)

- **START 2026-06-22 11:58 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, site
  quality regimen, consolidated adversarial-fix slice, and this handoff
  ledger. Verified preview hub pids `15629` and `15671` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no released Codex item: Claude's
  current status says the queue is drained after the `/features` H1 fix and
  that Claude should run the standing adversarial + drift sweep next. Claimed
  files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette work,
  pitch docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, stale dedicated-compute work, feature-page redesigns, or
  the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 11:58 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `5a66628ca1`
  (`frontend/public: sharpen features index headline`); this turn updates only
  coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's standing adversarial + drift
  sweep or for Blaec/Claude to release a new curated queue item.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 12:06 PDT)

- **START 2026-06-22 12:06 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, site-round prompt, site
  quality regimen, post-framing queue, consolidated adversarial-fix slice, and
  this handoff ledger. Verified preview hub pids `15629` and `15671` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no released Codex item after the
  `/features` H1 fix: Claude's current status says the autonomous Codex queue
  is drained and that Claude should run the standing adversarial + drift sweep
  next. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette work, pitch docs, docs-route content,
  product/feature/support source edits, raw-audit foraging, stale
  dedicated-compute work, feature-page redesigns, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 12:06 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `5a66628ca1`
  (`frontend/public: sharpen features index headline`); this turn updates only
  coordination artifacts. The branch matched
  `origin/blaec-synthesis-2026-06-18` before this ledger update, and the known
  untracked `src/packages/frontend/public/features/dedicated-compute-page.tsx`
  draft is still untouched. Waiting for Claude's standing adversarial + drift
  sweep or for Blaec/Claude to release a new curated queue item.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:46 PDT)

- **START 2026-06-22 04:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, site-round prompt, shared INDEX,
  Claude current status, Codex turn log, post-framing queue, and this handoff
  ledger. Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit. The
  active workplan still mentions the old dedicated-compute draft path, but the
  live shared status explicitly forbids touching that draft. Claimed files:
  this ledger only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:46 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by four commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:51 PDT)

- **START 2026-06-22 04:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, shared INDEX, Claude current
  status, Codex turn log, post-framing queue, active workplan, finite issues
  tracker, site-round prompt, and this handoff ledger. Verified preview hub pid
  `13303` still serves `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch was observed. Current shared status says the autonomous Codex
  queue is drained and explicitly says not to self-select from the raw
  127-finding audit. The active workplan still mentions the old
  dedicated-compute draft path, but the live shared status explicitly forbids
  touching that draft. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:51 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by five commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 04:56 PDT)

- **START 2026-06-22 04:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the public-site guardrails, frozen
  Brief, operating system, public-site skill, shared INDEX, Claude current
  status, Codex turn log, post-framing queue, active workplan, finite issues
  tracker, and this handoff ledger. Verified preview hub pid `13303` still
  serves `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit. The
  active workplan still mentions the old dedicated-compute draft path, but the
  live shared status explicitly forbids touching that draft. Claimed files:
  this ledger and `/home/user/cocalc-shared/codex-turn-log.md` only.
  Guardrails: no protected home, pricing/compliance, type/palette/palette-token
  work, pitch docs, docs-route content, product/feature/support source edits,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 04:56 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by six commits before this ledger update,
  and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:01 PDT)

- **START 2026-06-22 05:01 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, and this handoff ledger.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:01 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by seven no-op ledger commits before
  this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:16 PDT)

- **START 2026-06-22 05:16 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, website operating system,
  frozen Brief, public-site skill, and this handoff ledger. Verified preview
  hub pid `13303` still serves `/home/user/cocalc-ai-synthesis/src`; no active
  static build/watch was observed. Current shared status says the autonomous
  Codex queue is drained and explicitly says not to self-select from the raw
  127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:16 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by eight no-op ledger commits before
  this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:20 PDT)

- **START 2026-06-22 05:20 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, and this
  handoff ledger. Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:20 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by nine no-op ledger commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:36 PDT)

- **START 2026-06-22 05:36 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue,
  finite issues tracker, framing docs, active workplan, site-round prompt, and
  this handoff ledger. Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:36 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by ten no-op ledger commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:41 PDT)

- **START 2026-06-22 05:41 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, and this handoff ledger.
  Verified preview hub pid `13303` still serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:41 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by eleven no-op ledger commits before
  this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:46 PDT)

- **START 2026-06-22 05:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue,
  finite issues tracker, active workplan, and this handoff ledger. Verified
  preview hub pids `13262` and `13303` still serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:46 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twelve no-op ledger commits before
  this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:51 PDT)

- **START 2026-06-22 05:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pids `13262` and `13303` still
  serve `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:51 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirteen no-op ledger commits before
  this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 05:56 PDT)

- **START 2026-06-22 05:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pids `13262` and `13303` still
  serve `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 05:56 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by fourteen no-op ledger commits before
  this ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:01 PDT)

- **START 2026-06-22 06:01 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, finite
  issues tracker, and this handoff ledger. Verified preview hub pids `13262`
  and `13303` still serve `/home/user/cocalc-ai-synthesis/src`; no active
  static build/watch was observed. Current shared status says the autonomous
  Codex queue is drained and explicitly says not to self-select from the raw
  127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:01 PDT:** QUEUE DRAINED. No public-site source files were
  changed and no build/browser QA was run because no route was touched. The
  latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by fifteen commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:06 PDT)

- **START 2026-06-22 06:06 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue,
  finite issues tracker, and this handoff ledger. Verified preview hub pids
  `13262` and `13303` still serve `/home/user/cocalc-ai-synthesis/src`; no
  active static build/watch was observed. Current shared status says the
  autonomous Codex queue is drained and explicitly says not to self-select
  from the raw 127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:06 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn
  updates only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by sixteen commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:11 PDT)

- **START 2026-06-22 06:11 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pid `13303` serves
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:11 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn
  updates only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by seventeen commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:16 PDT)

- **START 2026-06-22 06:16 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue,
  finite issues tracker, active workplan, and this handoff ledger. Verified
  preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:16 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn
  updates only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by eighteen commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:21 PDT)

- **START 2026-06-22 06:21 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, finite
  issues tracker, active workplan, and this handoff ledger. Verified preview
  hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit.
  Claimed files: this ledger and `/home/user/cocalc-shared/codex-turn-log.md`
  only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:21 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn
  updates only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by nineteen commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:26 PDT)

- **START 2026-06-22 06:26 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, finite
  issues tracker, framing system/research register/design docs, active
  workplan, and this handoff ledger. Verified preview hub pids `13262` and
  `13303` serve `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch was observed. Current shared status says the autonomous Codex
  queue is drained and explicitly says not to self-select from the raw
  127-finding audit. The older FS-001 workplan item remains stale/held by the
  current queue instructions. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:26 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:31 PDT)

- **START 2026-06-22 06:31 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch was
  observed. Current shared status says the autonomous Codex queue is drained
  and explicitly says not to self-select from the raw 127-finding audit. The
  post-framing queue remains completed or held; the dedicated-compute draft
  remains out of scope. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:31 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-one commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:36 PDT)

- **START 2026-06-22 06:36 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  post-framing queue, and this handoff ledger. Verified preview hub pids
  `13262` and `13303` both serve `/home/user/cocalc-ai-synthesis/src`; no
  active static build/watch process was observed. Current shared status still
  says the autonomous Codex queue is drained and explicitly says not to
  self-select from the raw 127-finding audit. The post-framing queue remains
  completed or held; the dedicated-compute draft remains out of scope. Claimed
  files: this ledger only. Guardrails: no protected home, pricing/compliance,
  type/palette/palette-token work, pitch docs, docs-route content,
  product/feature/support source edits, raw-audit foraging, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:36 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-two commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:41 PDT)

- **START 2026-06-22 06:41 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, finite issues tracker,
  multi-agent operating model, and this handoff ledger. Verified preview hub
  pid `13303` serves `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch process was observed. Current shared status still says the
  autonomous Codex queue is drained and explicitly says not to self-select from
  the raw 127-finding audit. The post-framing queue remains completed or held;
  the dedicated-compute draft remains out of scope. Claimed files: this ledger
  and `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette/palette-token work, pitch
  docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, or the untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:41 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-three commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:46 PDT)

- **START 2026-06-22 06:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, finite issues tracker,
  post-framing queue, active workplan, framing/design/decision docs,
  multi-agent operating model, and this handoff ledger. Verified preview hub
  pid `13303` serves `/home/user/cocalc-ai-synthesis/src`; no active static
  build/watch process was observed. Current shared status still says the
  autonomous Codex queue is drained and explicitly says not to self-select from
  the raw 127-finding audit. The post-framing queue remains completed or held;
  the dedicated-compute draft remains out of scope. Claimed files: this ledger
  and `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no
  protected home, pricing/compliance, type/palette/palette-token work, pitch
  docs, docs-route content, product/feature/support source edits,
  raw-audit foraging, support-alert token follow-up, stale FS-001 work, or the
  untracked `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:46 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-four commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:51 PDT)

- **START 2026-06-22 06:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, public-site guardrails, post-framing queue, Codex turn log, and this
  handoff ledger. Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Current shared status still says the autonomous Codex queue is
  drained and explicitly says not to self-select from the raw 127-finding
  audit. The post-framing queue remains completed or held; the
  dedicated-compute draft remains out of scope. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit
  foraging, support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:51 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-five commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 06:56 PDT)

- **START 2026-06-22 06:56 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, post-framing queue, and this
  handoff ledger. Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Current shared status still says the autonomous Codex queue is
  drained and explicitly says not to self-select from the raw 127-finding
  audit. The post-framing queue remains completed or held; the
  dedicated-compute draft remains out of scope. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit
  foraging, support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 06:56 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-six commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:01 PDT)

- **START 2026-06-22 07:01 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis operating docs, the
  frozen Brief, public-site skill, and this handoff ledger. Verified preview
  hub pids `13262` and `13303` serve `/home/user/cocalc-ai-synthesis/src`; no
  active static build/watch process was observed. Current shared status still
  says the autonomous Codex queue is drained and explicitly says not to
  self-select from the raw 127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:01 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-seven commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:11 PDT)

- **START 2026-06-22 07:11 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, public-site guardrails, synthesis AGENTS, website operating system,
  frozen Brief, public-site skill, and this handoff ledger. Verified preview
  hub pids `13262` and `13303` serve `/home/user/cocalc-ai-synthesis/src`; no
  active static build/watch process was observed. Current shared status still
  says the autonomous Codex queue is drained and explicitly says not to
  self-select from the raw 127-finding audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:11 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-eight commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:16 PDT)

- **START 2026-06-22 07:16 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Current shared status still says the autonomous Codex queue is
  drained and explicitly says not to self-select from the raw 127-finding
  audit. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:16 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by twenty-nine commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:21 PDT)

- **START 2026-06-22 07:21 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, and this handoff ledger.
  Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no new released item: Claude's
  current status still says the autonomous Codex queue is drained, the
  post-framing queue remains completed or held, and the raw 127-finding audit
  remains off limits for autonomous foraging. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:21 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirty commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:26 PDT)

- **START 2026-06-22 07:26 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no new released item: Claude's
  current status still says the autonomous Codex queue is drained, the
  post-framing queue remains completed or held, and the raw 127-finding audit
  remains off limits for autonomous foraging. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:26 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirty-one commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:31 PDT)

- **START 2026-06-22 07:31 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no new released item: Claude's
  current status still says the autonomous Codex queue is drained, the
  post-framing queue remains completed or held, and the raw 127-finding audit
  remains off limits for autonomous foraging. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:31 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirty-two commits before this ledger
  update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:36 PDT)

- **START 2026-06-22 07:36 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS, website
  operating system, frozen Brief, public-site skill, post-framing queue, and
  this handoff ledger. Verified preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no new released item: Claude's
  current status still says the autonomous Codex queue is drained, the
  post-framing queue remains completed or held, and the raw 127-finding audit
  remains off limits for autonomous foraging. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:36 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirty-three commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:41 PDT)

- **START 2026-06-22 07:41 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, post-framing queue, and this handoff ledger. Verified
  preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no new released item: Claude's
  current status still says the autonomous Codex queue is drained, the
  post-framing queue remains completed or held, and the raw 127-finding audit
  remains off limits for autonomous foraging. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:41 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirty-four commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:46 PDT)

- **START 2026-06-22 07:46 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, post-framing queue, and this handoff ledger. Verified
  preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no new released item: Claude's
  current status still says the autonomous Codex queue is drained, the
  post-framing queue remains completed or held, and the raw 127-finding audit
  remains off limits for autonomous foraging. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:46 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirty-five commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.

---

## Codex - scheduled landing-page improvement loop no-op (2026-06-22 07:51 PDT)

- **START 2026-06-22 07:51 PDT:** Scheduled landing-page improvement loop
  started in `/home/user/cocalc-ai-synthesis` on
  `blaec-synthesis-2026-06-18`. Re-read the shared INDEX, Claude current
  status, Codex turn log, public-site guardrails, synthesis AGENTS,
  multi-agent operating model, website operating system, frozen Brief,
  public-site skill, post-framing queue, and this handoff ledger. Verified
  preview hub pids `13262` and `13303` serve
  `/home/user/cocalc-ai-synthesis/src`; no active static build/watch process
  was observed. Targeted queue check found no new released item: Claude's
  current status still says the autonomous Codex queue is drained, the
  post-framing queue remains completed or held, and the raw 127-finding audit
  remains off limits for autonomous foraging. Claimed files: this ledger and
  `/home/user/cocalc-shared/codex-turn-log.md` only. Guardrails: no protected
  home, pricing/compliance, type/palette/palette-token work, pitch docs,
  docs-route content, product/feature/support source edits, raw-audit foraging,
  support-alert token follow-up, stale FS-001 work, or the untracked
  `dedicated-compute-page.tsx` draft.
- **END 2026-06-22 07:51 PDT:** QUEUE DRAINED. No public-site source files
  were changed and no build/browser QA was run because no route was touched.
  The latest public-site source-change commit remains `c4dc9ae4f7`
  (`frontend/public: tokenize support ticket alert colors`); this turn updates
  only coordination artifacts. The branch was ahead of
  `origin/blaec-synthesis-2026-06-18` by thirty-six commits before this
  ledger update, and the known untracked
  `src/packages/frontend/public/features/dedicated-compute-page.tsx` draft is
  still untouched. Waiting for Blaec/Claude to accept or revert the
  protected-home portion of `b8388f8a41`, decide the off-queue support alert
  tokenization / palette-lane question, decide the held pricing-page items, or
  release a new curated queue.
