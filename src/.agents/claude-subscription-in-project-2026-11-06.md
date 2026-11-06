# Subscription Claude runs in the project, behind a host token relay (design), 2026-11-06

William (Nov 5, 9:52 PM PST): "Yes, we definitely need to do this if it works. I think it's even MORE secure and obviously far less brittle than what we're doing now. And the simplification is very significant. E.g., right one could have many claude code cli's running, using up memory, and it's all invisible when you run top in the project, etc. There's just too much mystery. Let's make it cleaner, simpler and more secure."

## Why

A Claude subscription turn (pinned or Auto) runs Claude Code in an isolated **controller** container outside the project (`claude-subscription-controller.ts`, 760 lines). Around it sit:
- a tool bridge: every shell, file and CLI action is an MCP call (`mcp__cocalc_project_…__project_exec`) relayed into the project;
- a CLI lease;
- transcript staging: copying `~/.local/share/cocalc/claude-sessions/<account>/<credential>/-workspace/` in and out with openat2 no-follow helpers;
- restricted egress;
- a credential home and sync;
- and, in #1557, an MCP relay.

The aim was to keep the subscription credential away from project code. The cost:
- brittleness: "tools stopped working" when the bridge, lease or authority loop fails;
- agents work through an indirection, never in the project itself;
- processes no one can see;
- every Claude Code feature (MCP, hooks, skills, settings) has to be re-plumbed.

Codex already runs in the project, holding its credential there.

## What the test showed (Nov 6, Claude Code 2.1.300)

With `CLAUDE_CODE_OAUTH_TOKEN` set to a placeholder and `ANTHROPIC_BASE_URL` pointing at a local relay:
- Every model call goes to the relay: `POST /v1/messages?beta=true`, `Authorization: Bearer <placeholder>`, `anthropic-beta: …oauth-2025-04-20…`.
- Side traffic (telemetry `/api/event_logging/v2/batch`, the bootstrap fetch, the MCP registry, claude.ai connectors) goes straight to `api.anthropic.com`. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` there is none: only `/v1/messages`, through the relay.
- **Live:** with a relay swapping in a real `claude setup-token` token, the reply came back (`200`, 13 `anthropic-ratelimit-*` headers). William ran `~/relay-test/relay-live-test.sh` on lite1b.
- Inside a project container, any process can read another's `/proc/<pid>/environ` (same uid; verified). A real token in the environment would be readable by project code. A placeholder is harmless.

## Design

Claude Code is started **the way Codex's app-server is**: `podman exec` into the project's own container (`codex-project.ts`, `projectContainerName`), as the project user, in the thread's cwd. So it shows in `ps`/`top` and can be killed like any project process. (API-key and site-funded Claude currently run in a separate `acp-<project>-<uuid>` sidecar from `harness-launcher.ts`. They move to the same exec path, so all three Claude modes start one way.) The controller goes away.

1. **Launch** (`harness-launcher.ts`): `account-subscription` no longer branches to `launchClaudeSubscriptionController`. Like the other Claude modes, it execs the qualified harness entry in the project container. The host relay is built from the subscription credential.
   - `getClaudeSubscriptionCredential` → `claudeSubscriptionToken(payload)`.
   - It is created with `createCredentialHttpRelay({ upstream: "https://api.anthropic.com", allowedPathPrefix: "/v1/", allowedMethods: ["GET","POST"], credential: { header: "authorization", value: "Bearer <token>" }, authorize })`.
   - The relay replaces the incoming `Authorization` header, so the placeholder is never forwarded. Already true: `createCredentialHttpRelay` always strips an incoming `authorization` and the credential header (`credential-http-relay.ts:58-63`), and sets the credential per request through `authorize`.
2. **Reaching the relay.** An exec'd process can't get a new bind mount, so the relay socket can't be mounted as for the sidecar. Instead the host relay also listens where the project container can reach it, as the restricted-egress proxy already does (`claude-restricted-egress.ts`, `projectHostAddress()`, a per-session URL). The URL carries an unguessable per-session secret, revoked when the session closes. The harness entry (`qualified-harness-entry.ts`), for every Claude mode, sets:
   - `ANTHROPIC_BASE_URL=<relay URL>`;
   - `CLAUDE_CODE_OAUTH_TOKEN=<fixed placeholder>`, never a real token;
   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`;
   - and unset `ANTHROPIC_API_KEY`.
   - The placeholder is a constant (`sk-ant-oat01-cocalc-relay-placeholder…`), so a leaked environment reveals nothing.
3. **Session options:** the same as API-key Claude in the project. Claude Code's own settings, `~/.claude.json` MCP servers, skills and hooks work natively. Claude Code gets the project's real tools (Bash, Read, Edit, …) in the project's cwd, so agents run commands directly, not through `project_exec`. The CoCalc tool bridge, its system-prompt paragraph and `claudeSubscriptionSessionMeta` are dropped.
4. **Auto:** unchanged above the launcher. Admission and dispatch already resolve the pool to one `credentialId` per turn (`lite/hub/acp/claude-pool.ts`), and the relay is bound to it.
   - When Auto moves a thread to another subscription, the binding differs and the harness restarts, as now.
   - Later option: one long-lived harness whose relay swaps the token per turn. That needs care with the prompt cache; out of scope.
