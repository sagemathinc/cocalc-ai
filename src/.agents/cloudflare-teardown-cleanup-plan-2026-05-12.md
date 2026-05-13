# Cloudflare Teardown And Cleanup Plan

Status: in progress, 2026-05-13.

Current implementation status:

- Phase 1 read-only planning and review is implemented.
- Phase 2 safe-owned DNS/tunnel apply is implemented via a saved-plan LRO and
  requires fresh admin two-factor authentication plus exact confirmation.
- R2 bucket deletion remains intentionally blocked in teardown apply. Targeted
  direct `bay-backups/*` cleanup exists as a separate guarded command, but full
  bucket empty/delete still requires archived-project safety work.
- API token cleanup, optional local settings reset, and UI integration remain
  unimplemented.

Goal: make Launchpad Cloudflare teardown trustworthy, auditable, and safe
enough for customer use. This is not a casual cleanup button. It is a staged
operator workflow for removing Cloudflare-side resources that CoCalc created or
uses, with especially strict handling for R2 because it can contain the only
remaining copy of archived projects.

## Problem Statement

Launchpad setup can create or depend on Cloudflare resources that are painful to
clean up manually:

- Cloudflare tunnels for hubs, bays, and project hosts.
- DNS records pointing at `*.cfargotunnel.com`.
- Cloudflare API tokens created for CoCalc automation.
- R2 buckets containing project backups, archived projects, database backups,
  and artifact/runtime state.
- R2 objects inside buckets, which must be deleted before Cloudflare allows the
  bucket itself to be deleted.
- Zone-level managed transforms, e.g. visitor location headers.

For dev and testing, stale resources cause direct cost and account clutter. For
customers, unclear teardown semantics undermine trust because they cannot easily
answer: "If I remove Cloudflare integration, what exactly is gone forever?"

## Operator-Facing Semantics

The CLI and UI must clearly explain the consequence of the plan before any
destructive action.

After full Cloudflare teardown:

- Public HTTPS access to the hub and project hosts goes away.
- Cloudflare tunnels and matching DNS records are removed.
- Cloudflare-side project backups are deleted.
- Cloudflare-side database backups are deleted.
- R2 buckets selected by the plan are emptied and deleted.
- Archived projects that exist only in R2 are permanently gone.
- Non-archived projects still exist on their project hosts.
- The local database still exists on the deployment host.
- The deployment may be made reachable again by reconfiguring Cloudflare or
  switching to SSH-tunneled/on-prem mode.

The irreversible part is archived projects whose only remaining storage is R2.
Everything else is operationally disruptive but recoverable from local state or
live project hosts.

The operation must leave CoCalc in a defined, non-corrupt state:

- Project metadata remains in the local database.
- Collaborators, titles, descriptions, course metadata, and ownership remain.
- Active/non-archived projects continue to resolve to their project-host data.
- Projects whose archived data was deleted still exist as database records and
  should open as empty/unprovisioned projects with a clear recovery/data-missing
  state, not crash, spin forever, or poison project lists.
- Backup views should report "no cloud backups available" rather than assuming
  backup indexes still exist.
- Any future reconfiguration of Cloudflare/R2 should create fresh backup state
  without requiring manual DB surgery.

This is a teardown of external Cloudflare storage/ingress resources, not a
database-corrupting partial delete.

## Safety Principles

1. Dry-run first. `apply` must consume a saved plan; it must not rescan and
   delete newly discovered resources.
2. Fresh auth. `apply` requires fresh admin auth and fresh 2FA.
3. Exact confirmation. The operator must type a confirmation string generated
   from the immutable plan.
4. R2 deletion is separate. Emptying/deleting R2 buckets requires an explicit
   destructive flag and confirmation text.
5. Never broad-delete by default. Only delete resources with strong ownership
   evidence.
6. Preserve unknowns. Unknown or ambiguous resources are reported, not deleted.
7. Managed transforms are not disabled by default. They are zone-wide and
   harmless enough that another service may depend on them.
8. Every destructive API call is recorded in the LRO result.

## CLI UX

Primary workflow:

```bash
cocalc cloudflare teardown plan
cocalc cloudflare teardown review <plan-id>
cocalc cloudflare teardown apply <plan-id>
```

Optional flags:

```bash
cocalc cloudflare teardown plan --include-r2
cocalc cloudflare teardown plan --scope dev
cocalc cloudflare teardown apply <plan-id> --delete-r2-contents
cocalc cloudflare teardown apply <plan-id> --confirm "delete 7 tunnels, 14 dns records, 3 buckets"
```

Initial release should avoid `--include-unknown`. If we add it later, it should
require an even stronger confirmation and probably be admin/debug-only.

## Plan Output

