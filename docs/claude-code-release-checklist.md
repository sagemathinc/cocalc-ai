# Claude Code Subscription Release Checklist

Date: 2026-09-27
PR: [#663](https://github.com/sagemathinc/cocalc-ai/pull/663)
Target: a supported, self-service release, not an operator-only or experimental preview.
Supported scope: Claude Code with a personal Claude Pro/Max subscription only.

This supersedes the **release target**, not the historical evidence, in the
[alpha checklist](../src/.agents/claude-code-alpha-release-checklist-2026-09-25.md).
It is a work checklist, not a certification that the current branch is ready.
Unchecked means release evidence or a decision is still required, not necessarily
that implementation is missing. Do not remove preview restrictions merely by
editing labels or qualification metadata.

## Scope And Exit Rule

- [ ] **R1: Document the supported deployment matrix.** Product scope is decided:
      qualify only Claude Code with personal Claude Pro/Max subscriptions on supported
      managed Linux project hosts. List supported host architectures, browser versions,
      and deployment modes. Project API keys and account API-key relay are not release
      targets; do not spend qualification effort certifying them for this release.
- [ ] **R2: Gate the unqualified UI.** Hide Claude API-key payment choices, generic
      ACP, Pi, OpenCode, and custom adapter setup behind a separate default-off feature
      flag. Verify New Agent, existing-thread settings, and other entry points offer
      only subscription-backed Claude alongside the existing Codex experience by
      default. Do not silently convert existing API-key/custom profiles or payment
      sources; explain unavailable configurations and require an explicit supported
      selection. A UI flag does not replace backend authorization or capability checks.
- [ ] **R3: Establish one evidence ledger.** Every gate below needs an owner, exact
      candidate SHA/artifact digest, environment, test procedure, expected/actual result,
      and evidence link. Record automated, live, user-reported, failed, and skipped
      results separately. A skipped mandatory test is not a pass. Security evidence
      stays private where required by [SECURITY.md](../SECURITY.md).

Release requires every applicable gate below to pass, no unresolved release-blocking
findings, and final engineering/security/product approval of that exact candidate.
An exclusion must remove the associated support claim, not waive a safety boundary
for a feature that remains available.

## 1. Candidate And Reproducible Installation

- [ ] **B1: Reconcile branch and PR.** Include reconnect fix `4c88dbdb53` and
      model/copy recovery fix `efb5ea096d`, merge current main, and update the PR
      description to the final head and subscription-only scope. Recheck remote
      mergeability after pushing; local merge validation is not deployment evidence.
- [ ] **B2: Build one coherent release candidate.** Run the full release build,
      dependency consistency, affected package tests/typechecks, frontend lint, and
      docs checks. Pin adapter, Claude SDK, Node, helper, tools, bootstrap, host, and
      frontend versions. Validate packaged assets, not only workspace source imports.
- [ ] **B3: Pass a clean-host install.** Provision a disposable supported host with
      no developer caches or manual harness setup. Managed provisioning installs and
      verifies required artifacts. A regular user can discover models and complete
      a first turn. Missing prerequisites produce readiness/setup guidance rather
      than a generic timeout or instructions to SSH into the host.
- [ ] **B4: Pass upgrades and rollback.** Test the supported upgrade procedure,
      including the reported full-build/upgrade-all path, from the previous deployed
      version. Cover interrupted installation, version skew, cold image acquisition,
      host reboot, project restart, hub restart, and ACP-worker replacement. Preserve
      history and credentials; never replay an uncertain turn or silently use Codex.

## 2. Credentials, Billing, And Reconnection

- [ ] **A1: Qualify subscription payment.** Connect, discover,
      first turn, follow-up, reload, reconnect, disconnect, and revoke. Verify the
      displayed selection is the credential actually bound to admitted work. Test
      conflicting project environment/settings and confirm no silent payment fallback.
- [ ] **A2: Close the reconnect incident end to end.** Deploy `4c88dbdb53`; verify
      completed sign-in selects the returned ID and updates New Agent defaults.
      Existing agents with a revoked ID must offer an explicit usable connection
      choice. Test multiple connections, another tab, connector preferences, list
      refresh failure, and account switching. Do not guess between billing identities.
- [ ] **A3: Preserve or explicitly recover native context across reconnect.**
      Transcript storage is currently credential-ID scoped. Prove that reconnecting
      the same provider account can continue an existing conversation when the ID
      changes, or implement an explicit, safe recovery path. Never silently start a
      blank native session while displaying the old conversation. Different provider
      identities must not inherit each other's private context accidentally.
- [ ] **A4: Verify subscription costs using provider-side evidence.**
      run bounded canaries and check the actual account usage/billing surfaces, not
      model assertions. Cover subscription extra usage and fast mode where available.
      Confirm plan eligibility and current provider terms before publishing claims;
      give a clear unsupported-plan error for Team/Enterprise or unknown plans.
- [ ] **A5: Exercise auth failures.** Expired tokens, refresh failure, revoked
      access, quota/rate limits, provider outage, and lost auth-status
      notification must yield actionable, sanitized errors. No empty successful
      answer, duplicate paid retry, or exposure of keys/auth bundles.
- [ ] **A6: Complete independent boundary review.** Qualify controller/project
      separation, subscription credential confidentiality, scoped CLI identity,
      collaborators, shared-chat tampering, queued work, and authorization loss.
      Verify routing by account/project ownership across bays where supported.
      Maintainers must close applicable private findings through the private workflow;
      do not reproduce their details in this public checklist.

## 3. Managed Commands And Cleanup

- [ ] **J1: Run the privileged kernel fixture, without skips.** Use an explicitly
      delegated disposable cgroup-v2 parent with `COCALC_TEST_JOB_CGROUP_PARENT` for
      `src/packages/server/cloud/bootstrap/managed-project-job.test.py`. Record the
      actual kernel and installed helper. Unit mocks cannot close this gate.
- [ ] **J2: Run real Podman containment fixtures.** Run
      `src/packages/project-runner/run/sandbox-command-containment.integration.test.ts`
      as the host runtime user, with `COCALC_TEST_MANAGED_PROJECT_ID` explicitly set
      to a disposable project on the updated host. Require real execution and cleanup
      verification for normal exit, cancellation, and deadline, including double forks.
- [ ] **J3: Cover every stop path and race.** Add/run any missing integrated cases
      for `setsid`, `nohup`, reparenting, prompt abort, authority revocation, controller
      close/crash, worker loss, host restart, admission racing project stop, and the
      forced-container-removal fallback. Confirm scopes are empty before reporting
      cleanup complete; orphan/deadline recovery blocks only the affected project.
- [ ] **J4: Exercise the user-visible job contract.** Long foreground builds
      survive tool waits; wait batches output; cursors/page limits and retry IDs work;
      cancel/list find the exact job. Background descendants get one useful warning.
      Terminal-spawned persistent services have a documented separate lifecycle.
- [ ] **J5: Qualify resource and recovery failures.** On disposable infrastructure,
      test relevant process/memory limits, disk-full/output persistence failures,
      broken transport, full queues, and unresolved cleanup. No false success,
      unbounded retry, global admission blockage, leaked credential controller, or
      unbounded temporary homes/cgroups after repeated jobs and discovery calls.

## 4. Conversation And Environment Workflows

- [ ] **W1: Run a complete real subscription task.** Create an agent, set the
      first model/effort, inspect and edit files, run focused tests and a long build,
      publish a file/commit artifact, then continue the same native context. Verify
      working directory, project CLAUDE.md, installed CoCalc guidance, and scoped CLI.
- [ ] **W2: Qualify attachments through the shipped path.** Paste/upload images
      below, at, and above the supported 5 MiB per-image / 10 MiB aggregate limits,
      plus count/type limits. Verify base64-expanded transport, real provider results,
      and clear rejection without poisoning the next turn. Include a multi-image
      prompt and browser reload; transport fixtures alone are insufficient.
- [ ] **W3: Qualify interruption, guidance, queueing, and questions.** Exercise
      streaming reconnect, cancellation at different phases, steering versus queue
      fallback, admitted settings snapshots, pending questions after reload, stale
      answers, concurrent sends, and worker loss. Preserve explicit unknown outcomes.
- [ ] **W4: Qualify Copy Agent.** Fork a populated Claude session, continue both
      branches independently, and verify inherited context/settings/payment choice.
      Cover busy source, restart, reconnect, missing transcript, and timeout. No
      source mutation or automatic second fork after an uncertain response. If not
      qualified, remove the action for the unsupported case rather than expose failure.
- [ ] **W5: Qualify advertised Agent Networks and workbench flows.** Use human-created
      networks for same-project and cross-project delivery, correct principals,
      revocation, and queue behavior. Confirm exact-message artifact publication,
      updates, reload/readback, and that proposed actions do not themselves authorize
      execution. Never substitute account credentials when agent identity fails.
- [ ] **W6: Prove work survives.** Verify file writes and simultaneous editor edits
      converge, saved chats reopen, and native continuation survives supported
      restarts/upgrades. Test snapshot restore and interrupted restore where this
      release relies on them. Do not advertise snapshot cadence or recovery guarantees
      that have not been measured.
- [ ] **W7: Verify connector preference behavior.** Keep claude.ai connectors on
      by default. Test enabled, disabled, reconnect, resumed session, and queued-turn
      cases; toggling applies only to subsequent admissions and does not disable
      CoCalc tools. Explain that task content can be sent to connected services.

## 5. Self-Service UX And Supportability

- [ ] **U1: Complete a novice onboarding test without operator help.** A user can
      choose a project, connect once, choose model/effort/payment, and complete a task.
      Loading is distinct from missing configuration; revoked selections are distinct
      from provider outages. No exposed internal credential IDs or required SSH steps.
- [ ] **U2: Verify the compact composer and settings.** One-line desktop controls,
      usable narrow-screen reflow, actual model/effort when known, fast indicator only
      when enabled, and payment/usage information. Hide email addresses on ordinary
      pages. Keep explanation in accessible settings/help, with in-app docs navigation.
- [ ] **U3: Pass accessibility and usability checks.** Keyboard activation, focus
      restoration, screen-reader names/status, light/dark themes, mobile widths, zoom,
      long labels, and failed/loading states. Have at least three testers other than
      the implementer, including a new user, complete a written workflow matrix.
- [ ] **U4: Make failures diagnosable without secrets.** Distinguish unavailable
      credentials, unsupported plans, missing runtime, protocol/startup failure,
      provider rejection, quota, and cleanup uncertainty. Provide correlation IDs and
      bounded classified diagnostics; do not publish raw protocol, environment, or
      credential-bearing stderr. Generic setup timeout must not be the only evidence.
- [ ] **U5: Validate service behavior under ordinary concurrency.** Agree on and
      record targets for model-discovery latency, first-turn startup, cancellation,
      and queue responsiveness before testing. Run a representative multi-account,
      multi-project soak; monitor admission failures and controller/job resource growth.

## 6. Release Surface And Operations

- [ ] **O1: Replace preview-era metadata deliberately.** Reconcile
      `src/packages/util/ai/qualified-harnesses.ts` with the separately isolated
      subscription path. Do not promote the excluded API-key/custom paths to
      supported status or remove their protections. Verify catalog status changes
      do not accidentally bypass runtime admission checks or the R2 feature flag.
- [ ] **O2: Ship self-service availability.** Supported hosts advertise readiness
      and enable the released integration through normal provisioning, not per-user
      operator allowlists. Preserve site policy controls, capability checks, and an
      emergency admission kill switch. Unsupported hosts explain how to become ready.
- [ ] **O3: Update docs, UI, and release notes together.** After gates pass, remove
      Claude's preview/operator-only labels and stale qualification warnings from
      onboarding, settings, login, public docs, landing entry, catalog, and PR body.
      Keep concrete trust/billing/permission disclosures and unsupported-feature
      explanations. Generic ACP documentation must not contradict Claude support.
- [ ] **O4: Rehearse rollback and incident handling.** Test disabling new admission
      while retaining safe cleanup and readable history. Document supported artifact
      rollback, credential revocation/reconnect, orphan inspection, support ownership,
      and sanitized evidence collection. Rollback must not erase native transcripts.
- [ ] **O5: Approve and deploy the exact candidate.** Resolve blockers from the
      final independent review, rerun impacted gates after fixes, and record release
      approval. Use a staged operational rollout with monitored canaries, then normal
      availability; staged deployment does not make the product an indefinite preview.
      Run post-deployment subscription turns before announcing release.

## Existing Evidence And Remaining Distinctions

- Implemented and locally tested: model/effort/usage UI, isolated subscription
  controller, managed jobs, native fork support, connector preference, and larger
  outbound image frames. This is not final-candidate release certification.
- User-reported live evidence: usage matching the provider website, a 150-second
  foreground job completing, detached descendants stopping, and terminal-spawned
  work persisting. Retain these observations, but also run reproducible fixtures.
- Independent review reported no new public-scope blocker at `c4195a10f6` and
  passing helper tests with a privileged skip. That review explicitly retained
  real kernel/Podman rollout gates; it does not certify subsequent commits.
- On 2026-09-27 the active reconnected subscription successfully loaded Opus 5.5
  and Medium through the live New Agent UI. The stale-selection fix `4c88dbdb53`
  passed 37 focused tests, frontend typecheck, and lint, but was not deployed at
  that checkpoint. No full post-fix inference/resume qualification was performed.
- On 2026-09-27, after the model/copy recovery changes, the user reported that
  Claude works well on lite4b.cocalc.ai and that Copy Agent works and preserves
  context correctly. This supersedes the earlier broken-model/copy observations
  for that tested deployment. The deployed artifact digest was not recorded with
  the report. Retain W4's busy-source, restart, reconnect, missing-transcript, and
  uncertain-outcome cases, and rerun the happy path on the merged candidate.
- The historical [ACP progress log](../src/.agents/acp-harness-progress-2026-09-21.md)
  and [Claude qualification record](../src/.agents/claude-code-acp-qualification-2026-09-22.md)
  contain earlier evidence. Reuse applicable evidence with its exact scope and
  version; do not carry forward stale unchecked lists or infer a pass from silence.

## Not Required For This Release

- Qualifying Claude project API keys, account API-key relay, or generic/custom ACP
  harnesses. Their ordinary release UI must remain hidden under R2; existing code
  and safety checks are not to be deleted or weakened just to narrow the matrix.
- Controller outbound endpoint allowlisting, unless a concrete release-blocking
  finding establishes a need. Do not add it merely as speculative hardening.
- Disabling account connectors by default; the intended default remains enabled.
- Full Codex parity: automations, goals, every optional ACP callback, every CLI
  feature, or notifications when independent background services finish.
- Team/Enterprise subscriptions, arbitrary adapter/model certification, and fully
  air-gapped/on-prem support unless explicitly included in R1/R2.
- Splitting #663 solely because it is large. Require bounded expert review of
  critical boundaries and a current, comprehensible release/evidence summary.

## Recommended Execution Order

1. Merge main, gate the excluded UI, and build a coherent subscription-only candidate
   (R1-R3, B1-B2); deploy the reconnect/model/copy corrections together.
2. Close clean-install/upgrade and credential/context recovery failures (B3-B4,
   A1-A5), using bounded real-provider canaries.
3. Run privileged lifecycle fixtures and independent boundary review (J1-J5, A6).
4. Complete end-to-end workflows, failure matrix, user testing, and soak (W1-W7,
   U1-U5); fix blockers and rerun affected cases.
5. Finalize catalog/default availability, docs, rollback, and release sign-off
   (O1-O5). Only then remove preview status and announce general availability.
