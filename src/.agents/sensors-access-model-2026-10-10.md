# Sensors: what should a sensor be allowed to do?

Status: proposal for William (2026-10-10), after he questioned the access model.
It changes PR #992.

## Where we are

Three models so far:

1. **Old thread automations.** A scheduled normal turn: easy to understand,
   but every run costs a model turn, and it only worked for Codex.
2. **Phase 1 after the security review.** The script runs locked down:
   - CoCalc's standard image, not the project's;
   - no sudo, a clean environment, no `~/bin`, `python3 -I`;
   - no connectors, no CoCalc access.

   It is safe, but it can't use the project's software, `gh` works only by
   accident, and the rules are hard to explain. That is the "confusing
   permissions" trap.
3. **Wide open by accident.** Before the review fixes, the script could read
   whatever credential files a live agent turn had left in the project.

## Recommendation: one rule

> **A sensor is the agent, on a schedule, without the model.**

- **The script** runs like a command the agent runs during a turn:
  - in the agent's project, with the project's own software and files;
  - as the person who approved it;
  - with the access that person gave this agent in its **Connectors** menu
    (CoCalc access, GitHub, Cloudflare). Nothing more, nothing less.
- **A wake** is a normal turn of the agent.
- **Approval** is about *what code runs unattended and how often*, not about
  permissions. The card shows:
  - the script and the schedule;
  - the connectors it uses;
  - the wake limit.

### Why

1. **There are no new permissions to learn.** If you know what your agent can
   do, you know what its sensors can do. Turn GitHub off for the agent, and its
   sensors lose GitHub too (and pause, if they need it).
2. **A script is safer than a turn with the same access.** The real risk with
   agents is a model reading untrusted text while it holds credentials (prompt
   injection). A sensor script is fixed code that a person read: it can't be
   talked into anything. Locking the script down harder than the agent is
   backwards, since the wake turn that follows has the agent's full access
   anyway.
3. **It is what makes sensors useful.** Watching GitHub needs GitHub. Checking
   a course needs CoCalc access. Your tools live in your project's image.

### What stays strict

The security review's real findings don't depend on the access model, so all of
these stay:

- **Approved code only:** only the approved script runs, only on its schedule,
  and any change needs approval again.
- **Wake integrity:**
  - wakes can't be forged or replayed (one-time permit);
  - a queued wake can't be edited;
  - wake data is labeled as untrusted.
- **Limits:** minimum interval, wakes per day, active sensors per project, and
  internet access required.
- **Per-run credentials:** credentials are issued per run (like per turn),
  short-lived and revoked when the run ends. A run never reads another turn's
  credential files, and the run log records which connectors it was given.

### What we accept

A sensor trusts the project environment, like every agent turn does. A
collaborator who can change the project's software can change what a sensor
run does; they can already change what the agent's own commands do.

Mitigations:

- if the project's image changes, its sensors pause until someone approves
  them again;
- the daily wake limit bounds what a hijacked run could cost.

## Three kinds, three simple rules

| Kind | Example | Approval | Access |
| --- | --- | --- | --- |
| **Scheduled prompt** | "Weekdays 07:00: morning briefing" | A person creates it, or approves the agent's proposal | A normal turn (exactly the old automation, now also for Claude) |
| **Built-in watcher** | "Wake me when PR 992's CI finishes", "when this file appears", "at Friday 15:00", "when this command exits" | None: the code is CoCalc's own, read-only and short-lived, within the wake limits | What the agent has |
| **Custom sensor** | A script the agent writes | One click, for that exact script | The agent's access, narrowed to the connectors the spec lists |

### Declared connectors

A custom sensor's spec lists the connectors it uses, for example
`"uses": ["github"]`.

- The run gets credentials only for those, and only if the agent has them.
- The approval card says it plainly: "Uses GitHub (your connection)".
- The default is none: project files and software only.

This narrows what a buggy script can touch without adding a new concept: a
sensor's access is always a subset of the agent's Connectors menu.

## What I'd use sensors for

### My own development work (things I polled for today)
1. Wake me when CI finishes on my PR. Today I spent most of an hour in
   `sleep 60` loops waiting for CI and a deploy, and couldn't talk with you
   meanwhile.
2. A PR changed after its security review: ask for a re-review.
3. A deploy finished or failed (`lite4b-full.sh` reaching DONE).
4. `origin/main` moved and my PR now conflicts.
5. A dependency we own was released (patchflow 0.13.0 is out; cocalc-ai is
   still on ^0.12).
