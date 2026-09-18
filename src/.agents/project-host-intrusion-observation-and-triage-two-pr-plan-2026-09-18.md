# Project-host intrusion observation and triage: two-PR plan

**Date:** 2026-09-18  
**Status:** Proposed  
**Audience:** CoCalc engineering, operations, and security reviewers  
**Disclosure:** This is a public-safe architecture and implementation plan. It
does not describe a known exploitable vulnerability or confidential incident.

## 1. Purpose

CoCalc's project-host intrusion snapshot monitor currently combines three
different responsibilities:

1. collecting bounded host security state;
2. comparing that state with prior or fleet observations; and
3. deciding which differences should directly notify administrators.

The first two responsibilities are useful. The third currently produces enough
false-positive email and in-product notifications that operators cannot treat
the channel as an actionable security signal.

This plan separates observation from notification in two focused pull
requests. It is deliberately a bridge to CoCalc's broader automated
intrusion-detection and provider-neutral evidence-plane designs.

It must not create a second event envelope, general-purpose SIEM, competing
rule language, or incompatible incident model.

The desired operating model is:

```text
project-host collector
        |
        v
durable observations + coverage + decisions
        |
        v
periodic deterministic review
        |
        +--> inventory/diagnostic history, health report, digest
        |
        +--> stable incident --> notification on incident transition
```

Routine observations are retained without notifying administrators. A
notification means that an explicit rule with sufficient evidence has opened,
escalated, or reopened a durable incident.

## 2. Architectural decisions

### 2.1 The snapshot monitor is a sensor and reconciliation detector

Keep the current periodic collector. It provides bounded state snapshots,
detects drift that an event sensor can miss, and remains useful before and after
the external evidence plane exists.

The collector may normalize, compare, classify, and record a decision. It must
not directly turn every selected delta into an administrator notification.

### 2.2 Observations, findings, and incidents are different objects

- **Observation:** Collected state, coverage, and a raw normalized delta.
- **Finding:** A versioned deterministic assessment of one or more
  observations. A finding can be inventory, diagnostic, actionable, critical,
  or coverage loss.
- **Incident:** A durable operator-facing lifecycle created only when a rule's
  evidence requirements are satisfied.

Notification happens from incident lifecycle transitions, not from collection
or individual findings.

### 2.3 Suppression never deletes evidence

Expected maintenance, fleet correlation, known package changes, and other
explanations can suppress incident promotion. They must not remove the original
observation or decision. A later detector version must be able to reevaluate
retained observations.

### 2.4 Current local PostgreSQL state is a projection

These PRs may use the bay database for the current operational projection. They
must use fields and semantics compatible with the planned common evidence
envelope. They must not claim that bay-local records are immutable against a
compromised bay or host.

Each project's host and its observations remain authoritative in the owning
bay. Cross-bay review must use explicit routed aggregation or the future
security evidence plane, not direct assumptions that one local database owns
the fleet.

### 2.5 Deterministic rules are authoritative

An agent can summarize evidence, group likely operational changes, and suggest
investigation. Agent output must not be the only gate for a critical page,
baseline approval, suppression, or automatic containment.

The initial rule set should be small, versioned, tested, and conservative. An
empty notification allowlist is acceptable while rules are in shadow mode.

### 2.6 Abuse and intrusion remain separate

Ordinary customer processes, builds, shells, package installation, and
suspiciously named binaries inside an authorized project are not host
intrusion evidence by themselves. Crypto mining, spam, and other misuse belong
to the abuse pipeline unless there is evidence of a trust-boundary crossing.

Project-host intrusion rules focus on the host namespace, CoCalc control
services, managed privileged state, sensor integrity, and cross-boundary
behavior.

## 3. PR 1: Decouple evidence collection from administrator notification

### 3.1 Goal

Make the snapshot monitor reliably collect and preserve reviewable evidence
without directly sending routine transition or initial-baseline alerts.

This PR changes the output boundary, not the collector's scope. It should be
small enough to review independently and safe to deploy before PR 2.

