# CoCalc.ai Framing Research Register

Created: 2026-06-20. Internal source-backed research register for public-site
framing. This does not approve public copy. It records what the research
implies for positioning.

## Operating Rules

- Use official product sources first.
- Record access dates for external sources.
- Named-product observations are `Needs refresh` before publication.
- Do not import competitor language into public copy. Convert it into a
  category-level implication.
- When a source is stale, missing, or contradicted, downgrade the public claim
  to a conservative category statement.
- Public product capability claims must also be checked against the current
  `github.com/sagemathinc/cocalc-ai` source tree. Pitch docs and shared audits
  can guide framing, but shipped copy should trace to code, docs, tests, or
  assets in the repo.

## Internal Pitch Grounding

Accessed 2026-06-20 from `/home/user/cocalc-ai/docs/pitch`.

| Source                                                  | Durable implication                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-portfolio-and-naming-memo.md`                       | CoCalc.ai is the hosted flagship; CoCalc Plus, Star, Launchpad, Rocket, and CLI are distinct product paths. Internal architecture names should not anchor general-market copy. |
| `04-pitch-architecture.md`                              | The ecosystem pitch must prove one coherent workspace layer, reviewability/recoverability, deployment-family coherence, and AI integrated into the workspace.                  |
| `07-proof-and-claims-matrix.md`                         | Public proof must stay qualitative unless a gate supports numbers. Trust, migration, scale, and benchmark claims need explicit proof/approval.                                 |
| `12-public-portfolio-memo.md`                           | Public story should be one workspace across technical artifacts, reviewable/recoverable work, and hosted/local/private options.                                                |
| `16-differentiators-and-strategic-wedges.md`            | The wedge is persistent multi-artifact technical workspace context, not "we have AI" or "we run an agent."                                                                     |
| `20-message-risks-and-red-flags.md`                     | Avoid category collapse into AI IDE, notebook platform, cloud coding agent, sandbox API, prompt-to-app, or private AI cloud.                                                   |
| `23-legacy-strengths-to-preserve.md`                    | Preserve recoverability, collaborative notebooks, teaching/workshop roots, technical writing, contextual discussion, and standardized environments.                            |
| `24-stakeholder-map-and-hidden-buyers.md`               | Write for champions, platform/IT operators, security/compliance reviewers, procurement/legal, executive sponsors, and end users who did not choose the tool.                   |
| `30-research-computing-and-academic-ops-positioning.md` | Research labs, departments, workshops, and advanced teams are credible; full institutional HPC-center claims are not launch-safe without stronger evidence.                    |
| `73-customer-journey-simulations.md`                    | Each page should answer the next obvious buyer/user question and route blocked policy claims back to the controlling gate.                                                     |
| `74-evidence-freshness-register.md`                     | Fast-changing named-product, pricing, trust, model, deployment, admin, and benchmark claims must be refreshed before public or important sales use.                            |
| `75-agent-self-audit.md`                                | Prefer updating existing source-of-truth artifacts over creating meta-doc sprawl; do not strengthen public claims to compensate for missing human input.                       |

## Validated Framing Principles Folded In

Accessed 2026-06-20 from `/home/user/cocalc-ai/docs/pitch/pitch`,
`/home/user/cocalc-ai-synthesis/src`, and
`/home/user/cocalc-shared/framing-principles-digest-2026-06-20.md`.

| Principle                         | Status                                | Source evidence                                                                                                                                                                                                                                                                                                                                                                                                                        | Durable implication                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category-collapse bans            | Public-safe guardrail                 | `20-message-risks-and-red-flags.md` names risks around AI IDE, notebook platform, private AI infrastructure, cloud coding agent, sandbox API, and prompt-to-app framing; `16-differentiators-and-strategic-wedges.md` says CoCalc should avoid weaker category collapse.                                                                                                                                                               | Public copy must not define CoCalc as any adjacent specialist category. Use those categories only as internal market context.                                                                           |
| Proof surfaces are not the wedge  | Public-safe guardrail                 | `docs/landing-page-brief.md` treats automation/CLI/API as proof surfaces; `src/packages/docs/src/content/automation.ts` and CLI source show typed automation workflows, not a separate category promise.                                                                                                                                                                                                                               | CLI, API, automations, browser automation, and compute hosts can prove the workspace story, but should not be the homepage wedge or default buying path.                                                |
| Claim discipline and proof gates  | Public-safe guardrail                 | `07-proof-and-claims-matrix.md`, `39-proof-evidence-benchmark-sheet.md`, and `74-evidence-freshness-register.md` gate trust, pricing, migration, customer, benchmark, scale, reliability, performance, cost, and similar claims.                                                                                                                                                                                                       | Use qualitative workflow language unless the exact stronger claim has repo evidence plus the controlling approval/proof gate.                                                                           |
| Public naming vs technical naming | Approved internal-grounding guardrail | `01-portfolio-and-naming-memo.md` maps `project host` to `compute host` for public-facing translation and warns against exposing `bay` / `Conat`; Blaec approved option A for public "Dedicated compute" / "compute host" with technical routes/docs unchanged.                                                                                                                                                                        | Public buyer copy should translate technical labels; docs/routes/UI internals may keep implementation terms when they are user-facing technical documentation.                                          |
| Bounded agent compatibility       | Public-safe guardrail                 | `src/packages/ai/acp/codex-app-server.ts` instructs agents to call the CoCalc CLI, `browser files`, and `project jupyter exec`; `src/packages/cli/src/bin/commands/browser.ts` implements `browser files`, `browser workspace-state`, and `browser exec`; `src/packages/cli/src/bin/commands/project/jupyter.ts` implements `project jupyter exec --path ... --stdin`. No source-backed native MCP integration was found in this pass. | Public copy may say scripts and shell-capable agents can use CLI commands. It must not imply native compatibility with every agent platform or MCP until source and product framing support that claim. |

## External Official-Source Scan

Accessed 2026-06-20.

| Source                                                                                                       | Category signal                                                                                                                                             | CoCalc implication                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jupyter home, https://jupyter.org/                                                                           | JupyterLab is framed as a web-based environment for notebooks, code, and data; Jupyter supports many languages and shareable notebook documents.            | Notebook breadth is a real buyer expectation. CoCalc should show notebooks as one durable artifact inside the broader project, not merely "we support notebooks."                                           |
| JupyterHub, https://jupyter.org/hub                                                                          | JupyterHub is multi-user notebook infrastructure for companies, classrooms, and research labs with shared computational environments.                       | CoCalc should not overclaim as a generic JupyterHub replacement. Emphasize project continuity across notebooks, files, terminals, documents, history, and collaboration.                                    |
| Google Colab, https://colab.google/                                                                          | Colab leads with zero setup hosted notebooks, preconfigured runtimes, compute access, sharing, Google Drive, and AI embedded in notebook work.              | Hosted/no-setup notebook value is table stakes. CoCalc needs to make the surrounding project, review, recoverability, and deployment model the difference.                                                  |
| GitHub Codespaces, https://docs.github.com/codespaces/overview                                               | Codespaces is a cloud-hosted development environment tied to repositories, containers, VMs, dev-container configuration, and browser/VS Code/CLI access.    | CoCalc should avoid competing as just a cloud IDE. Its stronger axis is research/project continuity across repo and non-repo artifacts.                                                                     |
| Overleaf for enterprises, https://www.overleaf.com/for/enterprises                                           | Overleaf centers collaborative LaTeX/scientific writing, versioning, support, and cloud/on-prem options for research and technical teams.                   | CoCalc should preserve technical-writing and LaTeX credibility, but frame it as part of the same computational project rather than a standalone writing product.                                            |
| Replit Agent docs, https://docs.replit.com/references/agent/overview                                         | Replit Agent centers plain-language creation of apps, designs, slides, artifacts, setup, checks, fixes, and deployment.                                     | CoCalc should not sound like prompt-to-app. Public copy should stress reviewable technical work and project context, not no-code creation.                                                                  |
| Posit Cloud, https://posit.cloud/                                                                            | Posit Cloud is framed as browser access to Posit data-science tools without installation or complex configuration.                                          | R/data-science pages should be practical and workflow-specific, not generic language support.                                                                                                               |
| Deepnote, https://deepnote.com/                                                                              | Deepnote frames a data workspace for humans and agents, with notebooks, data apps, context, automation, and AI-assisted analysis.                           | Data-workspace competitors are moving toward "humans plus agents." CoCalc should differentiate through multi-artifact technical workspace depth and deployment choice, not generic "AI workspace" language. |
| Hex docs, https://learn.hex.tech/docs                                                                        | Hex is a collaborative workspace for data science and analytics with SQL, Python, no-code, AI, data apps, reports, collaboration, reviews, and permissions. | For analytics-heavy pages, CoCalc should not imply it is a better BI/data-app product. Its fit is technical teams whose analysis also needs code, terminals, files, documents, and project history.         |
| OpenAI Codex, https://openai.com/index/introducing-codex/                                                    | Codex is a cloud software-engineering agent for well-scoped code tasks, diffs, tests, documentation, and review, running in isolated cloud containers.      | Do not make CoCalc sound like another coding agent. Agents are proof surfaces inside a larger workspace where the work remains connected to notebooks, files, terminals, and review context.                |
| GitHub Copilot cloud agent, https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent | Copilot cloud agent is an autonomous GitHub workflow agent for issues/prompts, branches, plans, changes, and optional PRs.                                  | Public CoCalc copy should avoid repo-to-PR positioning as the headline. CoCalc can coexist with coding agents by preserving the broader technical project context.                                          |

## Current Framing Conclusions

1. The market has converged on AI inside specialist tools. CoCalc must not lead
   with "AI" alone.
2. The strongest differentiated frame is durable project continuity across
   multiple technical artifacts.
3. Research, R&D, engineering, teaching, and technical writing belong together
   only when they are explained through the project-workflow spine.
4. Feature pages should route consistently. A feature-index tile that goes to
   docs breaks trust unless it is visibly a docs tile.
5. The public site needs fewer generalized cards and more route-owned visitor
   questions.
6. Named-product comparisons are useful internally but should stay off public
   pages until refreshed and approved.
7. Automation is valuable as mechanism and proof; it should not become the
   headline.

## Open Questions

| Question                                                                          | Why it matters                                                            | Next safe action                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Which feature pages should exist as local public pages versus docs bridges?       | Inconsistent routing makes the site feel unfinished.                      | Audit `/features` cards and add local pages only when they answer a public visitor question.        |
| How much product-depth should feature detail pages expose before linking to docs? | Too much text reduces scan quality; too little feels shallow.             | Use one hero, one workflow explanation, one proof section, one next step; put setup detail in docs. |
| Which legacy teaching/course strengths belong in current public IA?               | Teaching is a real adoption path but not the first enterprise-sales lead. | Keep teaching visible as workflow proof, not a product path.                                        |
| Can we support stronger research-computing claims?                                | Labs are credible, full institutional HPC is not yet launch-safe.         | Keep current copy lab/department/team scoped unless proof gates change.                             |

## Maintenance Procedure

When future research changes the framing:

1. Add or amend a row in this register.
2. State whether the row is `Public-safe`, `Internal grounding`,
   `Needs refresh`, or `Needs approval`.
3. If it changes site behavior, add one line to `docs/landing-page-decisions.md`.
4. If it creates work, add or update the current `src/.agents/public-site-*-workplan*.md`.
5. If it contradicts the Brief, do not edit public copy directly. Use the
   human-gated pitch-challenge route.
