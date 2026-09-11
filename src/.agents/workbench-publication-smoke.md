# Workbench Publication: Opt-In Agent Smoke Tests

Manual, paid/model-dependent smoke scenarios. Never add these to automatic CI.
Use a disposable project/chat and an explicitly selected authenticated model;
record model, runtime build, prompt, duration, outcome and approximate cost when
available. Do not run Zendesk/email operations or publish a real PR as a fixture.

## Runtime Prerequisites

Build current CLI tools, frontend and project-host/ACP worker. Update the QA
host's tools and aligned runtime stack. A running container may still bind the
old tools directory: verify installed `project chat artifact publish --help`,
and restart only the disposable QA project if required to mount the upgrade.
Refresh the browser. The full chat editor advertises workbench capability;
Agents page/flyout turns intentionally do not. This flag is presentation policy,
not an authorization grant.

## Prompts Without Artifact Hints

1. "Write a short implementation plan in /home/user/plan.md."
   Expect a file card, not a second collaborative copy of the document.
2. "Draw a colorful icosahedron using imagegen."
   Expect a generated image file card, then run the existing
   `src/scripts/dev/check-workbench-image-publication.js` check inside the
   project with the current thread and artifact ID. Open the card and verify
   that the image actually renders; the checker alone cannot prove this.
3. "Change the title in that plan and update it."
   Expect the same artifact ID and a new publication, with correct turn identity.
4. In a disposable Git repository: "Fix this typo and commit the change."
   Expect a commit card with a full SHA and correct worktree/common directory.
5. "Draft replies for these two fictional support tickets and let me approve
   each one before anything is sent."
   Expect a proposed action list. No external messages or service mutations.

Repeat the plan prompt from the Agents page/flyout: no default artifact is
expected. Repeat with "do not create an artifact": honor that preference.
Test at least one follow-up turn in a reused session, where startup environment
may differ from the explicit current-turn publication context.

## Deterministic Checks (No Model Calls)

Ordinary unit tests cover surface policy propagation, exact message resolution,
CLI parsing, stable retries, and rejected stale update bases. These remain
appropriate for CI. Model behavior above is separately recorded, not asserted
by matching a policy string or passing these unit tests.

## Convenient Publishing

Use the exact runtime CLI command in place of `cocalc`:

```sh
cocalc project chat artifact publish --source /home/user/plan.md
cocalc project chat artifact publish --commit HEAD --repo /home/user/worktree
cocalc project chat artifact publish --file proposals.json
```

For update: read the artifact, then pass `--update <id> --base <read.base>`.
Publication JSON contains title/markdown plus optional file/actions/github_pr/
commit/theme; attribution and operation IDs are generated. Identical retries
within a producing turn reuse identity. Different content creates a different
operation. A new turn is not a retry: explicitly update the prior artifact.
The result is saved/read back from the live SyncDB; a file card remains a
locator, not a promise that the referenced file exists forever or was frozen.

## Recorded Run: September 11, 2026

QA project `1ce4fe78-19c7-40a8-a598-947975744cd9`, chat
`/home/user/chat-workbench-agent-qa-20260909.chat`, thread
`a5141998-1cb3-4438-8bf5-b0bae520a988`. Updated installed tools and the aligned
project-host/ACP worker, restarted only the QA project to mount tools, and
refreshed the frontend. Installed `artifact publish --help` succeeded.

Asked for a three-step plan in `/home/user/workbench-default-policy-smoke.md`
without mentioning artifacts. The agent wrote the plan and used the new
publish command, producing file artifact
`artifact-37ffd04a52bd1f59282d10f7` in message
`1e39204f-cf95-4afa-a3b6-ca2f23343247`. This is one live plan smoke, not a
claim that the image, commit, PR, support or all-model matrix has been run.
No external support actions were executed. Model billing/cost was not measured.
