# CoCalc.ai Public Site Framing System

Created: 2026-06-20. Internal operating document.

## Purpose

This document turns the pitch package and external market research into a
repeatable framing system for public-site work. It is not public copy. It is
the check that prevents feature pages from drifting into generic AI, notebook,
coding-agent, runtime, or docs-handoff language.

Use it before editing public React routes, metadata, cards, CTAs, page
headlines, or feature descriptions.

## Protected Framing

The frozen Brief still wins:

- Promise: make computational work easier to share, review, and continue.
- Category support: AI-native technical workspace.
- Proof spine: continuable project work, reviewability/recoverability,
  deployment choice.
- Primary audience: research labs, R&D and engineering groups, advanced
  technical teams.
- Buyer audience: executive and operating-model decision-makers.
- Teaching: valued and visible, but not the enterprise-sales lead.

Do not replace this with a new category because a competitor page has sharper
language. Competitor research is for contrast, not copy.

## Market Map

Adjacent products win by being narrow and clear:

- Notebook environments center notebooks, data, kernels, and shareable
  computational documents.
- Multi-user notebook systems center shared notebook infrastructure and
  preconfigured environments.
- Cloud development environments center repo-based coding in configured
  containers or VMs.
- Coding agents center delegated software tasks, branches, diffs, and review.
- Prompt-to-app systems center turning plain-language ideas into applications
  and artifacts.
- Data workspaces center analysis, dashboards, data apps, and governed
  business context.
- Technical-writing tools center collaborative documents, LaTeX, versioning,
  and publication workflows.

CoCalc should not claim to beat each specialist on its strongest axis. The
public-site advantage is the durable project workspace where code, notebooks,
documents, terminals, data, runtime evidence, collaborators, AI work, history,
and deployment boundaries stay together.

## Value Rules

1. Lead with the job the visitor is trying to finish.
2. State the concrete capability and the "so what" outcome.
3. Prefer one durable project-workflow example over a list of features.
4. Put automation, CLI, and API surfaces in the proof layer, not as primary
   buying paths.
5. Keep docs links as supporting links. A feature-index card that looks like a
   feature card should route to a feature page unless it is explicitly styled
   as a docs bridge.
6. Do not turn internal architecture into marketing terms. Translate internal
   terms into user-facing outcomes.
7. Do not use named competitor claims in public copy unless refreshed from
   official sources and approved for publication.
8. No numbers, benchmarks, restore/setup/deploy timing, security/compliance,
   customer, or cost-saving claims without the controlling proof gate.
9. Human review is part of the value. Do not imply AI output is the finish
   line.
10. Bias to subtraction: if the visitor already understands the point, remove
    the extra sentence.

## Validated Guardrails

These rules are durable guardrails for every public-site agent. They are
validated against the pitch package, current source-code behavior, or an
approved product decision. If a future edit needs to weaken one, record the
evidence and route it through the pitch-challenge path before public copy
changes.

1. Do not collapse CoCalc into a narrower category. Avoid framing CoCalc as an
   AI IDE, notebook platform, Jupyter replacement, cloud coding agent, sandbox
   or runtime API, prompt-to-app builder, sovereign/private AI cloud, or agent
   cloud. These categories can appear as adjacent markets in internal analysis,
   not as the public identity.
2. Treat CLI, HTTP API, automations, browser automation, and compute hosts as
   proof/mechanism surfaces. They may get detail pages when they answer a
   visitor question, but they should not become the wedge, homepage headline,
   or default primary buying path. Mechanism pages generally use docs-first
   CTAs, with conversion CTAs subordinate to the workflow.
3. Gate strong claims. No trust, security, compliance, customer, pricing,
   migration, benchmark, setup-time, restore-time, scale, capacity,
   reliability, cost-saving, or performance claims go public unless the
   controlling proof gate supports that exact line. Use qualitative workflow
   wording when measured proof or approval is absent.
4. Keep public naming and technical naming separate. Public copy should use
   buyer-facing labels, while docs/routes/UI internals may retain implementation
   terms. Example: public "Dedicated compute" / "compute host"; technical
   docs/routes may still say "project host." Never surface implementation
   architecture such as RootFS, bay, Conat, control/data plane, placement, or
   runtime policy as marketing copy.
5. Bound agent-compatibility claims to implemented behavior. CoCalc has CLI and
   project/browser command surfaces that shell-capable agents can call. Do not
   imply native support for every external agent platform or MCP integration
   unless that exists in the source and has an approved public frame.
6. Verify product capability claims against the current repository before they
   ship. Pitch notes and shared audits can guide framing, but any public claim
   about what CoCalc does must be traceable to code, docs, tests, or assets in
   the current `github.com/sagemathinc/cocalc-ai` source tree.

## Route Frame

Every route or section edit must have this frame before source changes:

```md
Route:
Visitor:
Visitor question:
One-sentence promise:
Proof mechanism:
Primary next step:
Secondary next step:
What this must not claim:
Evidence consulted:
Decision: keep / omit / combine / move lower / disclose / redesign
```

If the frame cannot be filled in, do not write copy yet. Research or ask a
question first.

## Claim Classes

- `Public-safe`: directly supported by the Brief, current product behavior, or
  approved wording.
- `Internal grounding`: useful for writing direction, not public copy.
- `Needs refresh`: about a named product, pricing, trust, model support,
  enterprise control, benchmark, or fast-changing capability.
- `Needs approval`: trust/compliance, customer proof, metrics, named
  competitor comparison, support boundary, migration, pricing, or
  contract-dependent language.
- `Do not use`: category-collapse wording, internal jargon, unapproved
  superlatives, or a claim that suggests mature proof we do not have.

Public routes should use only `Public-safe` claims. Everything else stays in
planning docs, sales packets, or explicit approval flows.

## Learning Loop

Use this loop for every public-site round:

1. Read the route frame and current workplan.
2. Check the research register for relevant internal and external evidence.
3. Make one change that advances a Brief proof-point or a ranked punch-list
   item.
4. Verify the route and collect a screenshot or browser observation.
5. Record what changed in the ledger and commit message.
6. If user feedback changes the principle, update the framing system,
   research register, decisions log, or workplan before the next edit.
7. If research contradicts the Brief, do not rewrite public copy directly.
   Record the contradiction and route it through the human-gated pitch
   challenge path.

## Quality Bar For Future Agents

A useful public-site edit should make at least one of these truer:

- A target visitor can tell whether the page is for them.
- The page explains a concrete workflow, not a product inventory.
- The next click is consistent with the card or CTA that offered it.
- The claim is more bounded, not merely louder.
- The page removes a point that was repeating, generic, or internally focused.

If none of those are true, stop and say the change would be churn.
