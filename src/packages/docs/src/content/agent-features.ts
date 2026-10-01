/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const AGENT_FEATURES_BODY = String.raw`
## Scope and support levels

This is the feature index for CoCalc's integrated agents, not a list of every
feature in a provider's standalone command-line application. Use the linked
guides for instructions. Start with [Agents](/docs/ai/my-agents) or
[Open Codex chat](/docs/ai/codex-chat).

**Assessed 2026-09-28.** This assessment combines the current CoCalc implementation,
its workflow documentation, and available live checks. It is not a claim that
every row was retested on every deployment. Older frontend, project-host, worker,
or CLI builds can lack features listed here. Site policy, project permissions,
model access, installed software, and compute availability still apply.

The Claude column covers **integrated Claude Code with a personal Pro/Max
subscription on an enabled managed project host**. It does not qualify Claude
API-key modes, generic ACP adapters, or Claude running independently in a terminal.
Claude Code remains an experimental preview; this comparison does not announce
general availability or close its release gates.

| Status | Meaning |
| --- | --- |
| Supported | A documented integrated Codex workflow, subject to the stated prerequisites. |
| Preview | Available in the Claude integration, but still under preview restrictions. |
| Conditional | Requires the named provider, runtime, site, or tool capability; not universal. |
| Limited | Only the described subset works, or a known gap prevents full parity. |
| Not supported | No supported integrated workflow for this feature. |
| Unverified | There is insufficient end-to-end evidence to promise support; not necessarily absent code. |

## Workspace and access

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Start a named agent in a selected project](/docs/ai/my-agents) | Supported | Preview | Creating an agent can start project compute and consume model allowance. |
| [Name an existing chat; pin, order, group, and retire agents](/docs/ai/my-agents) | Supported | Preview | Naming does not grant messaging access; retiring a name keeps the conversation and results. |
| [Use project chats with collaborators](/docs/collaboration/chat) | Supported | Preview | The project is the collaboration boundary, not a private workspace for each agent. |
| [Choose a working directory](/docs/ai/codex-conversations) | Supported | Preview | Use the composer directory control. A directory is not an access restriction. |
| [Open a terminal from an agent](/docs/terminal/use-terminal) | Supported | Preview | New agent terminals use the agent's configured working directory on current builds. Existing terminals keep their shell state. |
| [Connect personal subscription access](/docs/ai/connect-credentials) | Supported | Preview | ChatGPT for Codex; verified personal Claude Pro/Max for Claude. These are separate connections. |
| [Choose API-key or membership funding](/docs/ai/connect-credentials) | Supported | Not supported | Not part of the Claude subscription release scope. Other Claude credential modes may appear on experimental sites, but are not qualified by this table. |
| [Choose model, reasoning/effort, and Standard/Fast speed](/docs/ai/codex-settings) | Conditional | Preview | Only options advertised for the selected model and credential are usable. Fast can consume additional allowance. |
| [Save account defaults and refresh available models](/docs/ai/codex-settings) | Supported | Limited | Claude offers model refresh and remembers payment choices, but does not share all Codex account-default controls. Changes do not rewrite admitted work. |
| [Inspect subscription usage and reconnect](/docs/ai/connect-credentials) | Supported | Preview | Provider-reported usage, not a per-agent hard spending limit. Claude offers Reconnect Claude in settings. |
| [Restrict command execution modes](/docs/ai/codex-settings) | Conditional | Not supported | Hosted UI defaults to full project access; Codex Lite offers sandbox choices. Integrated Claude currently has full project access. |
| [Use provider account connectors](/docs/ai/claude-code) | Conditional | Preview | Claude's Use my claude.ai connectors controls automatic connector inclusion for subsequent turns. This is not a common connector catalog across providers. |

## Conversations and control

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Stream responses and inspect tool activity](/docs/ai/codex-chat) | Supported | Preview | Activity and final response are separate. Claude project commands show readable input/output rather than raw job JSON on current builds. |
| [Continue a saved conversation](/docs/ai/codex-conversations) | Supported | Preview | Native session storage must still exist. Visible chat history alone cannot reconstruct all native context. |
| [Copy/fork an agent with conversation context](/docs/ai/codex-conversations) | Supported | Preview | Claude's happy path has live confirmation. A fork is not a copy of project files or a separate Git worktree. |
| [Queue follow-up messages and manage drafts](/docs/ai/codex-conversations) | Supported | Preview | A queued human message waits for execution; editing or canceling unsent work is different from interrupting admitted work. |
| [Guide a running turn](/docs/ai/codex-conversations) | Supported | Preview | Requires adapter steering support. The pinned Claude adapter supports delivery during active work; otherwise messages queue. |
| [Stop the current turn](/docs/ai/codex-notifications) | Supported | Preview | Stops are not rollbacks of file changes, external requests, or provider usage. Claude also cancels its managed project commands. |
| [Return after a browser disconnect](/docs/ai/codex-conversations) | Supported | Preview | Closing a browser is not cancellation. Project/host loss is different: do not assume running commands are replayed or recovered automatically. |
| [Paste images and attach project context](/docs/ai/editor-agent) | Conditional | Preview | Model, attachment type, size, and transport limits apply. Claude accepts pasted images; this does not imply arbitrary binary attachments or native PDF understanding. |
| [Ask from an editor selection, notebook cell, error, or terminal](/docs/ai/editor-agent) | Supported | Unverified | Do not assume every editor-to-agent shortcut correctly targets Claude just because the chat composer is shared. |
| [Preview/edit a generated prompt before submission](/docs/ai/editor-agent) | Supported | Unverified | Agent Prompt appears only for workflows that prepare one; it is not the complete runtime instruction set. |
| [Answer structured blocking questions](/docs/ai/codex-goals) | Supported | Limited | ACP supports a bounded subset of form questions when the adapter requests it; not all provider question tools map to it. |
| [Answer asynchronous questions while work continues](/docs/ai/codex-goals) | Supported | Preview | Claude subscription tools use the same durable question cards and answer delivery as Codex. Answers guide active work or resume the conversation after its turn finishes. |
| [Dictate or use voice controls](/docs/ai/codex-chat) | Conditional | Unverified | Depends on the site's voice service, browser permission, and UI mode; a microphone icon is not evidence of provider feature parity. |

## Project work and tools

These are CoCalc workspace capabilities exposed through project-aware tools,
not promises that a model will use them correctly without instructions. Claude
subscription commands run through its project tool bridge, not inside its
isolated login controller. Both agents remain subject to CLI authorization.

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Inspect/edit files and run project commands](/docs/files/project-files) | Supported | Preview | Both can change the shared project and run tests/builds. Review results rather than relying only on the final answer. |
| [Honor project instructions and use CoCalc skills](/docs/cli/use-cocalc-cli) | Supported | Preview | Claude receives the CoCalc skill as instructions and reads project CLAUDE.md through project tools; it is not a separate native Skill tool. |
| [Edit live collaborative text](/docs/cli/collaborative-text) | Supported | Conditional | Use the live text API so unsaved collaborative state is respected; a raw filesystem edit is not equivalent. |
| [Read/edit/run live notebooks and inspect outputs](/docs/cli/notebook-workflows) | Supported | Conditional | Shared project CLI capability. Use live notebook APIs rather than rewriting an open .ipynb file. |
| [Build LaTeX, documents, and other supported formats](/docs/cli/builds-and-versions) | Supported | Conditional | Requires the format's installed toolchain. Use the document build pipeline rather than assuming a shell command reproduces editor behavior. |
| [Run long foreground commands and inspect partial output](/docs/ai/claude-code) | Supported | Preview | Claude uses managed jobs with wait/cancel/list and bounded output. A short tool wait is not a process deadline. |
| [Interact with terminals and run persistent services](/docs/terminal/use-terminal) | Supported | Conditional | Use project-owned terminal/service facilities. Detaching a Claude managed command does not make it persistent. |
| [Inspect Git changes, commit, and work with repositories](/docs/files/git) | Supported | Conditional | Git is shared project tooling. Pushes and pull requests require separately configured repository access. |
| [Use browser-session automation](/docs/cli/browser-workflows) | Conditional | Conditional | Requires an authorized browser target and the appropriate runtime tools; it does not grant access to an arbitrary user's browser. |
| [Use versioned CLI commands and scripting](/docs/cli/scripting-and-results) | Supported | Conditional | Claude receives scoped project CLI access. Individual commands may still require human approval, fresh authentication, or a different scope. |
| [Use project software, CPU/GPU resources, and custom images](/docs/hosts/choose-compute) | Conditional | Conditional | Agents use the selected project's environment. A model subscription does not provision a GPU or install missing software. |
| [Review file history and recover changes](/docs/files/timetravel) | Supported | Conditional | TimeTravel and Git are project facilities. Canceling an agent or restoring files does not restore its native conversation automatically. |
| [Generate images as an integrated model tool](/docs/ai/editor-agent) | Conditional | Not supported | Codex requires an image-generation-capable runtime. Claude can write plotting code or call separately configured services; that is not this native feature. |

## Agent coordination

| Feature | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| Registered agent identity and peer discovery | Supported | Preview | Claude project tools receive the registered thread's identity on updated hosts. Discovery does not itself start work. |
| Agent-to-agent messaging in one project | Supported | Preview | Claude-to-Claude delivery and replies are live-verified. Mixed Claude/Codex routing has automated coverage; live mixed-runtime qualification remains outstanding. |
| Agent-to-agent messaging across projects | Supported | Unverified | The shared routing path supports Claude and has automated cross-project coverage; live cross-project Claude subscription delivery has not yet been qualified. |
| Queued Agent Networks that wake idle recipients | Supported | Preview | Claude resumes using the recipient's previously admitted subscription selection, not the sender's credentials. Idle-recipient execution is live-verified. |
| Live Agent Networks that guide busy recipients | Supported | Preview | Claude can receive messages during active work when the execution principal matches the network account. Network and subscription authorization are rechecked at delivery. |
| Broadcast to several network peers | Supported | Unverified | Explicit network membership and bounded recipient limits apply; broadcast does not bypass a recipient's restrictions. |
| Same-project file references and cross-project file snapshots in messages | Supported | Unverified | References are live files; snapshots are bounded copies. Neither grants arbitrary access to the sending project. |
| Enrolled external agents in Agent Networks | Conditional | Unverified | Explicit external enrollment and network membership are required; sharing a provider account is not enrollment. |
| Parallel native subagents and concurrency preference | Supported | Not supported | Codex's parallel-worker control is not a Claude setting. Provider-native delegation is not equivalent to a named CoCalc agent or network member. |

### Agent Networks

Humans create and manage Agent Networks in the agents workspace. Each network
is a two-way group: its members can communicate with each other. Naming an agent,
mentioning it, sharing a project, or choosing the same model does not create
network membership. See [the Agents workspace](/docs/ai/my-agents) and
[CLI authentication and targets](/docs/cli/authentication-and-targets).

A queued network starts a turn when the recipient is idle or queues behind its
active work. A live network can steer a busy recipient only when its execution
principal matches the network account; otherwise it fails safely. Agent messages
remain agent-provided content, not human instructions, fresh authentication, or
approval to change permissions. Model usage and project compute can be consumed
when authorized work runs.

Inside a registered agent runtime, use the installed CLI's help and discovery:

~~~sh
cocalc project chat agent whoami
cocalc project chat agent destinations --json
printf '%s' 'Please summarize your current result.' | cocalc project chat send --to PEER_NAME --stdin --json
~~~

Use the exact CLI executable supplied by that runtime if it differs from
\`cocalc\`. Choose a name returned by discovery, not an arbitrary thread path.
Do not substitute human/account credentials when runtime identity fails.

**Accepted means admitted, not completed.** Rejected means the operation was
refused; unknown means the result is uncertain. Inspect an uncertain attempt
using its returned identifiers instead of automatically resending it. The
recipient's chat and activity show execution results. Human
[CLI submission to a thread](/docs/ai/codex-conversations) is a different
operation and is not an agent-identity fallback.

**Claude setup:** the network account must first send a human message in the
recipient thread with its selected Claude subscription. Subsequent network work
uses that privately stored selection, including the connectors choice; it does
not borrow the sender's payment method. A missing selection, changed runtime,
disconnected subscription, or authorization mismatch rejects delivery.

A live check on 2026-09-28 verified a Claude-to-Claude round trip: a busy Claude
received a network ping during a foreground command and replied to an idle
Claude, which resumed and confirmed receipt. Cross-project and mixed
Claude/Codex combinations have automated routing coverage but still need live
qualification. Network visibility or an accepted receipt alone is not proof
that recipient execution completed.

## Goals, schedules, and monitoring

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Continuing goals with optional token budgets](/docs/ai/codex-goals) | Supported | Not supported | Includes objective editing, usage, pause/resume, stop, and automatic continuations; not a guaranteed provider spending cap. |
| [Schedule agent prompts](/docs/ai/codex-automation) | Supported | Not supported | Daily/interval schedules, weekdays, timezone, and admission limits apply. |
| [Schedule Bash commands](/docs/ai/codex-automation) | Supported | Not supported | Available through the Codex automation workflow; not a Claude-native scheduling feature. |
| [Run now, skip, pause/resume, and acknowledge schedules](/docs/ai/codex-automation) | Supported | Not supported | Overlapping scheduled runs are not queued; unacknowledged runs can pause a schedule. |
| [Completion/failure/attention notifications](/docs/ai/codex-notifications) | Supported | Unverified | Channels and browser permission matter. Do not assume every Claude event has Codex notification parity. |
| [Account session inventory and stop controls](/docs/ai/codex-notifications) | Supported | Unverified | The Codex panel is a bounded inventory, not proof that every provider process has stopped. |
| [Inspect durable chat activity and submission state](/docs/cli/command-reference) | Supported | Preview | Activity can outlive a browser connection. Unknown outcomes require inspection, not automatic retries. |
| Automatically wake a finished turn when an independent background service exits | Not supported | Not supported | Wait for foreground work, explicitly check a terminal/service, or use a separately configured schedule. |

## Results and workbench

| Feature | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| Publish saved files, documents, and images as reviewable cards | Conditional | Conditional | Requires the site's workbench/artifact feature and installed CLI. Merely creating a file or linking it is not publication. |
| Collaborative Markdown artifacts | Conditional | Conditional | Shared artifact API, not a provider-specific Markdown message. |
| Git commit and GitHub pull-request cards | Conditional | Conditional | Commits pin a revision; PR metadata can require refresh and repository credentials. |
| Proposed-action review cards | Conditional | Conditional | Recording approval does not execute an action or replace service authorization. |
| Revise an existing artifact and preserve review history | Conditional | Conditional | Update the same artifact with its current revision check instead of creating duplicates. |
| Open results beside the chat and find them in Library | Conditional | Conditional | Shared Agents UI; availability follows the deployed workbench feature. |

### Reviewable results

Use [Agents](/docs/ai/my-agents) to inspect saved results beside the conversation,
give feedback, and continue work. Artifacts can represent files, collaborative
Markdown, images, proposed actions, Git commits, or GitHub pull requests. File
previews show the current saved file, not a historical snapshot; a pinned commit
is the appropriate artifact for a fixed code revision.

The [CLI](/docs/cli/use-cocalc-cli) exposes the publication workflow through
\`project chat artifact publish --help\`. Runtime instructions supply the exact
originating chat/thread/message context. Publish against that context and verify
the returned card. Outside a workbench-enabled turn, experimental opt-in may be
required. A model's statement that it published something is not proof of a card.

Read an existing artifact before revising it. A proposed action is a draft for
review: publication is not approval, and approval is not execution. File access,
GitHub permissions, and fresh-auth requirements remain separate checks.

## Choosing a workflow

Use Codex when the task depends on continuing goals or scheduled agent work.
Both integrations provide asynchronous question cards and Agent Network
delivery, subject to the qualification notes above. Use the
Claude preview for interactive project work when its listed limitations are
acceptable. Shared CoCalc tools can provide notebook, document, Git, terminal,
and browser workflows without implying that every native Codex feature exists
in Claude.

For both agents, review the selected project, directory, payment source, and
permissions before starting. Neither a successful model response nor a passing
unit test proves an external action completed. Inspect the resulting file,
command status, delivered message, or published artifact.
`;