### 3.2 Required behavior

1. Continue collecting the same bounded source snapshot and coverage state.
2. Continue computing and storing the complete normalized delta, including
   differences that are not currently considered actionable.
3. Continue deterministic classification and transient-change confirmation
   independently of whether notifications are enabled.
4. Persist the observation and its decision before advancing the comparison
   baseline.
5. Stop direct `adminAlert` delivery for host transitions and newly established
   baselines in the normal mode.
6. Represent sustained collection failure as durable coverage evidence for PR
   2 rather than repeatedly emailing from the collector.
7. Preserve an explicit, temporary rollback mode for legacy notification
   behavior. The rollback switch must affect delivery only, not evidence
   collection or classification.

### 3.3 Important correction to the current alert-mode boundary

The existing `COCALC_HOST_INTRUSION_MONITOR_ALERT_MODE=off` behavior is not a
sufficient implementation. Alert mode currently participates in selecting the
delta, confirming transient Snap changes, deciding whether a snapshot is
deferred, and determining when a baseline advances.

PR 1 should split this into independent concepts:

- **collection and decision policy:** always active when the monitor is active;
- **notification delivery policy:** legacy, incidents-only, or disabled; and
- **diagnostic verbosity:** whether reports expose all retained categories.

Turning off email must not turn off classification, confirmation, or durable
decision recording.

### 3.4 Storage and compatibility

Prefer extending the existing snapshot projection over creating a new generic
event system in this PR. Each complete snapshot should retain enough bounded
decision metadata to support PR 2:

- source snapshot ID;
- observation time and receipt time;
- bay ID and host ID;
- collector, normalization, and decision-policy versions;
- coverage and truncation state;
- raw normalized delta;
- stable observation fingerprint;
- classification and reason codes;
- transient-confirmation state, where applicable;
- baseline used for comparison; and
- baseline eligibility.

Use the names and types from the planned common evidence envelope where doing
so is straightforward. Do not add signing, hash chains, external transport, or
locked retention in this PR.

The observation fingerprint should be deterministic over versioned normalized
input. It is an idempotency and correlation key, not proof that the host is
honest.

### 3.5 Baseline semantics

Notification delivery must no longer be the commit protocol for a security
baseline.

Use this order instead:

1. collect and normalize the source snapshot;
2. compare against the selected prior observation;
3. persist the snapshot, full delta, decision, and baseline provenance
   durably;
4. only then mark it eligible as the next comparison point.

Pending transient confirmation remains ineligible until resolved. Incomplete
coverage must not become a complete baseline. First observation and fleet
consensus remain observations, not proof of approved state.

This preserves the reason behind the existing alert-before-baseline behavior:
a change cannot be silently absorbed. The guarantee becomes stronger because
it depends on durable evidence rather than successful email delivery.

### 3.6 Direct notification policy after PR 1

The collector should emit no routine transition or initial-baseline
notifications in the new default mode.

Collector process failure should continue to use normal service health
monitoring and logging. Coverage loss should be stored and exposed to the
reviewer. If an emergency direct coverage path is retained during migration,
it must be fleet-aggregated, persistence-gated, strongly deduplicated, and
clearly labeled as monitoring coverage rather than evidence of intrusion.

PR 1 must not introduce new automatic containment.

### 3.7 Expected file scope

Keep changes concentrated in:

- `src/packages/server/hosts/intrusion-monitor.ts`;
- `src/packages/server/hosts/intrusion-monitor.test.ts`; and
- a small shared type or schema file only if needed to avoid untyped JSON.

Do not add UI, external evidence shipping, agent orchestration, cloud
infrastructure, or a general incident table in PR 1.

### 3.8 Tests

Add focused tests proving:

- an actionable-looking delta is fully persisted without calling
  `adminAlert`;