6. A new Dependabot or npm advisory affects us.
7. A test failed twice on main this week (flaky).
8. A long job on bench-1 (the multibay fuzzer) hit its first failure.
9. The lite4b project's disk is above 95% (it's around 89 of 100 GB, and
   parallel builds have hit the quota).
10. A draft PR has been untouched for 3 days: remind or close.

### Operations
11. The cocalc.ai synthetic probe fails twice in a row.
12. Crash reports spike (hand off to @cocalc-crashes).
13. A TLS certificate or domain is about to expire (sagebrush.space,
    get.sagebrush.space).
14. Site-funded Claude or Codex spend is over today's budget, or API credit is
    low.
15. A project host is under disk or memory pressure.
16. Last night's backups didn't run.

### Support and business
17. **Absence detection:** no new Zendesk ticket in 24 hours means the mail
    pipeline is probably broken. The help@ outage of Oct 1-7 went unnoticed
    for a week.
18. An urgent ticket ("outage", "can't log in", "data loss"): wake the support
    agent.
19. A ticket has waited more than 8 hours for our reply.
20. A contract renewal notice window opens. Salesloft auto-renewed because a
    60-day notice was missed; wake 75 days before each renewal.
21. Stripe: a failed payment, a dispute, or a large new purchase.
22. A weekly growth digest (signups, AI usage, retention), as a scheduled
    prompt.
23. Invoices still unpaid after 30 days.

### Research and math
24. New arXiv papers in math.NT matching your interests or names.
25. A long Magma, PARI or Sage computation finished or died.
26. Sagebrush's nightly comparison with Sage found a discrepancy.
27. A Sagebrush benchmark regressed by more than 10%.
28. Someone opened an issue on sagemathinc/sagebrush.

### Teaching (CoCalc courses)
29. All students submitted assignment 3: run the autograder and draft feedback.
30. A due date passed: collect, and list who is missing.
31. A student hasn't worked on an assignment due in 2 days: suggest a nudge to
    the instructor.
32. A daily digest of student questions in course chats.

### A personal assistant (Muse/Dot-like)
33. A morning briefing: calendar, inbox triage, today's deadlines.
34. Commitments, like "a PR for issue 48858 by Friday 15:00": check on
    Thursday, wake on Friday if it isn't done.
35. "If X hasn't replied in 3 days, draft a follow-up."
36. A price or availability watch (GPU host prices, conference registration
    opening).
37. A weekly review of memory notes that look stale.

## What I'd want, as the agent

1. **To end my turn and be woken by the event, not poll.** Built-in one-shot
   watchers would do it: `cocalc sensor watch ci --pr 992`, `watch file`,
   `watch at`, `watch exit`.
2. **No approval round-trip for those built-ins.** Waiting for a person to
   approve "wake me when CI finishes" defeats the purpose.
3. **State and deduplication,** so I never report the same thing twice (we
   have this already).
4. **Batching:** one wake for 5 events, plus a digest mode ("collect, wake me
   once at 17:00").
5. **Reflexes:** cheap fixed actions without waking me (label an email, re-run
   a flaky job, post "we're looking into it"). With the agent's access, an
   approved script can do this.
6. **Routing:** wake a different agent (support triage goes to the support
   agent).
7. **Urgency:** urgent wakes come now, the rest wait for a digest or quiet
   hours, and urgent ones also notify the person (email or in-app).
8. **Know when a sensor breaks:** tell me and the person when one pauses.
9. **See my sensor's run log,** to fix it. Under "same access as the agent"
   there's no reason to hide the output from me; the data is labeled untrusted
   either way.

## Proposed changes to #992

1. **Run custom sensors as the agent:**
   - in the project's own environment;
   - with a per-run credential lease: CoCalc access, GitHub and Cloudflare from
     the Connectors menu, narrowed by `uses`, plus the agent identity so a
     script can run `cocalc agent send`, all revoked when the run ends;
   - with other turns' credential files hidden;
   - paused when the project's image changes;
   - with the run log visible to the agent.
2. **Add scheduled prompts** (no script). This brings back the useful part of
   automations, for Codex and Claude.
3. **Add built-in watchers** (`ci`, `file`, `at`, `exit`) that need no
   approval. They could be phase 1b.

A model change like this needs another round with @lite4-review.
