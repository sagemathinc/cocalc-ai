# Codex Operator Agent Spec

Status: proposed spec as of 2026-04-18.

This document specifies how Codex should become an explicit part of operating a
Launchpad or Rocket deployment in production.

The goal is not to make Codex a vague "AI helper". The goal is to define an
operator agent layer with explicit inputs, explicit outputs, bounded
permissions, and a durable audit trail.

This should be treated as a cross-cutting operational capability that sits on
top of:

- the scalable multibay control plane
- project-host lifecycle and rollback management
- cluster health / monitoring / backup verification
- operator-facing admin APIs

## Motivation

Recent development has already shown the real pattern:

- Codex can inspect logs, metrics, and state
- Codex can diagnose subtle distributed failures correctly
- Codex can often propose or implement a narrow fix quickly
- Codex can operate effectively when the system exposes explicit control and
  observability surfaces

This is important enough that it should be designed into the product and
architecture deliberately.

## Core Model

Codex should be an operator agent with four explicit modes:

1. Scheduled review
2. Event-driven investigation
3. Guarded remediation
4. Human escalation / reporting

Codex should not be treated as an unrestricted shell with vague authority. It
should preferentially operate through explicit read and write APIs, structured
observability inputs, and durable logs of what it did.

## Goals

- detect operational problems earlier
- reduce operator toil for diagnosis and low-risk remediation
- standardize the recurring "Codex investigates the problem" workflow
- make operations more reproducible and auditable
- reduce dependence on one expert manually inspecting logs in a shell

## Non-Goals

- fully autonomous cluster control without human oversight
- replacing monitoring / alerting / dashboards
- bypassing existing auth, approval, or rollback mechanisms
- treating Codex as the source of truth instead of logs, metrics, and runtime
  state

## Operational Principles

### 1. Observe First

Codex should begin with structured observation before action:

- current bay / host / project inventory
- recent alerts
- health summaries
- logs
- relevant deployment or config changes
- recent remediation history

### 2. Prefer Explicit APIs Over Ad Hoc Shell Access

Shell access will still exist, but it should be the fallback. The intended
operational path should use:

- health snapshot APIs
- read-only inventory APIs
- safe remediation APIs
- host lifecycle APIs
- rollout / rollback APIs

This is better for:

- auditability
- replayability
- permission control
- reliability under automation

### 3. Small, Bounded Actions

Codex should be allowed to perform only narrow, well-understood actions without
human approval.

Good examples:

- restart one daemon
- retry one failed backup sync
- mark one host unschedulable
- trigger one known-good rollback

Bad examples:

- broad config rewrites
- schema changes
- large fleet restarts
- anything with unclear blast radius

### 4. Every Action Must Be Recorded

Every Codex-triggered investigation or remediation should leave a durable
record:

- why it ran
- what inputs it saw
- what it concluded
- what it changed
- what happened afterward

## Agent Modes

## 1. Scheduled Review

Codex runs periodically, for example every 15 minutes, hourly, or daily,
depending on the check.

Example checks:

- backup freshness and push status
- bay health and inter-bay lag
- project-host health
- rollout / rollback anomalies
- spot instance churn
- stale hosts or stale registry state
- disk / quota / storage drift
- growing error rates

Output:

- compact operator report
- anomaly list
- suggested follow-up actions
- optional issue/comment/page if thresholds are crossed

## 2. Event-Driven Investigation

Codex runs in response to monitoring or system events.

Example triggers:

- elevated 5xx rate
- repeated auth/bootstrap failures
- host flapping
- replay backlog crossing threshold
- backup gap
- spot preemption spike
- failed upgrade or rollback

Input to the run:

- triggering event payload
- related recent logs and metrics
- current ownership/routing state
- recent deploy/change context

Output:

- diagnosis summary
- confidence level
- likely root cause
- suggested next step
- optional safe remediation plan

## 3. Guarded Remediation

Codex may take action automatically only in predefined, low-blast-radius cases.

Candidate actions:

- restart `conat-router`, `conat-persist`, `acp-worker`, or `project-host`
- align runtime stack on one host
- trigger known-good rollback for one host
- mark a failing host unschedulable
- retry a failed backup verification or upload task
- restart a stuck bay-local service

Requirements:

- predeclared action type
- explicit target
- bounded blast radius
- retry and rollback semantics
- durable audit record

## 4. Human Escalation / Reporting

Codex should escalate when:

- confidence is low
- blast radius is nontrivial
- the diagnosis conflicts with recent operator intent
- remediation would affect multiple hosts, bays, or many users
- repeated safe remediation has failed

Escalation targets may include:

- email
- Slack
- incident system
- GitHub issue or comment
- Launchpad operator UI

## Permission Model

Permissions should be explicit and tiered.

### Observe

Read-only access to:

- health snapshots
- logs
- metrics
- inventory
- rollout state
- backup state

### Recommend

Everything in `observe`, plus:

- write durable recommendations
- create incidents/issues/comments
- propose but not perform actions

### Safe-Act