`plan` should print and persist an immutable snapshot with:

- Cloudflare account id/name.
- Zone id/name.
- Current site DNS settings.
- Tunnels selected for deletion.
- DNS records selected for deletion.
- API tokens selected for deletion.
- R2 buckets selected for deletion.
- R2 bucket object counts and approximate bytes where available.
- Project backup metadata counts.
- Archived project count.
- Non-archived/live project count.
- Cloud database backup count.
- Ambiguous resources found but not selected.
- Required confirmation string.
- Plan expiration time.

Example summary:

```text
Cloudflare teardown plan 9f0...

Selected for deletion:
- 7 Cloudflare tunnels
- 14 Cloudflare tunnel DNS records
- 2 CoCalc-created API tokens
- 3 R2 buckets containing 84,221 objects, 931 GiB
- 412 project backup snapshots
- 38 archived projects that exist only in R2
- 12 database backup objects

Not deleted:
- 21 active/non-archived projects on project hosts
- local database
- local project-host storage
- visitor location managed transform

Permanent data loss:
- 38 archived projects
- all selected project backup snapshots
- all selected cloud database backups
```

## Ownership Classification

Resources should be grouped as:

- `safe_owned`: strong evidence CoCalc owns it.
- `probably_owned`: matches naming but lacks a DB/resource-id link.
- `unknown`: related-looking but unsafe to delete.
- `protected`: should not be deleted by this workflow.

Only `safe_owned` should be deleted in V0.

Strong ownership evidence:

- Tunnel metadata is referenced in a host/bay DB row.
- Tunnel name matches current configured CoCalc prefix and host/bay id.
- DNS record id is stored in tunnel metadata.
- DNS record name matches generated host/bay naming and points to the matching
  tunnel target.
- R2 bucket is referenced by CoCalc backup DB metadata.
- R2 bucket name matches configured CoCalc backup bucket naming and prefix.
- API token name matches the bootstrap flow's generated CoCalc token name and
  account/zone context.

Weak evidence only:

- Name merely contains `cocalc`.
- Bucket prefix resembles an old dev prefix but is not in DB metadata.
- DNS record points to a Cloudflare tunnel but not a known CoCalc tunnel.

Weak evidence should be shown but not deleted by default.

## Data Model

Use LROs for the plan/apply workflow. A separate table is useful because the
plan must be immutable and inspectable after hub restarts:

```sql
cloudflare_teardown_plans (
  id uuid primary key,
  account_id uuid not null,
  cloudflare_account_id text not null,
  zone_id text,
  zone_name text,
  status text not null,
  include_r2 boolean not null default false,
  plan_json jsonb not null,
  confirmation_text text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  applied_at timestamptz,
  applied_by uuid,
  apply_lro_id uuid
)
```

`plan_json` should include exact resource ids/names. `apply` only uses these
ids/names; it must not expand scope by rescanning.

## Backend API

Add admin-only system RPCs:

```ts
createCloudflareTeardownPlan(opts: {
  include_r2?: boolean;
  scope?: "current" | "dev";
}): Promise<{ plan_id: string; summary: CloudflareTeardownSummary }>;

getCloudflareTeardownPlan(opts: {
  plan_id: string;
}): Promise<CloudflareTeardownPlan>;

applyCloudflareTeardownPlan(opts: {
  plan_id: string;
  confirm: string;
  delete_r2_contents?: boolean;
  two_factor_token: string;
}): Promise<{ lro_id: string }>;
```

Fresh 2FA should be enforced in the same way as other high-risk admin actions.
If there is no reusable helper yet, create one rather than special-casing this
flow.

## Cloudflare Discovery

Inputs come from site settings:

- `project_hosts_cloudflare_tunnel_account_id`
- `project_hosts_cloudflare_tunnel_api_token`
- `project_hosts_cloudflare_tunnel_prefix`
- `project_hosts_cloudflare_tunnel_host_suffix`
- `dns`
- `project_hosts_dns`
- `r2_account_id`
- `r2_api_token`
- `r2_access_key_id`
- `r2_secret_access_key`
- `r2_bucket_prefix`

Discovery calls:

- List tunnels by prefix/name under the Cloudflare account.
- Lookup tunnel metadata already stored in project-host/bay rows.
- List DNS records for generated host/bay names and tunnel targets.
- List user/account tokens by generated token name where API permissions allow.
- List R2 buckets via Cloudflare API and/or S3.
- Count R2 objects by bucket using paginated S3 listing.

## R2 Deletion

R2 deletion must be slow, explicit, and resumable.

Apply logic:

