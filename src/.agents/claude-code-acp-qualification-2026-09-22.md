# Claude Code ACP Qualification Record

Date: 2026-09-22

Status: Phase 0 investigation; not approved for user-facing release

Related plan:
`src/.agents/claude-code-acp-integration-plan-2026-09-21.md`

## Pinned Candidate

- Package: `@agentclientprotocol/claude-agent-acp@0.79.0`
- npm integrity:
  `sha512-/liYDBHElfzgbeijv8EZzvDUUAC8wUi1WSCZ+bw/DIKHQ3t3DLid+LS+6lszuQamHAWijjaZl1i5xZVRTnNPoA==`
- Package git head: `d421f56a6c43cde16d9a7531d08a750a5ef2f04a`
- ACP SDK: `@agentclientprotocol/sdk@1.4.0`
- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk@0.3.274`
- Node requirement: 22 or newer

The machine-readable copy is
`src/packages/util/ai/qualified-harnesses.ts`.

## Verified Without Inference

The released npm artifact was installed in a disposable directory and launched
through CoCalc's compiled `AcpHarnessClient` with an empty isolated home,
Anthropic credentials omitted from the environment, and
`--hide-claude-auth` enabled. No session prompt or model request was sent.

Initialization successfully negotiated ACP protocol version 1 and reported:

- adapter identity and version `0.79.0`;
- session load/resume and lifecycle capabilities;
- image and embedded-context prompts;
- HTTP and SSE MCP servers;
- logout and authentication-status metadata;
- native subagent sessions;
- Claude prompt queueing.

No authentication methods were advertised because subscription authentication
was hidden and no terminal-auth capability was offered by CoCalc.

The optional real-artifact test in
`src/packages/ai/acp/__tests__/harness-client.test.cjs` repeats this check when
`CLAUDE_AGENT_ACP_BIN` names the pinned executable. Normal deterministic tests
skip it rather than downloading code during a test run.

## Credential Isolation Finding

The maintained adapter calls the Claude Agent SDK `query()` API, which launches
the SDK's bundled native Claude CLI. Claude's built-in Bash, file, and subagent
tools execute under that runtime. ACP permission requests and terminal metadata
describe and control those tools, but do not move Bash execution into the ACP
client.

The adapter does call ACP `fs/read_text_file` and `fs/write_text_file` for
specific client filesystem operations. Those callbacks are not a general
replacement for Claude's built-in shell and filesystem tools. Implementing
CoCalc terminal callbacks alone therefore cannot separate every
model-controlled tool from the credential-bearing Claude controller.

Consequences:

- A personal Pro/Max credential must not be mounted into the current full-access
  sidecar until a stronger controller/tool boundary is proven.
- An account-owned Anthropic API key has the same isolation concern.
- A project-owned API key may be used by an explicitly trusted project because
  the project and its agent already share that secret boundary, but the UI must
  say that Anthropic API billing applies.
- `--hide-claude-auth` is mandatory for the initial API-key candidate. The
  adapter uses this flag to hide Claude subscription login and reject turns
  that would bill a stored subscription.

Potential solutions to investigate with Anthropic/Zed include an SDK hook for
external tool execution, a supported credential helper/proxy that never exposes
the long-lived credential to tool processes, or a hardened split-identity
runtime with an adversarial proof. Until then, subscription support remains a
release gate rather than a configuration option.

## API-Key Foundation

The server now has a provider-neutral account credential broker and an
Anthropic API-key adapter. The adapter:

- validates a key with a bounded, non-inference models-list request;
- publishes only after successful verification;
- stores the encrypted key payload centrally;
- stores only a SHA-256 fingerprint and safe billing/authentication metadata;
- maps failures to messages that omit the key and provider response body;
- supports explicit, exact-ID key rotation under the account/provider lease.

This establishes lifecycle behavior and testing but does not yet authorize or
materialize an account key into a Claude runtime. That binding remains blocked
on credential/tool isolation.

## Managed Distribution Discovery

The current Claude Agent SDK dependency installs an architecture-specific
Claude executable of about 220 MB. Bundling both amd64 and arm64 copies into
the universal CoCalc project-tools artifact would add roughly 440 MB before
compression to every project host, including hosts that never enable Claude.
The adapter should therefore ship as a separate versioned managed-harness
artifact or host cache, mounted read-only into qualified ACP sidecars. A
project-local exact-version install remains suitable for qualification with a
project-owned API key, but is not the intended managed-service distribution.

## Credential Relay Foundation

The project host now has a provider-neutral streaming HTTP relay foundation.
It holds the real credential in project-host memory, listens on a mode-0600
Unix socket, requires a random per-runtime capability, fixes the upstream
origin and path prefix, strips caller-supplied authorization headers, injects
the real provider header, does not follow redirects, and bounds request size
and duration. The next integration step is a tiny sidecar-local TCP-to-Unix
bridge plus exact-ID broker admission. This lets model-controlled shell tools
use the admitted provider session without receiving the durable account key.

## Next Engineering Work

1. Add a project-owned Anthropic API-key path using the existing project-secret
   boundary, then run a real prompted turn with a disposable key.
2. Extend CoCalc's ACP capability negotiation for typed auth status, session
   failures, recommended model/effort values, subagents, and URL elicitation.
3. Build managed installation from the pinned package manifest rather than
   invoking an unversioned package command.
4. Connect exact-ID broker admission to the credential relay and adversarially
   test the local bridge before enabling account-owned API keys.
5. Re-run the live package probe and adapter upstream test suite whenever the
   pinned version changes.