- initial baseline establishment does not notify;
- raw and classified deltas survive notification-disabled mode;
- transient Snap confirmation still runs when delivery is disabled;
- incomplete coverage is retained and never becomes a complete baseline;
- evidence is committed before baseline advancement;
- a persistence failure does not advance the baseline;
- legacy delivery mode changes only delivery behavior;
- notification failure in legacy mode cannot erase already committed
  evidence; and
- all arrays, strings, and formatted diagnostic output remain bounded.

### 3.9 Acceptance criteria

- Production can run for a full monitor interval with zero routine
  intrusion-transition or initial-baseline notifications.
- Every collected complete snapshot still has its full normalized delta and
  decision available for review.
- Existing transient confirmation and coverage tests continue to pass.
- There is a documented rollback switch, but collection correctness does not
  depend on it.
- No request path or project data-plane path gains a synchronous dependency on
  the monitor.

## 4. PR 2: Add periodic deterministic review and incident lifecycle

### 4.1 Dependency and goal

PR 2 depends on the durable observation and decision boundary from PR 1. It
adds a small scheduled reviewer that consumes observations idempotently,
correlates them with bounded context, and maintains stable incidents.

It does not implement the complete external evidence plane. Its schemas and
semantics should be reusable by that future detector.

### 4.2 Reviewer execution model

Run one advisory-lock-protected reviewer per authoritative bay. Persist a
durable cursor or equivalent processed watermark. Processing must be
at-least-once and idempotent:

- a crash before commit causes safe reevaluation;
- duplicate observations do not create duplicate incidents;
- a notification failure does not roll back evidence or incident state; and
- an observation arriving late can update the correct incident window.

The reviewer should run after collection and on its own bounded schedule so a
missed collection callback does not permanently prevent review.

The query must be bounded by time, row count, and execution duration. Backlog
and oldest-unreviewed age are health signals.

### 4.3 Initial deterministic rule model

Each rule records:

- stable rule ID and version;
- owner;
- input evidence classes and required coverage;
- correlation window;
- classification and severity;
- expected-change matching requirements;
- incident fingerprint fields;
- notification policy;
- resolution condition;
- bounded evidence summary; and
- test fixtures and runbook reference.

Start with a deliberately small catalog. Most current snapshot differences
should initially be inventory or diagnostic. Rules remain in shadow mode until
staging fixtures and production observation history establish acceptable
precision.

Useful correlation available at this stage includes:

- persistence across multiple complete snapshots;
- recurrence after an apparent resolution;
- multiple related categories changing on one host;
- the same bounded change appearing across a fleet during a deployment window;
- host-local versus fleet-local novelty;
- known deployment or maintenance identifiers where available; and
- simultaneous coverage degradation.

Do not infer that fleet consensus is approved state. Do not promote a finding
based only on an arbitrary anomaly score.

### 4.4 Expected-change matching

Expected changes suppress notification, not evidence. Matching should be
explicit and bounded by:

- deployment or maintenance ID;
- bay and host scope;
- affected categories;
- start and expiry time;
- actor or approving identity when available; and
- reason.

If authoritative expected-change records are not yet available, PR 2 should
support only narrowly configured, expiring matches. It must not grow a broad
permanent ignore list.

### 4.5 Incident projection

Add a small bay-local incident projection with at least:

- stable incident ID and fingerprint;
- bay and affected host IDs;
- rule ID and rule version;
- severity and confidence class;
- state: open, acknowledged, resolved, or suppressed;
- first seen, last seen, opened, updated, and resolved times;
- observation IDs and bounded evidence summary;
- occurrence count;
- expected-change or suppression reference and expiry;
- notification state and last notification transition; and
- operator disposition and audit metadata.

Incident updates must be monotonic and transactionally idempotent. A repeated
review pass may increment evidence or last-seen state, but must not emit a new
notification unless the incident opens, materially escalates, or reopens after
resolution.

The local incident table is an operational projection, not the eventual
immutable archive.

### 4.6 Notification policy

Use the planned classes consistently:

