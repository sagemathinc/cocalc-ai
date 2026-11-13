/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const AGENT_FEATURES_BODY = String.raw`
## Choose a starting point

Codex and Claude Code work inside CoCalc projects. Start with the result you
need, then use the linked guide for setup and instructions.

| What you want to do | Start here |
| --- | --- |
| Build an app, analyze inputs, or create a document | [Start an agent and review its results](/docs/ai/my-agents) |
| Choose a model and how its usage is paid | [Connect AI access](/docs/ai/connect-credentials) |
| Have agents exchange requests and results | [Agent Networks](#agent-networks) |
| Run work with more compute or an existing machine | [Choose compute](/docs/hosts/choose-compute) |
| Continue a task later or reuse its context | [Conversations](/docs/ai/codex-conversations) and [agent memory](/docs/ai/agent-memory) |

The tables below compare CoCalc's integrated agents. They do not describe every
feature of a provider's standalone application. Site configuration, project
permissions, model access, and installed tools determine what you can use.

### Read the comparison

| Status | Meaning |
| --- | --- |
| Available | An integrated workflow described in the linked guide; follow its prerequisites. |
| Conditional | Requires the named provider, runtime, site, or tool capability. |
| Limited | Only the described subset is supported. |
| Not supported | No supported integrated workflow for this feature. |
| Unverified | Live qualification is still outstanding for this combination. |

Unless a row names another payment method, the detailed Claude tool and
coordination qualifications refer to a personal Pro/Max subscription on an
enabled managed project host. API-key and membership access are also available
as described below; this comparison does not assert tool parity across payment
methods or generic ACP adapters.

## Workspace and access

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Start a named agent in a selected project](/docs/ai/my-agents) | Available | Available | Creating an agent can start project compute and consume model allowance. |
| [Name an existing chat; pin, order, group, and retire agents](/docs/ai/my-agents) | Available | Available | Naming does not grant messaging access; retiring a name keeps the conversation and results. |
| [Use project chats with collaborators](/docs/collaboration/chat) | Available | Available | The project is the collaboration boundary, not a private workspace for each agent. |
| [Choose a working directory](/docs/ai/codex-conversations) | Available | Available | Use the composer directory control. A directory is not an access restriction. |
| [Open a terminal from an agent](/docs/terminal/use-terminal) | Available | Available | New agent terminals use the agent's configured working directory on current builds. Existing terminals keep their shell state. |
| [Connect personal subscription access](/docs/ai/connect-credentials) | Available | Available | ChatGPT for Codex; verified personal Claude Pro/Max for Claude. These are separate connections. |
| [Choose API-key or membership funding](/docs/ai/connect-credentials) | Available | Conditional | Claude offers membership funding when enabled and included in your membership, an account Anthropic API key, or a project API-key secret. Membership uses its included model and the AI allowance shared with Codex; Anthropic bills API-key usage. See [Claude access and billing](/docs/ai/claude-code). |
| [Choose model, reasoning/effort, and Standard/Fast speed](/docs/ai/codex-settings) | Conditional | Available | Only options advertised for the selected model and credential are usable. Fast can consume additional allowance. |
| [Save account defaults and refresh available models](/docs/ai/codex-settings) | Available | Limited | Claude offers model refresh and remembers payment choices, but does not share all Codex account-default controls. Changes do not rewrite admitted work. |
| [Inspect subscription usage and reconnect](/docs/ai/connect-credentials) | Available | Available | Provider-reported usage, not a per-agent hard spending limit. Claude offers Reconnect Claude in settings. |
| [Restrict command execution modes](/docs/ai/codex-settings) | Conditional | Not supported | Hosted UI defaults to full project access; Codex Lite offers sandbox choices. Integrated Claude currently has full project access. |
| [Use provider account connectors](/docs/ai/claude-code) | Conditional | Limited | Subscriptions connected now use a long-lived token that cannot load claude.ai connectors; earlier full sign-ins still can, controlled by Use my claude.ai connectors. This is not a common connector catalog across providers. |

## Conversations and control

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Stream responses and inspect tool activity](/docs/ai/codex-chat) | Available | Available | Activity and final response are separate. Claude project commands show readable input/output rather than raw job JSON on current builds. |
| [Continue a saved conversation](/docs/ai/codex-conversations) | Available | Available | Native session storage must still exist. Visible chat history alone cannot reconstruct all native context. |
| [Copy/fork an agent with conversation context](/docs/ai/codex-conversations) | Available | Available | Claude's happy path has live confirmation. A fork is not a copy of project files or a separate Git worktree. |
| [Queue follow-up messages and manage drafts](/docs/ai/codex-conversations) | Available | Available | A queued human message waits for execution; editing or canceling unsent work is different from interrupting admitted work. |
| [Guide a running turn](/docs/ai/codex-conversations) | Available | Available | Requires adapter steering support. The pinned Claude adapter supports delivery during active work; otherwise messages queue. |
| [Stop the current turn](/docs/ai/codex-notifications) | Available | Available | Stops are not rollbacks of file changes, external requests, or provider usage. Claude also cancels its managed project commands. |
| [Return after a browser disconnect](/docs/ai/codex-conversations) | Available | Available | Closing a browser is not cancellation. Project/host loss is different: do not assume running commands are replayed or recovered automatically. |
| [Paste images and attach project context](/docs/ai/editor-agent) | Conditional | Available | Model, attachment type, size, and transport limits apply. Claude accepts pasted images; this does not imply arbitrary binary attachments or native PDF understanding. |
| [Ask from an editor selection, notebook cell, error, or terminal](/docs/ai/editor-agent) | Available | Unverified | Do not assume every editor-to-agent shortcut correctly targets Claude just because the chat composer is shared. |
| [Preview/edit a generated prompt before submission](/docs/ai/editor-agent) | Available | Unverified | Agent Prompt appears only for workflows that prepare one; it is not the complete runtime instruction set. |
| [Answer structured blocking questions](/docs/ai/codex-goals) | Available | Limited | ACP supports a bounded subset of form questions when the adapter requests it; not all provider question tools map to it. |
| [Answer asynchronous questions while work continues](/docs/ai/codex-goals) | Available | Available | Claude subscription tools use the same durable question cards and answer delivery as Codex. Answers guide active work or resume the conversation after its turn finishes. |
| [Dictate or use voice controls](/docs/ai/codex-chat) | Conditional | Unverified | Depends on the site's voice service, browser permission, and UI mode; a microphone icon is not evidence of provider feature parity. |

## Project work and tools

These are CoCalc workspace capabilities exposed through project-aware tools,
not promises that a model will use them correctly without instructions. Claude
subscription commands run through its project tool bridge, not inside its
isolated login controller. Both agents remain subject to CLI authorization.

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Inspect/edit files and run project commands](/docs/files/project-files) | Available | Available | Both can change the shared project and run tests/builds. Review results rather than relying only on the final answer. |
| [Honor project instructions and use CoCalc skills](/docs/cli/use-cocalc-cli) | Available | Available | Claude receives the CoCalc skill as instructions and reads project CLAUDE.md through project tools; it is not a separate native Skill tool. |
| [Remember notes across sessions and projects](/docs/ai/agent-memory) | Available | Available | Off by default; the account owner turns it on in Settings -> AI. Codex and Claude share one account-wide set of notes. |
| [Edit live collaborative text](/docs/cli/collaborative-text) | Available | Conditional | Use the live text API so unsaved collaborative state is respected; a raw filesystem edit is not equivalent. |
| [Read/edit/run live notebooks and inspect outputs](/docs/cli/notebook-workflows) | Available | Conditional | Shared project CLI capability. Use live notebook APIs rather than rewriting an open .ipynb file. |
| [Build LaTeX, documents, and other supported formats](/docs/cli/builds-and-versions) | Available | Conditional | Requires the format's installed toolchain. Use the document build pipeline rather than assuming a shell command reproduces editor behavior. |
| [Run long foreground commands and inspect partial output](/docs/ai/claude-code) | Available | Available | Claude uses managed jobs with wait/cancel/list and bounded output. A short tool wait is not a process deadline. |
| [Interact with terminals and run persistent services](/docs/terminal/use-terminal) | Available | Conditional | Use project-owned terminal/service facilities. Detaching a Claude managed command does not make it persistent. |
| [Inspect Git changes, commit, and work with repositories](/docs/files/git) | Available | Conditional | Git is shared project tooling. Pushes and pull requests require separately configured repository access. |
| [Use browser-session automation](/docs/cli/browser-workflows) | Conditional | Conditional | Requires an authorized browser target and the appropriate runtime tools; it does not grant access to an arbitrary user's browser. |
| [Use versioned CLI commands and scripting](/docs/cli/scripting-and-results) | Available | Conditional | Claude receives scoped project CLI access. Individual commands may still require human approval, fresh authentication, or a different scope. |
| [Use project software, CPU/GPU resources, and custom images](/docs/hosts/choose-compute) | Conditional | Conditional | Agents use the selected project's environment. A model subscription does not provision a GPU or install missing software. |
| [Review file history and recover changes](/docs/files/timetravel) | Available | Conditional | TimeTravel and Git are project facilities. Canceling an agent or restoring files does not restore its native conversation automatically. |
| [Generate images as an integrated model tool](/docs/ai/editor-agent) | Conditional | Not supported | Codex requires an image-generation-capable runtime. Claude can write plotting code or call separately configured services; that is not this native feature. |

### Connect software and services

Choose the connection route that matches the tool:

- **Commands and APIs:** use the service's installed CLI or library with
  [project credentials](/docs/projects/project-secrets).
- **Browser applications:** use the [project web browser](/docs/projects/web-browser)
  for a shared session that you and the agent can operate. Sign-in happens in
  that browser; it is separate from connecting a model subscription.
- **Provider account connectors:** follow the
  [Claude account connector requirements](/docs/ai/claude-code#claude-account-connectors).
  These have different access rules from tools configured inside the project.

## Agent coordination

| Feature | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| Registered agent identity and peer discovery | Available | Available | Claude project tools receive the registered thread's identity on updated hosts. Discovery does not itself start work. |
| Agent-to-agent messaging in one project | Available | Available | Claude-to-Claude delivery and replies are live-verified. Mixed Claude/Codex routing has automated coverage; live mixed-runtime qualification remains outstanding. |
| Agent-to-agent messaging across projects | Available | Unverified | The shared routing path supports Claude and has automated cross-project coverage; live cross-project Claude subscription delivery has not yet been qualified. |
| Queued Agent Networks that wake idle recipients | Available | Available | Claude resumes using the recipient's previously admitted subscription selection, not the sender's credentials. Idle-recipient execution is live-verified. |
| Live Agent Networks that guide busy recipients | Available | Available | Claude can receive messages during active work when the execution principal matches the network account. Network and subscription authorization are rechecked at delivery. |
| Broadcast to several network peers | Available | Unverified | Explicit network membership and bounded recipient limits apply; broadcast does not bypass a recipient's restrictions. |
| Same-project file references and cross-project file snapshots in messages | Available | Unverified | References are live files; snapshots are bounded copies. Neither grants arbitrary access to the sending project. |
| Enrolled external agents in Agent Networks | Conditional | Unverified | Explicit external enrollment and network membership are required; sharing a provider account is not enrollment. |
| Parallel native subagents and concurrency preference | Available | Not supported | Codex's parallel-worker control is not a Claude setting. Provider-native delegation is not equivalent to a named CoCalc agent or network member. |

### Agent Networks

Humans create and manage Agent Networks in **Agents**. Each network is a
two-way group: its members can communicate with each other. Naming an agent,
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
cocalc agent whoami
cocalc agent destinations --json
printf '%s' 'Please summarize your current result.' | cocalc agent send PEER_NAME --stdin --json
cocalc agent send PEER_NAME --attach results.md "Results attached"
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

**Claude setup:** choose a payment method for the recipient agent, or set an
account default. Network work uses the network account's stored selection,
including its claude.ai connector preference; it does not borrow the sender's
payment method. If no selection is stored, CoCalc falls back to that account's
most recent human turn in the recipient thread, and rejects delivery when there
is none or the runtime has changed since, asking you to send one message with
the selected payment method. A disconnected subscription or an authorization
mismatch also rejects delivery.

A live check on 2026-09-28 verified a Claude-to-Claude round trip: a busy Claude
received a network ping during a foreground command and replied to an idle
Claude, which resumed and confirmed receipt. Cross-project and mixed
Claude/Codex combinations have automated routing coverage but still need live
qualification. Network visibility or an accepted receipt alone is not proof
that recipient execution completed.

## Goals, schedules, and monitoring

| Feature and guide | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| [Continuing goals with optional token budgets](/docs/ai/codex-goals) | Available | Not supported | Includes objective editing, usage, pause/resume, stop, and automatic continuations; not a guaranteed provider spending cap. |
| [Sensors: approved scripts that wake the agent](/docs/ai/codex-automation) | Available | Unverified | Scheduled prompts, one-shot watchers (CI, file, time) and approved scripts that run with the agent's own access. Needs project internet access; membership limits the number of sensors, their interval and wakes per day. Claude Code wakes need a subscription or site-funded credential, not an account API key. |
| [Completion/failure/attention notifications](/docs/ai/codex-notifications) | Available | Unverified | Channels and browser permission matter. Do not assume every Claude event has Codex notification parity. |
| [Account session inventory and stop controls](/docs/ai/codex-notifications) | Available | Unverified | The Codex panel is a bounded inventory, not proof that every provider process has stopped. |
| [Inspect durable chat activity and submission state](/docs/cli/command-reference) | Available | Available | Activity can outlive a browser connection. Unknown outcomes require inspection, not automatic retries. |
| Automatically wake a finished turn when an independent background service exits | Not supported | Not supported | Wait for foreground work, explicitly check a terminal/service, or use a separately configured schedule. |

## Results and workbench

| Feature | Codex | Claude Code | Conditions and differences |
| --- | --- | --- | --- |
| Publish saved files, documents, and images as reviewable cards | Conditional | Conditional | Requires the site's workbench/artifact feature and installed CLI. Merely creating a file or linking it is not publication. |
| Collaborative Markdown artifacts | Conditional | Conditional | Shared artifact API, not a provider-specific Markdown message. |
| Git commit and GitHub pull-request cards | Conditional | Conditional | Commits pin a revision; PR metadata can require refresh and repository credentials. |
| Proposed-action review cards | Conditional | Conditional | Recording approval does not execute an action or replace service authorization. |
| Revise an existing artifact and preserve review history | Conditional | Conditional | Update the same artifact with its current revision check instead of creating duplicates. |
| Open results beside the chat and find them in Artifacts | Conditional | Conditional | Shared Agents UI; availability follows the deployed workbench feature. |

### Reviewable results

Use [Agents](/docs/ai/my-agents) to inspect saved results beside the conversation,
give feedback, and continue work. Artifacts can represent files, collaborative
Markdown, images, proposed actions, Git commits, or GitHub pull requests. File
previews show the current saved file, not a historical snapshot; a pinned commit
is the appropriate artifact for a fixed code revision. A Sagebrush board
(\`foo.board.json\`) published as a file shows live in the card on sites that
turn this on (the Sagebrush origin site setting), its code running in
Sagebrush's sandboxed frame; edits made there are not saved to the file.
Showing it sends that site the file's complete text and name.
Agents learn the board format, and what a board's code can use, from
https://sagebrush.space/llms.txt, and check their code before publishing with
the Sagebrush command line pinned (version and digest) in the CoCalc skill.

The [CLI](/docs/cli/use-cocalc-cli) exposes the publication workflow through
\`project chat artifact publish --help\`. Runtime instructions supply the exact
originating chat/thread/message context. Publish against that context and verify
the returned card. Outside a workbench-enabled turn, the command requires the
explicit \`--experimental\` flag. This flag opts into publication outside that
surface; normal workbench turns do not need it. Inspect the returned card to
confirm that publication succeeded.

Read an existing artifact before revising it. A proposed action is a draft for
review: publication is not approval, and approval is not execution. File access,
GitHub permissions, and fresh-auth requirements remain separate checks.

## Choosing a workflow

Use Codex when the task depends on continuing goals. For scheduled work,
check the runtime and payment requirements in the sensors guide.
Both integrations provide asynchronous question cards and Agent Network
delivery, subject to the qualification notes above. Use Claude Code for
interactive project work when its listed limitations are acceptable. Shared CoCalc tools can provide notebook, document, Git, terminal,
and browser workflows without implying that every native Codex feature exists
in Claude.

For both agents, review the selected project, directory, payment source, and
permissions before starting. Neither a successful model response nor a passing
unit test proves an external action completed. Inspect the resulting file,
command status, delivered message, or published artifact.

### Assessment dates

The common workflow labels and navigation were checked against source on
2026-11-13. The live cross-provider assessment dates from 2026-09-28, with
access options reviewed on 2026-10-26. This update does not claim a new live
test of every combination; the row-specific limitations and qualifications
remain in place.
`;
