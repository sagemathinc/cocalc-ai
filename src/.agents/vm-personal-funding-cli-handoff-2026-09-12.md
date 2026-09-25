# Personal VM Funding CLI Callers

Worktree: `/home/user/cocalc-course-funding-v2`, branch
`feature/course-sponsored-compute-v2`. No commits or live operations.
Nietzsche owns the personal-funding backend; main owns its frontend component.
Curie/Cicero's source-history implementation was not edited for this CLI task.

## Connected Commands

The existing `registerVmCommand` now registers `vm personal-funding`:

| CLI                                                                                                     | Actual `hub.compute` method |
| ------------------------------------------------------------------------------------------------------- | --------------------------- |
| `preview --terms FILE`                                                                                  | `previewVmPersonalFunding`  |
| `propose --terms FILE --operation UUID`                                                                 | `proposeVmPersonalFunding`  |
| `status VM_UUID`                                                                                        | `getVmPersonalFunding`      |
| `cancel VM_UUID --consent UUID --expected-version N --operation UUID`                                   | `clearVmPersonalFunding`    |
| `apply VM_UUID --consent UUID --expected-version N --expected-funding-version VERSION --operation UUID` | `switchVmPersonalFunding`   |

`FILE` may be `-` for stdin. File and stdin reads stop at 64 KiB plus one
overflow-detection byte, before parsing. Every terms field is explicit:

```json
{
  "vm_id": "<VM UUID>",
  "expected_funding_version": "<funding_status.funding_version from vm funding>",
  "home_volume_ids": [],
  "lane": "prepaid",
  "cap_usd": "12.34",
  "ends_at": "<absolute ISO timestamp with timezone within the VM deletion deadline>",
  "activation": "immediate",
  "fallback_reasons": []
}
```

Replace angle-bracket placeholders with actual values before previewing.
For fallback, set `activation` to `fallback` and explicitly list
`course_exhausted` and/or `course_expired`. There is no automatic default cap,
deadline, lane, fallback reason, VM identity, or home-volume scope. Positive
whole-cent decimal caps and ISO timestamps use shared funding validators.
Home-volume IDs are bounded to 100; funding versions to 512 characters.
Unknown fields, numeric JSON money, malformed IDs, and unsafe consent versions
are rejected before financial RPC. Exact VM UUIDs are required, not names.

Terms are read once before authentication retries. Proposals, cancellations,
and apply requests require caller-supplied stable operation UUIDs and retain
their identities across retries. Apply/cancel never fetch and substitute a
newer consent or funding version.

Propose/status return the server's isolated `approval_url` unchanged through
normal CLI output (`--json` is supported globally). There is no CLI approve
command, approve flag, browser automation, or approval-token submission. Apply
invokes only the versioned backend switch method: it cannot grant consent or
fall back to the legacy funding-lane setter. The backend coordinates a stop,
funding cutover, and restart; a preparing response is not completion. Project, host and
agent credentials are rejected consistently with the account-only funding CLI.

## Backend Checkpoint

Source reread on September 12: the actual hub.compute handlers are exported by
server/conat/api/compute.ts. switchVmPersonalFunding is no longer a stub. It
requires payer-home authority, VM ownership, exact unchanged approved immediate
consent/funding versions, and a stable operation ID. It records preparing and
queues a stop. The owning-bay worker checks confirmed stop generation, current
terms, and (for GCP) the metering watermark, reserves personal backing, records
the old binding/egress history, advances the funding/resource generation, marks
consent active and queues restart. No CLI direct start or accounting bypass.

The current worker also evaluates approved automatic fallback through a fresh
payer decision and exact allowed reason, epoch/generation and stop-intent checks.
Manual stop/delete and reached scheduled-stop deadlines are not permission to
activate fallback. CLI apply remains immediate-only; fallback is worker-owned.
This audit checked current source/contracts, not a live cloud cutover. Main and
Nietzsche own backend build/live acceptance; no restart or cloud call was made.