| Class         | PR 2 behavior                                                                                |
| ------------- | -------------------------------------------------------------------------------------------- |
| Inventory     | Retain and expose in health detail; no notification                                          |
| Diagnostic    | Include in scheduled review/digest; no immediate notification                                |
| Actionable    | Open or update an incident; notify on open/escalate/reopen                                   |
| Critical      | Page through the configured independent paths only after the rule is explicitly approved     |
| Coverage loss | Open one scoped incident based on duration, affected scope, and concurrent security activity |

Do not automatically promote the current monitor's historical notion of
"actionable" into the new notification allowlist. Those selectors identify
review candidates, not demonstrated high-confidence incidents.

The collector's initial-baseline message is not an incident and should remain
silent. Baseline and coverage status belong in health reporting.

### 4.7 Scheduled security review and agent assistance

Expose a bounded, read-only security review report suitable for both operators
and the existing periodic cluster health process. It should summarize:

- collection coverage by bay and host;
- collector and decision-policy versions;
- observation counts by class and rule;
- oldest unreviewed observation and reviewer cursor age;
- open, escalating, and stale incidents;
- recurring or fleet-correlated diagnostic findings;
- expiring suppressions and expected changes;
- notification delivery health; and
- evidence truncation, gaps, or retention risk.

Provide drill-down identifiers rather than embedding unbounded raw evidence in
the report.

An agent-driven health check may analyze this report and inspect selected
bounded evidence. Its output is advisory. It can recommend opening,
acknowledging, suppressing, or escalating an incident, but any durable action
must use an authenticated, audited operator path.

Do not make "an operator remembers to ask an agent" the monitor-health
mechanism. The reviewer needs its own heartbeat, backlog metric, and dead-man
check. Silence is unknown coverage, not success.

### 4.8 API and multibay boundary

The initial reviewer owns only its configured bay's observations and incident
projection. Any admin API or CLI report must require explicit bay scope and use
the existing inter-bay routing layer for remote bays.

Do not centralize project-host evidence by querying every bay database
directly. The later external security plane will provide cross-bay correlation
from explicitly shipped bounded evidence.

Read paths must enforce existing admin authorization and fresh-auth rules where
details are sensitive. Notification bodies and ordinary health summaries must
not contain credentials, cookies, raw customer data, full process arguments,
or unrestricted URLs.

### 4.9 Expected file scope

PR 2 may add:

- a reviewer and focused tests under `src/packages/server/hosts` or a small
  security-specific server module;
- a typed incident projection and schema setup;
- one bounded admin/CLI health-report path using existing Conat APIs; and
- integration with the existing scheduled cluster health report.

Avoid adding a frontend incident-management application in this PR. A minimal
read-only report is enough. Avoid cloud sinks, Falco or `auditd`, hash-chain
storage, automatic containment, and general-purpose query or rule languages.

### 4.10 Tests

Add focused tests for:

- cursor restart, duplicate delivery, and crash-before-commit behavior;
- one observation producing at most one finding decision per rule version;
- stable incident IDs and transactionally idempotent updates;
- no notification for inventory, diagnostic, expected, or initial-baseline
  observations;
- exactly one notification for open, escalation, and reopen transitions;
- no notification for repeated evidence on an unchanged open incident;
- persistence and multi-category correlation rules;
- fleet-wide expected change remaining retained but not notifying;
- expired suppression becoming reviewable again;
- coverage loss aggregation, grace periods, and recovery;
- incomplete evidence preventing a rule that requires complete coverage;
- explicit bay scoping and rejection of cross-bay shortcuts;
- bounded backlog processing and visible reviewer lag;
- redaction and payload-size limits; and
- agent summaries having no authority to mutate incident state directly.

Use deterministic fixtures for both true-positive simulations and common
operational changes. Include hostile oversized and malformed stored evidence to
ensure the reviewer cannot become a memory, database, or notification denial of
service.

### 4.11 Acceptance criteria

- Routine package, Snap, listener, service, and fleet rollout changes create no
  immediate administrator notifications.
- Approved synthetic actionable and critical fixtures each create one stable
  incident and the expected single notification transition.
