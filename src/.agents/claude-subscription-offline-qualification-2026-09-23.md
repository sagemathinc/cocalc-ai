# Claude Subscription Offline Qualification

Date: 2026-09-23

Status: auth contract inspected and probed without login or inference;
subscription billing and credential isolation remain unverified.

Related plan:
`src/.agents/claude-subscription-support-plan-2026-09-23.md`

## Pinned Input And Reproduction

- Adapter: `@agentclientprotocol/claude-agent-acp@0.81.1`, as pinned in
  `src/packages/util/ai/qualified-harnesses.ts`.
- npm integrity checked against the manifest:
  `sha512-I+7tUPsrYnI0nBmdUonoRmdCi7ohyzZ0SeCpeIUFuVZ7a8ZxDyUNO6zBJpaeAIwuPXCk8aw+7t+QiwXS6FwskQ==`.
- Declared Claude Agent SDK dependency: `@anthropic-ai/claude-agent-sdk@0.3.280`.
- Install in a disposable directory; do not use an unpinned `npx` during a turn.
- Run the optional real-artifact test in
  `src/packages/ai/acp/__tests__/harness-client.test.cjs` with
  `CLAUDE_AGENT_ACP_BIN` pointing at the pinned binary. It uses an empty
  temporary home and environment allowlist, performs only ACP `initialize`,
  and sends no session prompt or model request.
- Validation: all 100 tests in that file passed with the pinned adapter binary;
  `pnpm exec tsc --build` passed in `src/packages/ai`.

## Observed Auth Contract

With `clientCapabilities.auth.terminal = true` and no remote-environment flag,
the adapter advertises two terminal methods:

| Method            | Advertised arguments          | Meaning            |
| ----------------- | ----------------------------- | ------------------ |
| `claude-ai-login` | `--cli auth login --claudeai` | Subscription login |
| `console-login`   | `--cli auth login --console`  | Console/API login  |

With `--hide-claude-auth`, it advertises only `console-login`. In a simulated
remote environment (`NO_BROWSER=1`) without that guard, it instead advertises
`claude-login` with `--cli`, an interactive TUI path. The method ID alone does
not establish which billing method the user eventually chose.

CoCalc's current `AcpHarnessClient.start` advertises no terminal-auth
capability; it therefore receives no such methods. Its `open` method sends no
Claude-specific session metadata. The current qualified API-key profile must
retain `--hide-claude-auth`; removing it would change existing billing behavior.

The adapter's `authStatus` extension can push `account`, `api_key`, `gateway`,
`external`, or `none` identity. Its initial CLI probe is asynchronous after
`initialize`, and absence of a push means unknown rather than logged out.
An offline check of the pinned adapter's status mapping reports `account` for
a Claude subscription but `api_key` if an API-key source is also present.
Therefore a UI label or a past status push alone cannot be the pre-turn proof
of subscription billing. CoCalc needs a typed, fresh, fail-closed admission
check against the credential-bound runtime, then live provider-side billing
verification. Do not put subscription identity metadata into shared chat state.

## Controller/Tool Boundary Candidate

The pinned adapter passes client-controlled `_meta.claudeCode.options.tools`
to the SDK and accepts `tools: []` to disable built-in tools. The SDK also
documents `settingSources: []` to disable filesystem settings loading. This
suggests a possible credential-bearing controller with no native shell/file
tools, plus a separately isolated project tool service exposed over an
explicitly approved MCP interface.

This is **not yet a security result**. The controller might still execute
project-controlled hooks, plugins, MCP subprocesses, skills, or other native
paths unless each is disabled or confined. CoCalc currently has no trusted
session-metadata path for this option and no project tool service with the
needed semantics. A no-inference handshake cannot prove the absence of tool
execution during a real turn. The next spike must enumerate every execution
path in the pinned SDK/adapter and run adversarial tests in an isolated
controller, without publishing any personal login credential to a project.

## What Still Requires A Subscription

- Verify a real ACP/SDK turn draws from Pro/Max limits and not Console API
  billing; current [Anthropic guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  is not a substitute for live qualification or a permanent pricing promise.
- Verify the upstream login and refresh flow in a hosted remote environment,
  including the TUI fallback and provider-side billing identity.
- Exercise the selected controller/tool separation with a disposable login,
  then complete independent security review before exposing Connect Claude.

Do not turn on subscription selection, permit a shared-project credential
mount, or imply that the current API-key relay supports subscription OAuth
until those gates pass.