Personal home-volume handoff is still backend work: reviewVm rejects nonempty
home_volume_ids and any VM with an attached home_volume_id, even with an empty
terms array. Never omit the scope or use a legacy funding setter to bypass it.
This is distinct from the now-connected sponsored home-volume lifecycle, whose
public source deliberately redacts payer UUIDs and whose callers remain gated
by sponsored_home_volumes. See sponsored-home-volume-contract-2026-09-12.md.

After browser approval, read status again because approval increments the
consent version. Apply/cancel with the reviewed version; never substitute a
newer version automatically. Poll personal-funding status and vm get after
apply. Cancelling active/preparing consent may stop compute, not refund past
charges or erase independent storage obligations.

## Bounded Section 13 Audit

The actual inherited registerVmCommand path exercises all five personal callers
and global --api/--json output, not only a helper. Account/project/agent vm funding
reads use their existing authorized compute getters. Account source discovery
uses computeFunding.listSources and preserves labels, timestamps and inactive
history. Project access is not payer authority; account-only source/consent
commands reject host/project/agent credentials, including auth_host_id.

Fixed gap: vm funding previously exposed only id/name/funding_mode. It now returns
the authorized public funding status, owner, price observations, stop/deletion
deadlines, home-volume ID and resource timestamp. Missing funding_status is null,
not zero or an invented personal source; raw metadata is not forwarded. Resource
updated_at is not substituted for funding as_of. No account-wide aggregate rate,
guaranteed runway, private payer lookup, or backend quote is fabricated.

Structured financial denials retain server codes/messages and add bounded
source/version/home-bay/approval guidance after existing fresh-auth and approval
hints. No automatic retry, payer substitution, cap/deadline extension, or CLI
approval command was added. The registered course-compute guide now gives exact
preview/propose/status/human approval/status/apply/poll/cancel examples.

Scope boundary: this is acceptance of connected CLI adapters, explicit terms,
authorized public readouts and recovery guidance. It is not a claim that every
section 13 backend operation, aggregate quote/runway, transfer workflow or live
fallback scenario has been accepted. Backend/UI ownership stays with their agents.

## Exact Files

- `src/packages/cli/src/bin/commands/vm-personal-funding.ts` (help/readiness guidance)
- `src/packages/cli/src/bin/commands/vm.ts` (authorized funding readout only in this audit)
- `src/packages/cli/src/bin/commands/compute-funding.ts` (host identity alias guard)
- `src/packages/cli/src/bin/commands/vm-funding-acceptance.test.ts` (inherited command tests)
- `src/packages/cli/src/bin/core/cli-output.ts` (additive recovery hint fallback)
- `src/packages/cli/src/bin/core/compute-funding-hint.ts` and `.test.ts`
- `src/packages/docs/src/content/course-compute.ts` and `test/course-compute.test.cjs`
- `src/.agents/vm-personal-funding-cli-handoff-2026-09-12.md` (this handoff)

## Verification

From `src/packages/cli`:

```sh
pnpm exec tsc -p tsconfig.test.json
node scripts/run-tests.js src/bin/commands/vm-personal-funding.test.ts src/bin/commands/vm.test.ts src/bin/commands/compute-funding.test.ts src/bin/commands/vm-volume-funding.test.ts src/bin/commands/vm-funding-acceptance.test.ts src/bin/core/cli-output.test.ts src/bin/core/compute-funding-hint.test.ts
```

CLI test compilation writes only build/test; it does not clean or modify dist.
No CLI full build/clean was run during main's force-rebuild recovery. The earlier
CLI builds used tsc --build and a separate test compile, not dist deletion.
Final audit verification: CLI test TypeScript compile passed; the seven listed
suites passed 99 tests, zero failures/skips. The test-built actual cocalc entry
rendered vm personal-funding --help with all five commands and current handoff
guidance. Docs tsc --build and course-compute.test.cjs passed (including the
static guide verifier). Formatting and scoped diff whitespace checks passed.