1. Revalidate the bucket name is in the immutable plan.
2. Revalidate bucket still matches CoCalc ownership constraints.
3. List objects with pagination.
4. Delete objects in bounded batches, e.g. 1000 keys per batch.
5. Record progress after each batch.
6. Delete the empty bucket.
7. Record exact counts and any failed keys.

Do not delete a bucket if:

- It is not in the plan snapshot.
- It does not match the configured prefix/naming.
- It is not referenced in CoCalc backup metadata unless the operator used a
  later, explicit `include_probably_owned` mode.
- The operator did not pass `--delete-r2-contents`.

## Archived Project Counting

The plan should count archived projects before deletion. The exact source of
truth depends on current schema, but the intent is:

- Count projects with no live project-host storage assignment and backup/archive
  state only in R2.
- Count projects whose latest durable storage location is an R2/restic archive.
- Show the project count and, if feasible, account/project titles in a review
  subcommand.

If exact archived-project detection is not reliable in V0, block R2 deletion
until it is. This is the highest-stakes part of the workflow.

## Deletion Order

Recommended order for `apply`:

1. Revalidate plan not expired and confirmation text matches.
2. Revalidate fresh 2FA.
3. Delete API tokens created by CoCalc except the token currently needed for
   cleanup.
4. Delete DNS records selected by the plan.
5. Delete Cloudflare tunnels selected by the plan.
6. Empty and delete R2 buckets if explicitly requested.
7. Optionally clear local site settings only after successful Cloudflare-side
   deletion.
8. Record final status and failures.

Do not clear local settings first; they are needed to recover/retry cleanup.

## UI Integration

V0 can be CLI-only. Later, add a Site Settings button:

- "Plan Cloudflare Teardown"
- Show the same immutable plan summary.
- Require fresh 2FA and typed confirmation.
- Start the same LRO.

The UI must not have a one-click destructive path.

## Testing Strategy

Unit tests:

- Plan classification with fixture site settings and fake Cloudflare resources.
- Confirmation text generation is deterministic.
- `apply` rejects expired plans.
- `apply` rejects confirmation mismatch.
- `apply` rejects missing 2FA.
- R2 deletion refuses buckets outside the plan.
- R2 deletion refuses buckets without explicit destructive flag.
- DNS deletion only targets selected records.

Integration/smoke tests:

- Dev Cloudflare account with a disposable domain/prefix.
- Create fake CoCalc-style tunnels/DNS/buckets.
- Run `plan`.
- Verify review output.
- Run `apply` without R2 and confirm tunnels/DNS are removed.
- Run `apply --delete-r2-contents` on a bucket containing test objects.
- Verify bucket is emptied and deleted.

Production safety test:

- Run `plan` on a real-ish account with unrelated resources and verify unrelated
  resources are classified as `unknown` or `protected`, never `safe_owned`.

## Implementation Phases

### Phase 1: Spec And Read-Only Plan

- Add Cloudflare teardown planner module.
- Add resource classification.
- Add immutable plan persistence.
- Add CLI `plan` and `review`.
- No deletion yet.

### Phase 2: Safe Delete For Tunnels And DNS

- Add `apply` for DNS records and tunnels only.
- Require fresh 2FA and exact confirmation.
- Add LRO progress/result.
- Keep R2 deletion disabled.

### Phase 3: R2 Object And Bucket Deletion

- Add object-counting and bucket-emptying.
- Add `--delete-r2-contents`.
- Block unless archived-project counting is reliable.
- Add resumable batch progress.

### Phase 4: API Token Cleanup And Local Setting Reset

- Delete CoCalc-created Cloudflare API tokens where possible.
- Add optional local settings reset after successful teardown.
- Keep managed transforms untouched by default.

### Phase 5: UI Surface

- Add Site Settings entry point over the same backend plan/apply APIs.
- Reuse the CLI summary language exactly.

## Open Questions

- What is the exact schema signal for "archived project exists only in R2"? ANS: I think it is that there is a last_backup field and the host isn't set?
- Should the first R2 deletion release be dev-only until we have more soak? ANS: I think this should be extremely limited. E.g., maybe it HAS to be run via cocalc-cli from the same account/machine as is running a hub, i.e., somewhere that has access to the site master key. I.e., it should never be possible via the web interface. But it's not dev only.
- Do we need a durable Cloudflare resource registry table going forward, or is
  host/bay metadata plus backup metadata enough? ANS: I'm not sure what this means.
- Should bootstrap-created tokens include a cluster/deployment id in the name to
  make future cleanup safer? ANS: I'm also not 100% sure what this means.

## Recommendation

Build Phase 1 soon. A read-only planner is immediately useful and low risk. It
will also reveal whether current resource naming/metadata is sufficient for
safe deletion. Do not implement R2 deletion until archived-project counting is
clear and tested.
