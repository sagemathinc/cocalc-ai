# Multi-Agent GitHub Operating Model

Created: 2026-06-18

Purpose: keep CoCalc.ai public-site work and platform-UI work from colliding
when multiple agent threads, branches, and previews are active. This is an
internal operating note, not public copy.

## Current Local State

This section is factual as of creation time and should be updated when the
branch model changes.

- Platform UI worktree: `/home/user/cocalc-ai`
  - Active branch: `remove-empty-project-tag`
  - Job: platform UI work only.
  - Should not own `blaec.cocalc.ai`.
- Public-site synthesis worktree: `/home/user/cocalc-ai-synthesis`
  - Active branch: `blaec-synthesis-2026-06-18`
  - Job: current public-site work and `blaec.cocalc.ai` preview.
  - Created from `blaec2`, then merged with current `origin/main`.
- Historical landing branch: `blaec`
  - Branch: `blaec`
  - Job: historical landing reference only.
  - Worktree removed after synthesis took preview ownership.
  - Should not be used to rebuild or restart `blaec.cocalc.ai`.
- `blaec2`
  - Contains `blaec` plus later mixed platform/main integration.
  - Treat as an integration ancestor, not an active workstream, unless Blaec
    explicitly says to resume it.
- Preview data/tunnel
  - `blaec.cocalc.ai` currently uses local preview data from
    `/home/user/cocalc-ai/src/data/app` through synthesis worktree local
    config:
    `/home/user/cocalc-ai-synthesis/src/.local/hub-daemon.env`.
  - `.local`, `data`, screenshots, generated QA output, and tunnel secrets are
    local runtime state. Do not commit them.

## What Went Wrong

The site did not only suffer from design churn. It also suffered from workflow
coupling:

- Two agent threads used one checkout or one preview target without an explicit
  owner.
- `blaec.cocalc.ai` was restarted from the platform checkout, so the public
  homepage appeared to revert even though the landing branch still contained the
  landing work.
- Branch names like `blaec` and `blaec2` stopped communicating ownership.
- Broad prompts mixed audit, editing, validation, rebuild, commit, and next
  planning in one turn, making it easy to complete tasks mechanically while
  losing the product decision.
- Useful local artifacts were sometimes placed near the repo instead of under
  a clear scratch path, raising the risk of accidental commits.

## Research-Derived Principles

These are the practices to keep, adapted to this repo and this user workflow.

- Use one worktree per concurrent branch. Git worktrees exist for exactly this:
  multiple working trees can check out more than one branch at the same time.
  This prevents one agent from dirtying or restarting another agent's context.
- Keep branches short-lived and scoped. Trunk-based guidance favors small,
  frequent updates, short-lived branches, and a small number of active branches.
  For our use, that means one active platform branch and one active landing
  branch, with integration branches treated as temporary.
- Use pull requests as the durable review object. A PR should explain what
  changed, why, how it was validated, and include screenshots/links when visual
  review matters.
- Use draft PRs for work in progress. They create a stable place to discuss the
  branch without pretending it is ready to merge.
- Do not "vibe code" straight to source. Loose product/design feedback is fine
  from Blaec, but the agent must translate it into a bounded engineering brief
  before editing.
- Agent tasks must be scoped. GitHub's own agent guidance says cloud agents do
  best with simple, well-scoped tasks and should not be handed broad, ambiguous,
  sensitive, or high-judgment tasks without review.
- Tests are a floor, not a design reviewer. Deterministic checks can catch
  stale phrases, wrong routes, overflow, and forbidden claims. Human review
  still owns visual taste, product hierarchy, and whether a page feels credible.

## Branch And Worktree Rules

1. One active workstream gets one branch and one worktree.
2. Never let two agent threads edit the same worktree.
3. Never let two branches believe they own `blaec.cocalc.ai`.
4. Before changing files, run:

```sh
git worktree list
git status --short --branch
git log -1 --oneline
```

5. Before public-site preview work, also verify the hub root:

```sh
ps -eo pid,ppid,etime,cmd | rg 'packages/hub|hub-daemon|node .*hub'
readlink /proc/<hub-pid>/cwd
```

6. If the hub cwd is not the synthesis worktree, stop the wrong hub before
   restarting from the synthesis worktree.
7. Do not use `blaec2` as a live working branch unless the goal is explicitly
   "integration branch cleanup." It is not the canonical public-site branch.

## Current Cleanup Checklist

Use this checklist until the synthesis branch is merged or deliberately
replaced. Keep it current before ending any branch-management turn.

- [x] Confirmed `blaec`, `blaec2`, and current `origin/main` are ancestors of
      `blaec-synthesis-2026-06-18`.
- [x] Created `/home/user/cocalc-ai-synthesis` as the active public-site
      synthesis worktree.
- [x] Restart `blaec.cocalc.ai` from
      `/home/user/cocalc-ai-synthesis/src`.
- [x] Verify the running hub cwd is `/home/user/cocalc-ai-synthesis/src`.
- [x] Verify homepage metadata from `https://blaec.cocalc.ai/`.
- [x] Remove the stale `/home/user/cocalc-ai-landing` worktree after preview
      ownership moves.
- [x] Keep local historical branches until Blaec explicitly approves deletion
      or remote cleanup.
- [x] Do not delete remote branches in an agent turn unless the prompt asks for
      that exact operation.

## Repository And Agent File Architecture

This diagram is the shared orientation map for Codex, Claude, Gemini, and
future agents. `CLAUDE.md` and `GEMINI.md` symlink to `AGENTS.md`, so the root
agent instructions are shared across agent surfaces.

```text
/home/user/cocalc-ai                 platform UI worktree
  AGENTS.md                          shared instructions; CLAUDE.md/GEMINI.md symlink here
  src/
    packages/                        monorepo packages and package-local checks
    .agents/                         platform/backend/frontend internal plans

/home/user/cocalc-ai-synthesis       active public-site synthesis worktree
  AGENTS.md                          same shared repo instructions
  .agents/
    skills/public-site-landing-page/
      SKILL.md                       public-site workflow skill
  docs/
    landing-page-brief.md            frozen public-site north star
    landing-page-issues-and-plans.md finite public-site queue
    landing-page-design-system.md    visual/token direction
    landing-page-decisions.md        durable decisions only
    website-operating-system.md      public-site operating contract
  src/
    .agents/
      multi-agent-github-operating-model.md  branch/worktree/preview map
      public-site-audit-prompt-log.md        prompt backlog and continuity notes
    .claude/commands/                reusable public-site command prompts
    packages/frontend/public/        public CoCalc.ai React routes and tests
    packages/static/dist/            built public/static bundle served by hub
    data/ and .local/                local runtime state; ignored; never commit

historical branch: blaec             retained only for history/reference
  status: worktree removed after synthesis preview took ownership
```

Rule of thumb:

- Platform UI agents work in `/home/user/cocalc-ai`.
- Public-site agents work in `/home/user/cocalc-ai-synthesis`.
- Public preview ownership is verified by hub process cwd, not by branch name
  alone.
- Generated screenshots, QA JSON, traces, and scratch notes stay under
  `/tmp/cocalc-*` or ignored local state.

## Preview Ownership Rules

The `blaec.cocalc.ai` preview is a shared external surface. Treat it like a
scarce environment, not a normal local dev server.

- Owner: synthesis worktree.
- Current source root: `/home/user/cocalc-ai-synthesis/src`.
- Current branch: `blaec-synthesis-2026-06-18`.
- Current public URL: `https://blaec.cocalc.ai`.
- Local runtime state may reference existing preview data under the platform
  checkout; that is a local convenience, not a Git relationship.
- Any agent that restarts the hub must report the source root and branch after
  restart.
- If a platform UI task needs a hub for browser QA, it should use a separate
  local/dev target or explicitly take over the preview after Blaec approves.

Minimum preview verification after restart:

```sh
readlink /proc/<hub-pid>/cwd
git -C /home/user/cocalc-ai-synthesis rev-parse --abbrev-ref HEAD
curl -I --max-time 20 https://blaec.cocalc.ai/
```