5. **Usage:** rate-limit readings keep arriving as harness `rate_limit` events (`recordHarnessRateLimit`, unchanged).
   - The relay also sees every `anthropic-ratelimit-*` response header. A follow-up can record pool usage on the host from them, without parsing the harness.
6. **Claude.ai connectors:** already off for setup tokens (`claudeAiConnectors = token ? false : …`). Disabling non-essential traffic loses nothing there.
7. **Home-snapshot credentials** (older full logins with a refresh token): dropped entirely. William (Nov 5): "no need -- that was very flaky with many agents." Remove their code (`claude-subscription-home.ts`, credential sync, the login path that makes them). Only `setup-token` tokens remain.
8. **Transcripts and session continuity.** Claude Code uses its normal `~/.claude`. William (Nov 5): "I think using ~/.claude is the best. It's the least confusing for users." Agent sessions, MCP config, skills and settings are the same for the web UI and a terminal `claude`, as Codex shares `~/.codex`.
   - No `CLAUDE_CONFIG_DIR`. A user who also signs in with `claude` in a terminal has that login in `~/.claude/.credentials.json`, by their own choice. Agent turns are unaffected: `CLAUDE_CODE_OAUTH_TOKEN`, set for the harness, takes precedence.
     - **Open:** verify that precedence with Claude Code 2.1.300. The debug log already showed "keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of adopting the stored credential".
   - **Migration, on resume:** today's sessions are in `~/.local/share/cocalc/claude-sessions/<account>/<credential>/-workspace/<session>.jsonl`. If the resumed session's transcript exists only there, copy it (the `.jsonl` and its `<session>/` directory) into `~/.claude/projects/<cwd-key>/`. The cwd-key is Claude Code's encoding of the real cwd. Copy with the existing beneath-copy helpers, then resume. The old tree stays and can be pruned later.
9. **Visibility (`top`):** comes from (1). Exec'd into the project container, Claude Code and its tool processes are ordinary project processes, as Codex's are. Stopping a harness kills its process group in the container: reuse the Codex app-server's stop and cleanup code, not the sidecar's "container removal kills everything".
10. **Remaining exposure, stated plainly.** While a turn runs, project code can call the loopback bridge, and with it the relay token mounted in the sidecar. It could make Anthropic requests on the subscription for the turn's duration. It cannot obtain the token. That is the same exposure API-key Claude has today, and less than Codex (whose refresh-capable `auth.json` is in the project).

## What gets deleted (after rollout)

- `claude-subscription-controller.ts`, `claude-project-tool-bridge.ts` and the bridge scripts (`claude-project-mcp.cjs`).
- `claude-transcript-staging.ts`, `claude-subscription-home.ts`, `claude-credential-sync.ts` (home snapshots are dropped), and `claude-cli-lease` use for controllers.
- The `acp-` sidecar launch for API-key and site-funded Claude, replaced by the exec path.
- The controller egress rules in `claude-restricted-egress.ts`. Keep only what the sidecar needs for projects without internet.
- Controller reapers.
- The `claude-subscription-controller` session policy in `ai/acp/harness-client.ts`, and its discovery special case in `lite/hub/acp/harness-runtime.ts`.
- **#1557** (MCP relay) is not merged: MCP works natively.

## Rollout

1. **PR 1:** the new path behind a site setting, `claude_subscription_runtime: "project" | "controller"` (default `controller`).
   - Contents: the exec launch for all Claude modes, the relay header, the relay reachable from the project container, the entry environment, and transcript migration into `~/.claude` on resume.
   - Tests: relay header replacement; entry environment (placeholder, no real token, non-essential traffic off); migration (copy, idempotent, a symlink refused); launcher selection by setting; a fake-upstream end-to-end test through bridge and relay.
2. **lite1b:** switch the setting and run real turns with claude-1. Check:
   - pinned and Auto turns, including a thread moving between subscriptions;
   - resuming an old thread (migration);
   - MCP (sagebrush-mcp);
   - tools in the project, and `top`;
   - usage recording in Auto.
3. **Production:** switch the default to `project`, with `controller` kept for one release as a fallback.
4. **PR 2:** delete the controller and everything listed above.

## Decisions (William, Nov 5, 10:03 PM PST)

- Sessions in `~/.claude`, shared with a terminal `claude`.
- Home-snapshot logins: dropped ("no need -- that was very flaky with many agents").
- Shared projects: no special rule ("ok").
- Codex runs via `podman exec` in the project container, visible in `ps` (William; confirmed in `codex-project.ts`), and Claude follows it.
