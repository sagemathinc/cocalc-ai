/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const CLAUDE_CODE_BODY = String.raw`
## Experimental preview

Claude Code can work in a CoCalc project from the Agents workspace. This is an
experimental preview: availability depends on the site's configuration, and
some capabilities differ from Codex. Start in a project whose files you can
restore and whose collaborators and code you trust.

## Start a conversation

1. Open **Agents**, choose **New Agent**, and select a project.
2. Select **Claude Code (preview)**.
3. Choose a credential: a project API-key secret, an account API key, or a
   connected Claude Pro/Max subscription, where offered by the site.
4. For a project key, use the Claude API-key dialog. For a subscription, use
   **Connect Claude Pro/Max (experimental)** and complete the sign-in flow.
   Never paste credentials or login codes into a chat message.
5. Start with the session's default model, or load the available model options.
   Paste an image or ask Claude to inspect a small file and run a test.

Your selected credential is bound when a turn is admitted. Changing the
selection applies to subsequent turns; it does not change an already admitted
turn. A model saved under a different credential may be unavailable; choose a
model advertised by the current session.

## Security model

### Project access and approvals

Claude has full project access. It can read and edit files, run commands,
access project secrets, and send project content to external services. CoCalc
does not ask for approval before each tool or shell command. The project is
the collaboration and execution trust boundary: only use this preview with
collaborators, repository instructions, skills, and code you trust.

Credential isolation protects the credential material described below. It does
not make project contents confidential from Claude, its provider, or other
project collaborators, and it does not protect against destructive commands.

### Project API-key secret

The selected ANTHROPIC_API_KEY is a project secret. Project collaborators and
code running in the project can read, copy, and use the key. Anthropic bills
the key owner. Removing the secret from CoCalc cannot revoke copies already
made; revoke or rotate the key with the provider when necessary.

### Account API key

CoCalc keeps the account-stored key value outside the project and uses a
provider relay to attach it to API requests. Project code does not receive the
key value from this relay. However, while the relay is active, project code
and collaborators can use it to make provider requests and incur charges on
the key owner's account. Selecting this mode authorizes that project-level
use of your billing authority. Hidden key bytes do not mean exclusive use by
one agent or a separate spending allowance for each collaborator.

The Claude session is pinned to the selected CoCalc relay; project settings
must not silently select another credential or provider route. The relay
revalidates its exact account credential before each new provider request and
rejects requests when authority cannot be verified. Revocation cannot undo
requests already accepted by the provider. A retained session may keep the
relay available between turns; stop the agent session or revoke the credential
when you no longer authorize its use.

### Claude Pro/Max subscription

Subscription login state is account-owned and kept in a separate controller,
outside the project filesystem. Claude's project commands execute through a
scoped tool bridge into the project. Ordinary project commands should not be
able to read or export that login state. This boundary does not prevent Claude
from accessing project files or using other credentials exposed inside the
project.

Work accepted by this agent consumes the selected subscription's usage
allowance. This includes work initiated by authorized Agent Network messages;
a separate human confirmation is not required for each such turn. Creating or
joining a network therefore has a usage consequence. Review network members
and remove access when it is no longer intended. Messages do not grant access
outside the receiving agent's existing authority.

CoCalc checks credential authority when admitting and running work and before
mediated project commands. Disconnect prevents future authorized use; it
cannot undo completed work or provider usage. Provider-side session revocation
is also appropriate if you suspect credential compromise.

### Billing and cancellation

Check the displayed credential and account identity before starting work.
Provider plan limits and any enabled extra-usage billing apply; CoCalc does
not promise a hard spending cap. Configure limits at the provider and monitor
usage there. Subscription access and API-key billing are distinct choices.

Cancel stops the current turn and cancels its mediated project commands.
Controller disposal disables the project bridge and closes the scoped CLI
lease even if container removal needs retry: credential renewal stops and
the lease files are removed. This is not a promise that a CLI token previously
copied by project code becomes instantly invalid; its existing expiry and
revocation rules still apply. Cancellation cannot roll back file changes,
external requests, or charges already incurred. A process deliberately
detached into a different session can require separate project cleanup.

## Capabilities and current limits

- Text and pasted images are supported.
- The CoCalc skill supplies project-aware CLI guidance. In subscription mode,
  it is preloaded as instructions rather than registered as a separate Skill
  tool. Skill references and project CLAUDE.md files are read through the
  project command tool.
- Project commands receive a scoped CoCalc CLI credential. This is separate
  from the Anthropic credential; CLI actions remain limited by its authority.
- Subscription project commands have bounded output and a 120-second limit.
  Long commands should be split into inspectable steps.
- Live guidance requires adapter support; other messages queue. Automations
  and goal workflows are not yet supported by this integration.
- A background subprocess finishing does not automatically wake a completed
  CoCalc turn. Ask Claude to wait for completion or explicitly check its status.
- Authorized Agent Network subscription turns are supported. Account API-key
  network turns are currently rejected by admission.

## Troubleshooting and agent-readable help

If a session fails after a restart, retain the error and agent identity and
report them to the site administrator. Avoid blindly resending a turn whose
execution outcome is uncertain. Missing model options, expired credentials,
and unavailable runtime setup should be resolved before retrying.

This page is part of the shared CoCalc documentation catalog, available to
humans at /docs/ai/claude-code and through the cocalc-cli docs commands. Agents
can search for "Claude Code" and read this entry instead of relying on a
short warning shown during setup.

    cocalc docs search "Claude Code"
    cocalc docs show ai/claude-code

See also [Agents](/docs/ai/my-agents) and
[AI access](/docs/ai/connect-credentials).
`;
