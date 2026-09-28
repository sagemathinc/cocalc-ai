# Claude Code in CoCalc: First Alpha Release Checklist

Date: 2026-09-25
Target: an explicitly labeled, opt-in preview for a small set of trusted users, not feature parity with Codex or general availability.

## Release Rule

Do not expose the preview to external users until every **P0 item applicable to the offered credential mode** has an owner, evidence, and a pass. Complete the P1 preview surface and human qualification before announcing the alpha; P1 is lower risk, not optional. A preview label is not a substitute for a security boundary. If subscription billing or credential isolation cannot be verified, keep Pro/Max disabled; an **API-key-only preview** may proceed after the shared and API-key gates pass.

## P0: Safety And Correctness

- [ ] **Independent security review of each offered credential path.** Review the project-secret and account API-key relay paths; for Pro/Max, also review controller/tool-bridge separation, mounts, network/IPC access, logs, `/proc`, credential refresh, revocation, and cleanup. Run adversarial prompts and project commands that try to read or export subscription login state before enabling Pro/Max. Record findings privately and resolve release blockers before rollout. Follow `SECURITY.md` for any suspected vulnerability.
- [ ] **Prove account and project boundaries.** Test another account, a project collaborator, a different project, a queued Agent Network message, shared-chat metadata tampering, and a different bay. None may select or spend another person's subscription, mint a broader CLI credential, or call project APIs outside the token's project. The agent-scoped `project status` canary passed; that does not qualify the whole CLI.
- [ ] **Verify billing source outside model output before enabling Pro/Max.** Run bounded turns with a Pro/Max account and a separate Console API key; check Anthropic's account usage/billing surfaces before and after. Test a conflicting API-key environment/configuration and require fail-closed behavior, never silent fallback. Verify what optional extra usage could charge. Recheck [Anthropic's current Agent SDK plan guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [usage-credit guidance](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) immediately before publishing claims; policy can change.
- [ ] **Make permission semantics unmistakable.** Before the first turn, state that Claude has full project command/file/network access and that ACP `allow_once` is answered automatically, not reviewed by a human. Distinguish this from CoCalc fresh-auth and proposed-action approvals. Do not imply a read-only mode or interactive tool approval exists.
- [ ] **Fail closed on auth and uncertain outcomes.** Verify expired/revoked subscription, bad API key, lost auth-status push, quota exhaustion, transient provider failure, controller crash, cancel race, and host outage. No empty "successful" answer, duplicate paid retry, secret-bearing error, or automatic switch between subscription and API key.
- [ ] **Reproduce durable restart behavior on release artifacts.** On a clean supported host, preinstall/pin the adapter and base image, then test first turn, follow-up, project restart, host rolling upgrade, hub restart, and browser reload for both credential modes. Check pinned versions and readiness diagnostics; a cold image pull must not strand a turn behind a generic timeout. The local disposable-project canaries passed repeated project restarts, but are not a fresh-host qualification.
- [ ] **Keep a narrow rollout and rollback.** Require host capability/feature flag plus account allowlist for subscription preview, with a separate subscription kill switch. Disabling new turns must preserve existing chats and allow safe cleanup/revocation. Test rollback on a canary host before inviting users.

## P1: Required Preview Product Surface

- [ ] **Persistent, plain-language preview marker.** Show "Claude Code (Experimental Preview)" in New Agent, the active conversation header/settings, and credential-connection flow, not only inside a dropdown. Link directly to the preview docs. Keep Codex and custom ACP labels distinct; test light/dark, desktop/mobile, keyboard and screen reader behavior.
- [ ] **Explicit credential choice and trust warning.** Present project secret, account API key, and personal Pro/Max as separate modes with the selected identity/billing source before submission. Put the project-secret full-trust warning in its dedicated configuration modal. Explain that project collaborators/code can read a project secret, while account keys can be _used_ through the relay and charged even if not readable. No credentials in chat, URLs, logs, or shareable profile fields.
- [ ] **Actionable setup and errors.** Cover missing key, wrong model, unavailable host/Podman image, reconnect, revoked credential, and provider quota. Show "Claude Code," not "ACP agent," in user-facing progress/errors. Do not invite users to retry an outcome-unknown turn without first inspecting its state.
- [ ] **First-party public docs page.** Add a crawlable `ai/claude-code` entry in `src/packages/docs/src/entries/ai.ts` with content in `src/packages/docs/src/content/ai.ts`. Include setup for both credential modes, project trust model, costs/limits without guarantees, images, CLI/skill behavior, guidance-versus-queue behavior, interrupt/reload/restart, troubleshooting, disconnect, and exact preview limitations. Update `docs/acp-harnesses.md` so its generic "images unsupported" statement does not contradict qualified Claude. Verify docs build, links, and public availability without sign-in.
- [ ] **Discoverable landing-page entry.** Add a small "Claude Code in CoCalc (Experimental Preview)" section/CTA to `src/packages/frontend/public/home/app.tsx`, linking to the public docs and opt-in entry point. Use honest wording: project-hosted agent, bring your own Anthropic access, full-project trust. Verify page title/description or a dedicated crawlable URL, sitemap/indexability, mobile rendering, and that searching "CoCalc Claude Code" can find the docs page. Do not market subscription billing as proven before its P0 gate passes.
- [ ] **Align metadata and onboarding.** Reconcile the API-key-only qualification record in `src/packages/util/ai/qualified-harnesses.ts` with the separately qualified subscription controller, without accidentally removing the API-key `--hide-claude-auth` guard. Make first-run model/session defaults safe; avoid requiring users to reconnect the same account for every new agent.

## Human Qualification

- [ ] Use a written test script with at least three trusted testers besides the implementer, including one new user. Test on a fresh project and a real existing project; capture host, adapter/CLI version, credential mode, browser, outcome, and redacted failure details.
- [ ] Each tester completes: connect, first turn, follow-up, image paste plus question, file edit/test, `CLAUDE.md` and CoCalc skill guidance, scoped CLI `project status`, browser reload, cancellation, and a project restart. For Pro/Max, verify the skill is supplied as controller instructions rather than a native Skill tool; for API-key mode, verify the project skill file is accessible. If both modes are offered, at least one tester uses each.
- [ ] Have testers exercise guidance during a long-running foreground command and the queue fallback when steering is unavailable. Confirm the UI does not promise background-task completion notifications after a turn ends. Verify no accidental duplicate turn on refresh/retry.
- [ ] Run a second-account/collaborator test and a deliberate subscription disconnect/reconnect test under observation. Inspect provider usage after paid canaries; never ask testers to paste credentials or raw logs into chat.
- [ ] Record usability failures as blockers only if they prevent basic setup/work, misstate costs or authority, lose work, or expose secrets. Fix those; defer polish that does not affect a brave user's safe first session.

## Explicitly Deferred From First Alpha

- Full Codex parity: scheduled automations, goals, all CLI commands, native file/terminal callbacks, and wake-on-background-process-completion.
- General custom-ACP qualification, read-only/network-allowlist modes, organization-wide subscriptions, and broad self-service rollout.
- Promises of unlimited Pro/Max usage, no additional Anthropic charges, or complete protection from project code with full command access.

## Alpha Exit Evidence

Keep one dated release record linking the pinned build/adapter, security-review result, provider-side billing check, P0 test results, human-test matrix, docs/landing URLs, known limitations, and tested rollback command. Re-run the two credential-mode canaries after the final deployment, not only before it.