- Coverage loss creates one durable scoped incident rather than recurring
  per-host mail.
- A failed reviewer or growing backlog becomes visible independently of normal
  incident notifications.
- Cluster health reports show enough state to detect unreviewed evidence
  without dumping raw sensitive records.
- Reviewer CPU, database load, and notification volume remain bounded under a
  replayed high-volume fixture.

## 5. Rollout and validation

### 5.1 PR 1 rollout

1. Deploy to staging with legacy delivery disabled.
2. Inject representative routine changes and several actionable-looking
   synthetic deltas.
3. Verify that snapshots, complete deltas, decisions, and transient
   confirmation records are retained while no routine admin alerts are sent.
4. Verify incomplete coverage and persistence failures do not advance a
   baseline.
5. Deploy to production in collection-only delivery mode.
6. Review at least one complete production interval before removing reliance on
   the legacy rollback switch.

PR 1 can immediately stop the current alert fatigue. It does not need to wait
for PR 2, provided operations have a documented query or health-check procedure
for reviewing retained evidence during the gap.

### 5.2 PR 2 rollout

1. Deploy the reviewer to staging in shadow mode with all notification rules
   disabled.
2. Replay retained representative observations and the deterministic fixture
   matrix.
3. Confirm incident idempotency, expected-change matching, resolution, report
   boundedness, and reviewer dead-man behavior.
4. Run stress tests for duplicate observations, backlog catch-up, malformed
   evidence, database restart, and notification failure.
5. Deploy to production in shadow mode and measure candidate incident volume
   and precision for at least one full operational cycle.
6. Enable only individually reviewed rules whose true-positive fixture,
   false-positive history, severity, owner, and runbook are complete.
7. Keep automatic containment disabled.

### 5.3 Metrics

Track at minimum:

- snapshots attempted, complete, partial, and failed;
- observation and decision persistence failures;
- observations by classification and rule version;
- reviewer cursor age and backlog;
- findings promoted, suppressed, and expired;
- incidents opened, escalated, reopened, acknowledged, and resolved;
- notifications attempted, delivered, deduplicated, and failed;
- alert precision after operator disposition;
- synthetic-event detection latency; and
- collector and reviewer CPU, memory, query time, and retained-data growth.

The practical success metric is not merely fewer alerts. It is that an
administrator can once again assume that a security notification warrants
prompt attention while retained observations remain available for periodic and
retrospective analysis.

## 6. Review requirements

Each PR needs:

1. normal correctness and concurrency review;
2. adversarial security and abuse review;
3. privacy and evidence-boundedness review;
4. multibay authority and routing review; and
5. operational failure-mode review.

Reviewers should explicitly probe:

- evidence loss or baseline advancement after partial failure;
- duplicate or reordered processing;
- forged timestamps and future-dated records;
- cross-bay data leakage;
- unbounded JSON, diff, query, or notification growth;
- notification floods caused by attacker-controlled project activity;
- suppression that accidentally becomes permanent approval;
- sensor or reviewer silence being interpreted as clean state; and
- an agent-generated disposition bypassing operator authorization.

If implementation reveals a concrete exploitable vulnerability, move those
details and the fix to the private security-advisory workflow described in
`SECURITY.md`. The public PRs should remain limited to the architecture and
operational behavior described here.

## 7. Explicit non-goals

These two PRs do not:

- implement the independent GCP security project or locked evidence archive;
- provide immutability against host root or bay compromise;
- deploy Falco, `auditd`, or a general runtime event sensor;
- inspect customer project contents;
- detect all crypto mining, spam, or customer abuse;
- introduce machine-learning anomaly detection;
- provide a general-purpose SIEM or rule language;
- build a full incident-management frontend;
- automatically quarantine, stop, reboot, or mutate production; or
- certify that a host is uncompromised.

Those capabilities belong to later phases of the common intrusion evidence
plane. These PRs establish the correct near-term boundary: collect broadly,
review deterministically, notify sparingly, and never discard the evidence
needed to change the decision later.