Everything in `recommend`, plus a small allowlist of low-risk remediations.

### Admin-Act

Reserved for human-approved or emergency-supervised flows. This should be rare
and auditable.

## Required Inputs

To make this system reliable, the operator agent needs first-class read models.

### Cluster Health Snapshot

One read API should summarize:

- bays
- hosts
- project-host runtime state
- attached bay registry state
- inter-bay lag / replay state
- recent rollouts / rollbacks
- backup freshness
- spot/on-demand distribution

### Inventory And Mapping Surfaces

Operator-readable mapping for:

- account -> home bay
- project -> owning bay
- host -> host bay
- project -> assigned host
- host -> current runtime version / desired version

### Structured Error/Event Feed

Codex should receive a normalized event stream rather than scraping arbitrary
text everywhere.

Examples:

- auth/bootstrap failures
- routing failures
- stale ownership mismatches
- project-host runtime crashes
- upgrade/rollback events
- backup failures

### Deployment / Change Context

Codex diagnosis gets materially better when it knows:

- recent code deploys
- runtime image changes
- config changes
- rollout exceptions
- recent manual operator actions

## Required Outputs

Each run should produce a durable artifact.

Minimum schema:

- run id
- trigger type
- trigger payload summary
- relevant scope
- evidence links
- diagnosis
- confidence
- recommended actions
- actions actually taken
- outcome
- follow-up needed

## Safe Remediation Surface

The operator agent should not depend on raw shell commands for common actions.
Provide explicit admin APIs for:

- restart daemon
- align runtime stack
- trigger host rollback
- mark host unschedulable
- retry backup-related jobs
- clear or requeue specific stuck orchestration tasks

Each API should include:

- target
- requested by
- reason
- idempotency behavior
- timeout behavior
- rollback behavior where applicable

## Audit And Compliance Requirements

Every Codex run and every Codex action should be logged durably.

Audit log fields:

- who or what triggered it
- exact time
- model/agent identity
- permission tier used
- affected resources
- summary of reasoning
- action details
- result

For operator trust, there must be a clean answer to:

- why did Codex do this?
- what evidence did it use?
- what changed?
- how do we undo it?

## Integration With Monitoring

Codex should integrate with monitoring as a consumer and investigator, not as a
replacement.

Recommended flow:

1. Monitoring detects anomaly.
2. Monitoring emits structured event.
3. Codex investigation run starts.
4. Codex writes diagnosis artifact.
5. If allowed, Codex performs one safe action.
6. Monitoring confirms whether the action helped.
7. If unresolved, human is paged with the full context.

## Integration With Launchpad / Rocket Admin UI

This should not remain shell-only.

The admin UI should eventually expose:

- recent Codex investigations
- recent Codex remediations
- current agent findings
- open recommendations
- explicit approve/deny controls for high-risk actions

This is important because production operators should not have to infer agent
activity from raw logs.

## Relationship To Current Architecture Phases

This operator-agent layer is not a separate unrelated feature. It depends on
and reinforces the current architecture work.

It particularly depends on:

- Phase 5 multibay observability and validation
- Phase 6 project-host placement/lifecycle clarity
- project-host runtime split and rollback mechanisms
- explicit inventory and ownership mappings

It should therefore be treated as a cross-cutting operational milestone that
should begin now, not after the rest is "done".

## Initial Milestones

### Milestone 1: Observe-Only Health Review

Deliver:

- one cluster health snapshot API
- one periodic Codex review turn
- one durable report artifact

No automated actions yet.

### Milestone 2: Event-Driven Investigation

Deliver:

- alert/event integration
- structured diagnosis artifacts
- operator-visible investigation history

Still no automatic mutation by default.

### Milestone 3: Safe Remediation

Deliver a very small allowlist of auto-actions:

- restart one daemon
- mark one host unschedulable
- trigger one rollback
- retry one bounded backup-related task

### Milestone 4: Operator UI And Approval Flow

Deliver:

- view of investigations and actions
- approve/deny flow for higher-risk actions
- explicit incident escalation workflow

## Suggested First Use Cases

Start where Codex is already high leverage:

- backup freshness verification
- host flapping diagnosis
- project-host daemon crash diagnosis
- failed rollout / rollback triage
- inter-bay lag / stale directory diagnosis
- spot instance churn review

These are repetitive enough to automate and structured enough to bound safely.

## Open Questions

- where should investigation artifacts live long-term: Postgres, object store,
  or both?
- should scheduled Codex runs be launched by one seed-bay scheduler or by a
  separate ops service?
- which safe remediation APIs should exist before any automatic mutation is
  enabled?
- what is the right operator-facing UI surface: Launchpad admin pages, GitHub,
  Slack, or some combination?
- how much historical context should be passed into each run by default versus
  fetched on demand?

## Recommended Next Step

The next concrete step should be Milestone 1 only:

- define the cluster health snapshot API
- define the durable investigation/report artifact
- implement a scheduled observe-only Codex health review turn

Do not start with autonomous remediation. Start with consistent observation,
reporting, and operator trust.