## Vibe Feedback Translation

Blaec is allowed to speak loosely. The agent is not allowed to edit loosely.

When the user says something like "this feels busy" or "something reverted,"
the agent must translate it into:

- observed symptom,
- affected route/worktree,
- likely product question,
- options considered,
- proposed smallest useful action,
- what will remain human judgment,
- validation plan.

Do not jump from subjective feedback directly to source changes. First choose
one action per component: keep, omit, combine, move lower, move to disclosure,
or redesign.

## Prompt Contract

Use this shape for future agent prompts when GitHub/worktree complexity matters.

```md
Worktree: /home/user/cocalc-ai-synthesis
Branch: blaec-synthesis-2026-06-18
Preview owner: blaec.cocalc.ai

Goal:
<one outcome>

Scope:
<routes/files/components allowed>

Out of scope:
<branches, product claims, compliance docs, broad redesigns, or platform files>

Source of truth:

- AGENTS.md
- .agents/skills/public-site-landing-page/SKILL.md
- docs/landing-page-brief.md
- docs/landing-page-issues-and-plans.md
- route source and focused tests

Before editing:

- verify worktree/branch/status
- verify preview hub cwd if public-site preview matters
- state the visitor or buyer question
- set a small change budget

Validation:

- focused tests
- lint/typecheck if touched package needs it
- browser QA or screenshot review when visual
- rebuild/preview verification if public source changed

Handoff:

- commit completed changes
- report changed files, validation, preview status, residual risks
- include the next recommended prompt
```

## GitHub PR Rules

- Use draft PRs for work that needs review but is not ready.
- A PR should include:
  - what changed,
  - why it changed,
  - screenshots or preview links for visual public-site work,
  - focused validation results,
  - known residual risks,
  - reviewers needed.
- Delete or archive branches after merge. Keep active branches few.
- Prefer follow-up commits over history rewriting unless Blaec explicitly asks
  for squash/rebase cleanup.
- If a branch has many commits and mixed scope, create an integration checklist
  before merging rather than continuing to pile work onto it.

## Recommended Branch Policy

- Keep `remove-empty-project-tag` or a renamed successor for platform UI work.
- Keep `blaec-synthesis-2026-06-18` as the active public-site synthesis branch
  until the current landing work is PR-ready.
- Keep `blaec` as historical landing work and freeze `blaec2` unless explicitly
  used for integration archaeology.
- Create new branches from fresh `origin/main` for new isolated platform tasks.
- After the current public-site synthesis is merged, use smaller follow-up
  branches instead of continuing a large evergreen landing branch.

## Done Checklist For Each Agent Turn

- [ ] Correct worktree and branch verified.
- [ ] Dirty state understood before editing.
- [ ] Preview owner verified if applicable.
- [ ] Source-of-truth docs loaded.
- [ ] Scope and out-of-scope stated.
- [ ] Tests/QA chosen before editing.
- [ ] Scratch artifacts stored under `/tmp/cocalc-*` or ignored local state.
- [ ] Public preview rebuilt and checked if public source changed.
- [ ] Completed changes committed.
- [ ] Residual risks and next prompt reported.

## External References

- Git worktree manual: `https://git-scm.com/docs/git-worktree`
- GitHub Flow: `https://docs.github.com/en/get-started/using-github/github-flow`
- GitHub pull requests: `https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests`
- GitHub Copilot cloud agent best practices:
  `https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results`
- Codex AGENTS.md guide:
  `https://developers.openai.com/codex/guides/agents-md`
- Continuous Delivery on small, self-contained changes:
  `https://continuousdelivery.com/foundations/continuous-integration/`
- Atlassian on trunk-based development:
  `https://www.atlassian.com/continuous-delivery/continuous-integration/trunk-based-development`
- Addy Osmani on vibe coding vs AI-assisted engineering:
  `https://medium.com/@addyosmani/vibe-coding-is-not-the-same-as-ai-assisted-engineering-3f81088d5b98`
