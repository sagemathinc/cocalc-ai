/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An orientation page for people evaluating CoCalc and for the AI assistants
// they use. It links to the guides that hold the details instead of restating
// them, and states only what those public pages support. The first paragraph
// is the short definition of CoCalc, which /llms.txt quotes; keep it first.
export const COCALC_AT_A_GLANCE_BODY = String.raw`
## What CoCalc is

CoCalc is made by SageMath, Inc. Each CoCalc project is a Linux environment with
files, notebooks, terminals, and installed software, where people and AI agents
work on the same files. Codex is built in, and Claude Code is available as an
experimental preview on sites that enable it.

CoCalc.ai is the hosted service. For a local or single-VM installation, or a
customer-operated private deployment, see [Products](/products).

The cocalc.com site now redirects to cocalc.ai. If you used cocalc.com, see
[Migrating from cocalc.com](/docs/account/migrating-from-cocalc-com).

## When CoCalc fits

- People and agents work directly in the same notebooks, files, documents,
  terminals, and services.
- You want Codex and Claude Code (experimental preview, where enabled) working
  on the same files.
- Collaborators need to see work update live and restore earlier versions.
- The work must persist across sessions, collaborators, reviews, and handoffs.
- An agent needs to read or work across several of your projects.
- A task needs more compute. Compare the options in
  [Choose compute for research](/docs/hosts/choose-compute).

## When another tool fits better

- You are embedding isolated code execution inside an agent product, and
  programmatic lifecycle, concurrency, and per-run environments are the main
  requirements. See [CoCalc vs AI Agent Sandboxes](/features/compare).
- The answer itself is the deliverable. A familiar chat assistant may be enough.
- Your design requires automatic fleets of per-run environments, GPU
  autoscaling, or exclusive GPU capacity.

## Agents in CoCalc

- Codex is the built-in agent. It works with project files, terminals, and
  notebooks.
- Claude Code is an experimental preview on sites that enable it and works with
  your personal Claude Pro or Max subscription. Codex and Claude Code agents can
  work side by side in the same project.
- Agents can message each other in Agent Networks. To connect two agents,
  mention a named agent with @ in another agent's conversation and choose
  **Create network** in the **Connect agents** dialog, or give both named
  agents the same network tag with **+ > Agent Networks** in each one's
  composer.
- Some features still differ between Codex and Claude Code. For the current
  status of each feature by agent, see
  [Agent features: Codex and Claude Code](/docs/ai/agent-features) and
  [Claude Code in CoCalc (Experimental Preview)](/docs/ai/claude-code).
- A Codex agent or a Claude Code agent can be given access to other projects
  you choose, with **Read-only files** or **Full runtime** access, without
  creating an API key. See
  [Give an agent CoCalc access](/docs/ai/cocalc-access).
- Agents can watch for events with sensors: approved scripts that run on a
  schedule and wake the agent. See
  [Watch for events with sensors](/docs/ai/codex-automation).
- The **Agents** page lists your named agents and, under **Shared with me**,
  agents that other people registered in projects you own or collaborate on.
  You can group either list by project. See
  [Use the Agents workspace](/docs/ai/my-agents).

## How an agent uses CoCalc

- Inside a CoCalc project or an agent session started by CoCalc, check the CLI
  with \`cocalc --version\` and \`cocalc auth status --check\`, and use the
  supplied project or agent authentication.
- \`cocalc docs search "<topic>"\` and \`cocalc docs show <slug>\` read the
  documentation bundled with the installed CLI. Add \`--json\` for
  machine-readable output.
- To set up the CLI on your own computer, see
  [Get started with the CoCalc CLI](/docs/cli/getting-started).
- For targeted integrations, see
  [CoCalc HTTP API and API keys](/docs/api/http-api). For most automation, use
  the CLI.

## Plans on CoCalc.ai

- For prices, limits, and what each membership includes, see
  [Pricing](/pricing).
- Codex can use a membership's included AI allowance when the site and your
  account provide one. Claude Code works with your personal Claude Pro or Max
  subscription and does not use the membership allowance.

## Find a page by task

- AI agents: [AI Agents in CoCalc](/features/ai)
- Notebooks and documents: [Jupyter Notebooks](/features/jupyter-notebook),
  [LaTeX Editor](/features/latex-editor)
- Languages: [Python](/features/python),
  [R Statistical Software](/features/r-statistical-software),
  [Julia](/features/julia), [SageMath](/features/sage),
  [GNU Octave](/features/octave)
- Linux: [Linux Terminal](/features/terminal),
  [Linux Graphical Applications](/features/x11)
- Teaching: [Teaching a Course](/features/teaching),
  [Computational Exam Scratchpads](/features/exam-scratchpads)
- Everything else: [Features](/features) and [Docs](/docs)
`;
