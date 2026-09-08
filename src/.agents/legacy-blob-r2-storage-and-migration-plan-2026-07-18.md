# CoCalc Public Image Blob Storage and Legacy Migration Plan

Date: 2026-07-18

Last revised: 2026-08-24 after rechecking the plan against the current
implementation, the completed Jupyter attachment work, the existing
`BlobByteStore` seam, and the urgent need to stop serving managed-site public
image blobs from PostgreSQL and the hub.

Status: proposed implementation plan. The Jupyter live-link/on-disk attachment
conversion described below has been implemented. The initial PostgreSQL-backed
`BlobByteStore` abstraction exists, but it is still thin and does not yet
provide R2 reads, R2 writes, immutable-object metadata, media validation,
rolling creation limits, a Cloudflare Worker read path, current-corpus
backfill, or legacy migration.

## 2026-08-24 Review

The core design still fits and should not be reopened unless a concrete product
requirement changes. The service is intentionally like GitHub issue attachment
image hosting: authenticated creation, public hash-addressed raster-image
reads, immutable normal lifetime, no project/account read ACL, no per-read
database writes, and explicit warnings that blob URLs are not suitable for
secrets or sensitive personal data.

The implementation should now be split into two independent milestones:

1. Move the current managed-site blob path from PostgreSQL/hub serving to
   R2/Cloudflare serving. This includes new uploads, generated images,
   server-side reads, and a backfill of the current cocalc.ai production blob
   rows, which are expected to be small enough to verify exhaustively.
2. Migrate selected legacy `cocalc.com` blobs only after milestone 1 is stable
   in production. The legacy corpus may include millions of objects from a mix
   of PostgreSQL and `smc-blobs`; it must use a separate operator manifest and
   must not block the new/current blob storage rollout.

The plan's main adjustment is therefore ordering, not semantics. Do not start
by solving the entire legacy corpus. First make today's blob service cheap,
cacheable, and off the hub/database hot path while preserving the existing
`/blobs/...?...uuid=...` URLs and PostgreSQL fallback mode.

Concrete current-state deltas since the July plan:

- `src/packages/server/blobs/store.ts` now provides a PostgreSQL-backed
  `BlobByteStore` seam used by save/read helpers.
- `src/packages/hub/servers/app/blobs.ts` still serves anonymous reads through
  the hub and PostgreSQL, so the expensive path remains active.
- `src/packages/hub/servers/app/blob-upload.ts` still accepts generic uploaded
  file bytes; R2 public rollout must add server-side raster validation or keep
  non-images on PostgreSQL-only compatibility behavior.
- `src/packages/server/membership/blob-limits.ts` still enforces total active
  blob count/bytes by querying the `blobs` table. Keep this during the first
  R2 rollout as a defensive compatibility limit, then replace it with rolling
  creation limits in a separate observed step.
- The 2026-07-18 current-production count of 568 rows is stale. Re-run the
  inventory query before backfill; the expected order of magnitude is still
  small enough for exhaustive current-corpus migration.

## Problem

Documents restored from `cocalc.com` contain URLs such as:

```text
https://cocalc.com/blobs/paste-0.9336086811634844?uuid=c05251d5-6100-47b7-916a-180c689c409e
```

Those URLs redirect to `cocalc.ai`, but most legacy UUIDs are absent from the
new database and return "blob not found." Missing pasted images in Jupyter
Markdown cells are the dominant reported symptom.

The current managed implementation also stores new blob bytes in PostgreSQL
and serves anonymous reads through the bay-0 hub. This creates unnecessary
database growth and exposes Google Cloud hub egress to public traffic.

The previous version of this plan proposed canonical objects, random handles,
aliases, grants, retention state, deletion state, per-object access counters,
and approximate last-access timestamps. That architecture is unnecessary for
the attachment feature CoCalc actually has. It also creates policy machinery
that cannot be correct after users copy literal blob URLs between documents,
projects, accounts, email, GitHub, and other systems.

## Executive Decision

Treat `/blobs` as a permanent public image attachment service, not as a generic
confidential key-value store.

1. A verified safe raster image is immutable and publicly readable by anyone
   who knows its URL.
2. Blob URLs are permanent under normal operation. Account deletion, project
   deletion, membership changes, inactivity, and quota changes do not delete
   an image.
3. Keep the existing content-derived UUID as the stable compatibility and
   object identifier. Do not add random handles or an alias table merely to
   put the same bytes behind a second identifier.
4. Store managed-deployment image bytes in one private Cloudflare R2 Standard
   bucket named `<cloudflare-site-prefix>-blobs`, specifically
   `staging-blobs` and `prod-blobs` for the current managed sites. Do not reuse
   a per-bay backup-bucket naming scheme.
5. Serve public reads through a small Cloudflare Worker and Cloudflare edge
   cache. Do not expose the bucket, `r2.dev`, list operations, or write
   credentials publicly.
6. Do not record per-image read counts or last-access timestamps. Use
   Cloudflare aggregate cache/request/error analytics for operations.
7. Do not use a Durable Object. Upload admission and emergency growth limits
   are enforced by the authoritative CoCalc bay before an R2 write.
8. Keep authenticated per-account, per-project, and per-IP upload controls.
   Adapt membership-tier controls from deletion-backed active-storage quotas to
   rolling creation limits suitable for permanent objects.
9. Add a deliberately coarse per-bay emergency limit for new physical bytes
   and new object count. A per-bay limit is acceptable; this is defense in
   depth against mass account creation, not exact billing accounting.
10. Keep PostgreSQL bytes for deployments without Cloudflare. CoCalc Plus and
    Star must not require R2 or Workers.
11. Restrict the permanent public service and legacy migration to validated
    raster images. Archived syncstrings, SVG, HTML, PDFs, archives, videos, and
    opaque binary attachments are not silently published into this namespace.
12. Preserve large image bytes outside the live Jupyter syncdoc. Ordinary
    `.ipynb` files on disk vendor live global image links into native Jupyter
    attachments, so downloads, GitHub, Colab, and offline Jupyter do not depend
    on CoCalc's blob service.
13. Preserve the legacy database and GCS source read-only until migration has
    been exhaustively verified and a separate source-retention decision is
    approved.

## Why This Simpler Model Is Correct

### Blob URLs are copied, not granted

A blob URL is ordinary text. Users can copy it in raw Markdown, rendered rich
text, notebook JSON, chat, email, source files, and external documents. CoCalc
does not receive an event when that happens. Consequently:

- a table of every document occurrence can never be authoritative;
- project membership cannot be a reliable read ACL for copied image URLs;
- deleting an image with its original account or project would break unknown
  copies;
- one `project_id` or `account_id` is upload attribution, not ownership; and
- adding grants or handles would create complexity without restoring an
  observable authorization boundary.

The identifier is not a secret. The service contract must say that pasted
images are public to anyone who knows or can derive the URL. Sensitive support
attachments or confidential files require a different feature.

### Permanent images remove the need for read accounting

Legacy `count` and `last_active` existed to support moving cold PostgreSQL bytes
to GCS and possible cleanup. In the target system:

- bytes already live in inexpensive object storage;
- ordinary images are never garbage-collected;
- warm reads come from Cloudflare's cache;
- exact counting would either miss cache hits or put a write on every read; and
- a missed telemetry event must never affect availability.

Therefore there is no product or lifecycle use for exact read counts or
last-access timestamps. Aggregate Cloudflare metrics are sufficient for cost,
cache, availability, and abuse monitoring.

### Public R2 delivery changes the denial-of-wallet threat

R2 has no internet egress charge. Anonymous image reads can incur Worker and
R2 operation charges on cold requests, but they no longer create Google Cloud
egress proportional to bytes. Long immutable caching, Cloudflare DDoS/WAF
protection, strict identifier validation, and rate limiting of abusive cache
misses are the appropriate controls.

The more material cost risk is authenticated creation of permanent objects.
That is controlled inside CoCalc, where account membership, project
collaboration, object size, media validation, and rate limits are already
available.

## What Blobs Actually Mean in CoCalc

This inventory is authoritative for implementation and migration. It records
all active producer and consumer classes found in the code audit.

1. **Generic authenticated upload.**
   `src/packages/hub/servers/app/blob-upload.ts` implements `POST /blobs`,
   requires sign-in, verifies optional project collaboration, applies request
   limits, enforces the 25 MB maximum, and derives the UUID from content.

2. **Shared frontend image upload.**
   `src/packages/frontend/blobs/upload-image.ts` uploads browser images and
   returns a global blob URL.

3. **Generic frontend attachment upload.**
   `src/packages/frontend/file-upload.tsx` currently permits non-image files.
   R2 public-image rollout must either reject those files with a useful message
   or leave them on a separate authenticated compatibility path.

4. **Slate and rich-text clipboard/drop uploads.**
   `src/packages/frontend/editors/slate/upload.tsx` turns pasted image bytes
   into image nodes and can turn non-images into attachment links.

5. **Markdown clipboard/drop/select uploads.**
   `src/packages/frontend/editors/markdown-input/component.tsx` inserts image
   uploads as Markdown images and non-images as links.

6. **Project Markdown and Slate documents.**
   Blob URLs live directly in document text and can be copied without a server
   event.

7. **Jupyter Markdown cells.**
   Live collaborative Markdown uses global blob URLs. The ordinary `.ipynb`
   save boundary converts those images to native Jupyter attachment bundles;
   load converts native attachments back to efficient global links. This
   avoids binary data in realtime patches and TimeTravel while preserving
   standards-compliant, self-contained notebooks on disk.

8. **Project chat.**
   Chat composition, thread images, and chat modals insert blob links into
   durable message content.

9. **Course-management rich text.**
   Assignment, handout, student, and configuration text uses the same upload
   editors. Course distribution is a primary reason images must outlive their
   originating project.

10. **Task descriptions.**
    Task editors use the shared Markdown attachment path.

11. **Git commit and review comments.**
    Git-related rich-text and review comments permit attachment uploads.

12. **Support requests.**
    Support screenshots can be account-attributed without a project and their
    URLs may appear in email or external support systems. The UI must make the
    public-link semantics clear; truly confidential support attachments need
    a separate design.

13. **Theme and identity images.**
    Account, project, chat, workspace, rootfs, and public-share themes use blob
    UUIDs or URLs. Some are intentionally rendered to anonymous visitors.

14. **Admin news content.**
    Public news pages render uploaded images anonymously.

15. **Codex/ACP generated images.**
    `src/packages/project-host/codex/generated-image-blobs.ts` calls
    `db.saveBlob` with project context and inserts the resulting URL into chat
    or documents.

16. **Direct browser rendering and downloading.**
    Markdown, notebook cells, chat, themes, public pages, and exports load blob
    URLs directly.

17. **Chat, task, and whiteboard exports.**
    `src/packages/export/blob-assets.ts` and related exporters discover blob
    URLs and materialize bytes into export bundles.

18. **Chat imports.**
    `src/packages/export/chat-import.ts` reuploads bundled assets and rewrites
    references. This remains useful for self-contained imports even though
    ordinary copied public URLs continue to work.

19. **ACP prompt materialization.**
    `src/packages/lite/hub/acp/blob-materialization.ts` materializes referenced
    images as local files for model input in an authenticated project workflow.

### Systems that are not this service

- Jupyter execution outputs use a project-scoped Conat AKV and are not global
  attachment blobs.
- Native Jupyter cell attachments are the portable on-disk representation of
  eligible live image links, not a second global store.
- Files UI uploads belong in the project filesystem.
- Project backups, rootfs images, container images, and other R2 objects use
  separate buckets or prefixes and policies.
- Historical Sage, socket `save_blob`, file-transfer, and LaTeX paths explain
  some legacy non-image rows but are not active public-image use cases.
- Deprecated archived syncstring blobs are internal TimeTravel data and must
  never enter the public attachment namespace.

## Verified Current State

### Current cocalc.ai storage

- `src/packages/util/db-schema/blobs.ts` defines a global PostgreSQL `blobs`
  table containing bytea, one project/account association, expiry, access
  counters, GCS metadata, and size.
- `src/packages/database/postgres/blobs/methods-impl.ts` stores and retrieves
  current bytes.
- `src/packages/hub/servers/app/blobs.ts` serves anonymous GET requests through
  the hub and redirects non-seed bays to the seed bay.
- `src/packages/server/blobs/save.ts` validates size, identity, and membership
  quota before writing.
- All current writes route to the cluster seed bay.
- The current identifier is `uuidsha1(content)`, derived from SHA-1 and encoded
  as a UUID. It has been the stable public identity for years.
- The maximum object size is 25 MB.
- A read-only production query on 2026-07-18 found 568 current rows totaling
  about 135 MB, all still containing PostgreSQL bytea.

### Existing upload controls

There are two distinct mechanisms today:

1. `blob-upload.ts` has in-process account and IP request-count throttles. The
   defaults are 20/account/minute, 400/account/hour, 60/IP/minute, and
   1200/IP/hour. These are not membership-tier limits and are not shared
   across hub processes.
2. `src/packages/server/membership/blob-limits.ts` enforces membership-tier
   total active count and total active bytes for accounts and projects by
   querying attributed rows in the current `blobs` table.

The second mechanism is a storage quota, not a creation-rate throttle. It also
depends on deletion and one-row attribution. It cannot be retained unchanged
when public images are permanent and identical content may be uploaded in many
contexts.

### Legacy cocalc.com storage

- Metadata and hot bytes lived in PostgreSQL.
- Maintenance moved colder bytes to the `smc-blobs` GCS bucket and normally
  cleared bytea after verification.
- GCS bytes may be gzip/zlib-compressed according to PostgreSQL metadata.
- Reads incremented `count` and updated `last_active`.
- Objects were keyed by legacy UUID and did not preserve reliable MIME type or
  filename.
- The shutdown inventory contains 23,715,443 blob rows across public
  attachments, historical internal blobs, and archived syncstrings.
- The legacy database VM and GCS bucket are currently available read-only.

## Target Architecture

```text
authenticated browser/project-host
              |
              | POST/saveBlob
              v
authoritative home/owning bay
  - authorization
  - membership-tier upload throttles
  - per-IP/account request throttles
  - coarse per-bay emergency budget
  - content validation and hashing
              |
              | private authenticated PUT
              v
<cloudflare-site-prefix>-blobs (private R2 Standard bucket)
              ^
              | private R2 binding, cache miss only
              |
Cloudflare edge cache <- public read Worker <- anonymous GET/HEAD
```

There is one bucket for the entire managed site, not one per bay or project.
The Worker/cache is the public data plane. Bays are the authenticated write
control plane.

### Multibay authority

- An account-only upload is authorized and throttled by the account's home bay.
- A project-attributed upload is authorized and throttled by the project's
  owning bay, including collaborator checks.
- A generated image uses the project's owning bay.
- Legacy migration uses an explicit operator path and does not impersonate a
  user or consume membership limits.
- Each bay may enforce its own coarse site-growth cap. Exact cross-bay global
  accounting is intentionally not required.
- All bays may write to the same content-addressed bucket using narrowly scoped
  credentials. Conditional object creation makes duplicate writes idempotent.

This is a documented small global attachment-data exception. Blob byte traffic
does not flow through the seed hub after upload or through project hosts on
public reads.

## Bucket and Worker Design

### Cloudflare Bootstrap Configuration Plan

The managed blob path depends on Cloudflare features that are easy to
misconfigure manually: R2 bucket administration, private R2 object access,
Workers script deployment, Worker routes or custom domains, DNS, and the
existing tunnel and visitor-location-header settings. The current wizard asks
admins to create long-lived tokens by following screenshots. That approach was
acceptable for the initial tunnel/R2 setup, but it does not scale to the
additional Worker permissions needed for public blob delivery. It also tends
to produce either underpowered tokens that fail later or overpowered tokens
that remain stored long term.

Use a one-time bootstrap-token flow as the only wizard configuration path.
Underlying site settings remain operator recovery/customization escape hatches,
not a second guided workflow. Do not duplicate permission instructions there.

#### Intended admin experience

Implementation clarification (September 2026): use Cloudflare's **Create
additional tokens** template with only **User / API Tokens / Edit**. This
permission is unavailable in the custom-token builder. The template token
cannot itself discover zones. CoCalc therefore creates a temporary Zone Read
token across the user's zones (10-minute expiry), uses it only to find the
matching domain/account, then deletes it. The durable automation token is
scoped to that single account and zone. This temporary discovery scope must be
explained in the wizard. See [Cloudflare's token creation documentation](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/).

The browser submits the bootstrap secret once and clears its input immediately.
The server saves the durable secret through the existing encrypted site-setting
path; RPC responses contain identifiers, permission names, and non-secret
settings only. Provisioning is a separate retryable action using saved
credentials. Operations execute on the seed bay and share a lock.

If saving throws after it may have written some settings, keep the automation
token active and report its ID for operator inspection. Revoking it in this
ambiguous case could invalidate credentials already in use. Temporary token
cleanup is still attempted. Expiry protects the read-only discovery token if
the hub stops unexpectedly; the user must give the bootstrap token a short TTL.

The legacy same-origin blob route checks Worker availability before redirecting,
so PostgreSQL-only images remain accessible while backfill is pending. This
adds a HEAD request for compatibility URLs; direct Worker URLs bypass the hub.

1. The admin enters the external domain and CoCalc resource prefix.
2. The wizard explains, in plain text, that the next Cloudflare token is a
   temporary bootstrap token, not the token CoCalc will keep.
3. The admin creates a short-lived Cloudflare token with enough authority to
   discover the account/zone, create a narrower API token, configure the
   selected zone, and provision the blob Worker resources.
4. The admin pastes that bootstrap token into CoCalc.
5. CoCalc uses it once, from the server, to create a durable least-privilege
   "CoCalc automation" token scoped to exactly the discovered Cloudflare
   account and zone.
6. CoCalc stores only the durable token and derived non-secret configuration.
7. CoCalc attempts to revoke the bootstrap token immediately after the durable
   token is created.
8. The wizard shows exactly what was created, whether the bootstrap token was
   revoked, and any manual cleanup still required.
9. The wizard then runs idempotent reconciliation for tunnels, R2 bucket
   checks, the blob Worker, Worker route/custom domain, DNS, and health tests.

The UI must be explicit that the bootstrap token is powerful and should have a
very short expiration, for example 15-60 minutes. It must also say that CoCalc
does not save that token and that the source code for this flow is auditable.

#### Bootstrap token handling and storage rules

The bootstrap token is a sensitive one-time secret with higher privileges than
the durable token. Treat it as toxic input:

- accept it only from an authenticated site admin with the same fresh-auth
  requirements used for other dangerous site settings;
- send it only over the existing authenticated Conat/system API call;
- keep it only in process memory for the duration of the request or LRO;
- never write it to site settings, PostgreSQL, logs, LRO payloads, telemetry,
  browser storage, exception messages, screenshots, or test artifacts;
- redact request bodies and Cloudflare error details defensively anywhere the
  token value could be included;
- do not store it as a fallback if durable-token creation fails;
- do not continue to use it for ordinary future reconciliation after the
  durable token exists; and
- attempt immediate invalidation through Cloudflare's token API when the
  durable token has been created successfully.

If invalidation fails, the wizard should show the Cloudflare token id when
available and give a clear instruction to delete the temporary token manually.
The token secret itself must not be shown again. The configured short
expiration is the final safety backstop.

#### Durable token scope

Refactor the existing `createDurableTunnelToken` concept into a durable
`CoCalc Cloudflare automation` token. This token is long-lived enough for
normal operations but must be much narrower than the bootstrap token.

The durable token should be scoped to:

- the single Cloudflare account that owns the selected zone;
- the single Cloudflare zone for the configured CoCalc external domain; and
- only the permission groups needed by enabled CoCalc Cloudflare features.

It should include account-level permissions for Cloudflare Tunnel management,
R2 bucket administration, Workers script deployment, and optional account
analytics used by operator diagnostics. It should include zone-level
permissions for zone read, DNS record management, Worker route or custom-domain
management, managed request headers, and any zone settings/rules required by
direct encrypted project-host routing.

It must not include broad billing, organization, user-management, account
membership, or API-token-management permissions. In particular, the durable
token should not be able to create or delete more Cloudflare API tokens; that
capability belongs only to the temporary bootstrap token.

The implementation should discover Cloudflare permission-group ids
dynamically, as the existing bootstrap code already does, instead of hardcoding
ids. The wizard should display the resulting human-readable permission names
before or immediately after creation so admins can audit what CoCalc requested.

R2 S3 object credentials (`r2_access_key_id` and `r2_secret_access_key`) remain
a separate credential class, but bootstrap now creates them automatically.
Cloudflare documents this path in [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/):
create a user token with `Workers R2 Storage Bucket Item Write`, use its `id`
as the access key, and SHA-256 of its `value` as the secret key. Never reuse
the broader REST automation token as the S3 token.

The new token includes only exact default-jurisdiction bucket resources for
the configured prefix's six regional backup buckets and the configured blob
bucket (default `<prefix>-blobs`). It has no bucket-administration, DNS,
Workers, or token-management permission. Names also cover buckets provisioned
later. Additional/custom backup buckets or jurisdictions need explicit manual
credentials; do not silently widen the S3 policy to all account buckets.

The seed bay loads existing credentials under the provisioning lock. Complete
credentials for the same account/prefix are preserved, not rotated; incomplete
pairs or account/prefix changes fail before saving settings. Credentials are
saved through encrypted site settings, and only the nonsecret access-key/token
ID is returned to the wizard. Unsaved child tokens are revoked on failure;
ambiguous persistence failures preserve possibly saved tokens and report IDs
for manual inspection. Creation is not a health check: blob provisioning must
still verify S3 PUT/GET and Worker delivery, and backup diagnostics remain
available. R2 must already be enabled in the Cloudflare account.

The wizard has no manual key entry step or advanced workflow. Underlying site
settings remain available for deliberate operator recovery. Before merging,
manually verify creation and S3 access on lite4b, repeat bootstrap to confirm
preservation, and confirm neither new credential secret appears in browser
responses. This is in addition to the mocked policy/derivation/cleanup tests.

#### Credential rotation: next implementation gate

Status: design only; not implemented by the bootstrap-only wizard change.
Re-running bootstrap currently refreshes REST automation permissions but
preserves S3 credentials and leaves the previous REST token active. It is not
a complete compromise-recovery or credential-rotation operation.

Rotation changes Cloudflare authentication, not rustic repository encryption
passwords, repository IDs, bucket names, paths, or backup data. No data copy
or re-encryption should be needed. Keep REST-token replacement and S3-key
replacement distinct internally, even if one guided action orchestrates both.

Existing code that must participate:

- `server/project-backup/index.ts` builds new TOML and index-store config from
  current site settings; `DEFAULT_BACKUP_TTL_SECONDS` is 12 hours.
- `project-host/file-server.ts` caches that config and writes local rustic
  profiles. Its invalidation RPC clears caches but does not drain running
  rustic processes or prove they no longer hold old credentials.
- `server/project-host/client.ts` and the inter-bay service already route
  invalidation to the host's authoritative bay. Use this path, not a local-only
  host loop or a best-effort publish as evidence of adoption.
- Bay backups, blob readers/writers, backup-index stores, external migration
  jobs, stored bucket credential fallbacks and persisted export configurations
  also need an inventory. Do not assume project-host cache invalidation covers
  all consumers. Worker R2 bindings are distinct from S3 keys.

Implement a durable seed-owned rotation operation with an encrypted pending
credential set, credential generation, per-bay/host adoption status, retained
old token IDs and explicit cleanup state. Never persist the bootstrap token.
Repeated calls and disconnect recovery must resume the operation without minting
unbounded replacement tokens.

1. Require fresh admin authentication and a new temporary bootstrap token.
   Discover and display the current resource set, including custom/legacy
   backup buckets; rotation must neither lose existing coverage nor silently
   broaden it to other sites. Keep account, domain and bucket names fixed.
2. Create separate replacement REST and S3 tokens. Validate required REST
   capabilities without replacing unrelated resources. Verify a bounded unique
   S3 canary PUT/GET/DELETE in each required existing bucket and representative
   rustic metadata reads before switching. Clean up failed candidates; report
   uncertain provider responses without logging token material.
3. Switch the active credential pair and generation coherently on the seed,
   propagate to bays, and require acknowledgements. A pair must never be read
   as the old access key plus the new secret. Retain the previous pair during
   the controlled handoff, not indefinitely as an invisible fallback.
4. Invalidate host profiles through ownership-aware RPC and require generation
   acknowledgement before new operations. Track/drain old-generation rustic
   jobs and other consumers. Offline hosts must refresh before storage work
   when returning. A timer or TTL alone does not prove completion.
5. Recheck backup reads/writes and blob delivery, then present explicit old-token
   retirement. Do not revoke credentials shared outside this site automatically.
   Cleanup failure must leave visible, retryable pending work; do not claim
   successful rotation while known old tokens remain active.
6. Offer a separately confirmed emergency revoke mode for suspected compromise:
   retire old tokens immediately, disclose that running/offline jobs may fail,
   and retry recoverable work with the new generation. This is intentionally
   different from routine low-disruption rotation.

Acceptance tests: multibay partial propagation, offline hosts, a long-running
backup/restore during handoff, stale profiles, mixed-pair prevention, custom
bucket coverage, failed canary cleanup, operation restart/resume, repeated
revocation and emergency-mode interruption. Manually exercise at least one
real rustic restore across rotation before exposing this as a security action.

#### Site settings shape

The long-term model should be one stored Cloudflare REST automation token, not
several unrelated tokens with overlapping privileges. To avoid a risky
settings migration, the implementation can first write the durable token into
the existing settings that current code reads:

- `project_hosts_cloudflare_tunnel_api_token`;
- `r2_api_token`, when the durable token includes R2 bucket administration;
- `project_hosts_cloudflare_tunnel_account_id`;
- `r2_account_id`;
- `r2_bucket_prefix`; and
- `dns`.

Then add a follow-up cleanup that introduces clearer names such as
`cloudflare_automation_api_token`, `cloudflare_account_id`,
`cloudflare_zone_id`, `cloudflare_zone_name`, `blob_worker_name`, and
`blob_worker_public_url`, with compatibility reads from the old settings until
managed sites have migrated.

Do not store Cloudflare resource ids only in informal notes. The blob Worker
deployment should have enough durable state to reconcile idempotently, audit
what exists, and delete or rotate it later without guessing from names alone.

#### Resource reconciliation

After the durable token is stored, CoCalc should provision resources with
ordinary idempotent "ensure" functions, not with one-shot wizard-only logic:

- ensure the private `<cloudflare-site-prefix>-blobs` R2 bucket exists;
- ensure `r2.dev` public bucket access is disabled or unused;
- deploy/update the blob image Worker from the checked-in source;
- bind the private R2 bucket as the Worker's `BLOBS` binding;
- create/update a dedicated blob hostname, preferably
  `blobs.<site-domain>`, instead of a broad route on the main application
  hostname;
- create/update the required DNS record, Worker route, or Worker custom
  domain;
- set `blob_r2_public_url` only after the Worker URL is reachable; and
- run a smoke test that writes or locates a known object, reads it through the
  Worker, and confirms the same-origin `/blobs/...?...uuid=...` route redirects
  when configured.

A failure after durable-token creation should leave the durable token in place
and make reconciliation safely retryable. A failure before durable-token
creation should save no Cloudflare token.

Do not enable a strict `blob_storage_backend=r2` mode merely because the token
was created. R2 blob serving is ready only after bucket, Worker, routing, and
server-side read/write health checks all pass. Until then `auto` must choose
PostgreSQL for writes or keep the previous known-good mode.

#### Admin trust and communication

The wizard should include an expandable "What CoCalc will do with this token"
summary before submission:

- verify the token with Cloudflare;
- discover the matching zone and account for the configured domain;
- enumerate Cloudflare permission groups so a narrow token can be constructed;
- create one durable CoCalc automation token for this site;
- create separate bucket-scoped R2 S3 credentials if none are configured;
- optionally enable visitor location headers;
- provision R2 and Worker resources needed by configured features;
- attempt to delete the bootstrap token; and
- store only the durable automation token, R2 S3 credentials, and non-secret
  resource identifiers; never the bootstrap or discovery token.

It should also include a "What CoCalc will not do" summary:

- it will not save the bootstrap token;
- it will not send the token to browsers, project hosts, or user projects;
- it will not use the bootstrap token after the durable token exists;
- it will not request access to unrelated Cloudflare zones or accounts; and
- it will not make the R2 bucket public.

Every success and warning message must distinguish these three credential
classes clearly:

- the temporary bootstrap Cloudflare API token;
- the long-lived CoCalc Cloudflare REST automation token; and
- the R2 S3 access key and secret used for object reads/writes.

Conflating these names is a security and support risk.

### Bucket provisioning

- Bucket name: `<cloudflare-site-prefix>-blobs`; currently `staging-blobs` and
  `prod-blobs`.
- Storage class: R2 Standard, not Infrequent Access.
- One bucket per managed site: for example staging and production have
  independent buckets.
- Keep the bucket private and disable `r2.dev` production access.
- Create from bay-0 or specify the deliberate location hint matching bay-0.
  R2 automatic placement follows the bucket-creation request location, not a
  logical CoCalc bay setting.
- Use separate least-privilege read and write credentials/bindings.
- Do not add lifecycle expiration rules to the public image prefix.
- Include the bucket in existing Cloudflare resource audit/teardown safety
  tooling so it cannot be mistaken for an abandoned test bucket.

### Object identity and layout

Keep compatibility simple:

```text
public id:  existing UUID derived from image content
R2 key:     blobs/v1/<first-two-uuid-hex>/<uuid>
ETag:       "<uuid>"
```

Store exact uncompressed bytes. R2 custom metadata should include:

- full SHA-256 for integrity checking;
- byte size;
- detected raster media type;
- source (`current`, `legacy-db`, `legacy-gcs`, `generated`, `upload`);
- migration/storage format version; and
- creation/import time.

R2 metadata is operational integrity metadata, not a relational catalog. Do
not store account/project IDs in the object key. An upload audit event may
record the authorizing account/project for abuse investigation.

The UUID remains the direct lookup key. There is no `blob_objects`,
`blob_handles`, `blob_aliases`, `blob_grants`, or occurrence table in the
target design.

If an object already exists at the UUID key, compare size and integrity
metadata where available. A mismatch is a collision/corruption incident and
must fail closed; never overwrite it.

### Canonical public URL

Use one canonical cache key per UUID, preferably:

```text
https://<blob-host>/<uuid>
```

Existing URLs remain valid:

```text
https://<site>/blobs/<display-filename>?uuid=<uuid>
```

The compatibility route validates the UUID and redirects to the canonical
URL. New application code may continue returning the old URL until all
consumers understand the canonical form, but public bytes must resolve without
a database alias lookup.

The filename is presentation only. It must not create independent cached
copies, select content type, influence authorization, or participate in object
lookup.

### Read Worker

The Worker is intentionally small:

1. Accept only `GET` and `HEAD` on an exact canonical UUID path.
2. Reject malformed paths before issuing any R2 request.
3. Read only the deterministic R2 key from a private bucket binding.
4. Return the media type stored in trusted R2 metadata, never from the URL.
5. Set `X-Content-Type-Options: nosniff`.
6. Set a one-year public immutable cache policy and stable ETag.
7. Support conditional requests. Range support is optional for the initial
   raster-only service and should be added only if a real consumer requires it.
8. Cache 404 responses briefly to damp repeated misses without making newly
   migrated objects appear missing for long.
9. Return no bucket listing, metadata API, upload API, or arbitrary-key proxy.

Configure Cloudflare caching before Worker execution where supported, so a
warm canonical image does not invoke the Worker. Otherwise use the Worker
Cache API with the canonical UUID as the sole cache key.

Do not add per-object counters, timestamps, Analytics Engine writes, Durable
Objects, KV writes, or PostgreSQL writes to this path.

Cloudflare's managed DDoS/WAF and rate-limiting rules should reject abusive
malformed and high-miss traffic. A Worker rate-limit binding may be added for
misses as an inexpensive local defense, but it is neither globally exact nor a
correctness dependency.

## Upload Admission and Cost Bounds

### Product limits

Every normal write remains authenticated. Before a new object is accepted, the
authoritative bay must:

1. resolve the account and relevant membership tier;
2. verify project collaboration when `project_id` is provided;
3. apply existing per-account and per-IP short/long request throttles;
4. enforce the 25 MB encoded object maximum;
5. identify the media from bytes, not extension or browser MIME;
6. decode enough to verify an approved raster and enforce pixel/dimension
   limits against image bombs;
7. compute and verify the compatibility UUID and full SHA-256;
8. apply membership-tier rolling creation limits;
9. apply the coarse per-bay emergency limit for new physical bytes and object
   count; and
10. conditionally create the immutable R2 object.

Initially approved public formats should be PNG, JPEG, GIF, WebP, BMP, ICO,
and AVIF only when the chosen decoder validates it safely. SVG is excluded
because it is active XML content, even when named as an image.

### Membership-tier throttles

Replace the long-term dependency on active-storage totals with rolling
creation controls such as:

```text
account uploaded bytes over a rolling 24-hour window
account accepted object count over a rolling 24-hour window
project uploaded bytes over a rolling 24-hour window
project accepted object count over a rolling 24-hour window
```

The exact windows and values belong in membership-tier usage limits and may
vary by tier. Existing tier values provide rollout guidance but must not be
silently reinterpreted without an explicit membership migration.

Rate accounting is bounded operational state, not blob ownership:

- it expires after the rate window;
- it does not determine read access or object lifetime;
- it may be represented by hourly buckets in each bay's PostgreSQL database or
  an existing generic membership usage ledger;
- it counts every accepted upload attempt against account/project anti-abuse
  limits, even if content deduplicates; and
- it does not require a row per permanent blob.

This preserves meaningful tier differentiation and prevents free media
hosting without eventually blocking a legitimate long-lived account merely
because its old notebook images remain available.

### Per-bay emergency budget

Add two coarse bounded counters per bay and time window:

```text
new physical bytes
new physical object count
```

The first suggested production ceiling is approximately 30 GB of new physical
bytes per bay per day. The object-count ceiling is equally important because a
tiny-object attack can create operation and metadata costs without consuming
many bytes. Values must be site settings with an operator override.

At R2 Standard's current $0.015/GB-month price, sustained growth of 30 GB/day
adds about 10.95 TB/year and reaches an end-of-year storage bill of roughly
$164/month. Approximately 13.3 TB costs $200/month. A per-bay limit means the
explicit worst-case site growth is the configured limit multiplied by the
number of writing bays; operators must lower the default as bay count grows if
they want to preserve the same site-wide envelope.

This budget is intentionally approximate and conservative:

- exact global accounting across bays is unnecessary;
- reservation races may reject or slightly overcount rather than permit an
  unbounded write;
- a duplicate object does not consume new-physical-byte budget after existence
  is confirmed;
- migration has a separate operator budget and concurrency limit; and
- exceeding the budget rejects new uploads with a clear retryable response but
  never affects reads of existing objects.

No Cloudflare Durable Object is needed because the application controls all
normal writes before R2.

### Transition from current total quotas

During rollout, keep current membership total-count/total-byte checks until the
new rolling controls are deployed and observed. Then:

- stop treating permanent R2 images as deletable "active storage" owned by one
  account or project;
- remove automatic deletion of durable images during account deletion;
- retire user-facing "delete oldest blob to recover quota" behavior for these
  images;
- update membership usage UI to show rate-limit state rather than a misleading
  deletable storage inventory; and
- keep explicit exceptional administrative disable/removal for legal, privacy,
  malware, or abuse incidents.

## Upload and Read Flows

### Browser upload

1. Browser sends the file to the appropriate authenticated bay using the
   existing upload API.
2. Bay authorizes account/project context and applies request throttles.
3. Bay streams to a bounded temporary file while hashing and enforcing size.
4. Bay validates raster type and dimensions.
5. Bay applies membership and emergency creation limits.
6. Bay conditionally writes the R2 object or verifies an existing object.
7. Bay emits a bounded audit/metrics event and returns the UUID URL.

Do not introduce direct browser-to-R2 uploads initially. They would make exact
server-side media validation, rate admission, and idempotent compatibility
handling more complicated for little benefit at current volume.

### Project-host and generated-image upload

Existing `db.saveBlob` calls continue to route through the authoritative bay.
The project host never receives reusable R2 write credentials. Authorization
must bind the call to the scoped project and account responsible for usage.

### Public browser read

1. Browser requests the canonical UUID URL.
2. Cloudflare serves a warm immutable cache entry without reaching CoCalc.
3. On a cold request, the Worker validates the UUID and retrieves exactly one
   deterministic private R2 object.
4. Missing objects return a briefly cacheable 404.

No hub, project, project host, PostgreSQL query, account lookup, or project
start is involved.

### Server-side read

Jupyter `.ipynb` serialization, exports, ACP materialization, and other
authenticated server consumers use a server-side blob-store interface. In R2
mode it reads the deterministic private object directly; in PostgreSQL mode it
uses the existing database backend. It must not fetch public URLs through
Cloudflare merely to retrieve bytes already available through server
credentials.

## Deployment Modes

Expose an explicit backend decision:

```text
blob_storage_backend = auto | postgres | r2
```

- `postgres`: current byte storage and application semantics for deployments
  without Cloudflare.
- `r2`: managed mode using the private site blob bucket and public read Worker.
- `auto`: select R2 only when the full Cloudflare blob configuration and health
  checks succeed; otherwise use PostgreSQL before any writes occur.

The mode must be stable for a running deployment. Never silently split new
writes between PostgreSQL and R2 because one dependency is temporarily
unhealthy.

Introduce a minimal internal byte-store interface:

```ts
interface BlobByteStore {
  head(uuid: string): Promise<BlobHead | undefined>;
  putImmutable(input: PutBlob): Promise<"created" | "already-exists">;
  get(uuid: string): Promise<BlobBody | undefined>;
}
```

Lifecycle, handles, grants, reference tracking, and ordinary deletion are
deliberately absent.

## Jupyter Representation Boundary

The implemented Jupyter design is a prerequisite for confidently making the
global image service public and permanent without making notebooks dependent
on it outside CoCalc.

### Live syncdoc

- Markdown cells contain ordinary global blob URLs.
- Image bytes do not appear in realtime synchronization patches or TimeTravel.
- Raw and rich-text copy/paste between notebooks, projects, chat, tasks, and
  Markdown files continues to work.

### Save to `.ipynb`

- Eligible CoCalc image URLs are resolved through the server-side blob reader.
- Markdown references are rewritten to native `attachment:<name>` references.
- Exact bytes are encoded in the cell's standard `attachments` MIME bundle.
- Attachment names are deterministic and collision-safe within the cell.
- The saved file has no dependency on CoCalc or Cloudflare for those images.

### Load from `.ipynb`

- Native Jupyter attachments are factored into the global image service for
  efficient live collaboration.
- Existing CoCalc metadata permits idempotent reuse where available.
- External notebooks with native attachments work without special import.
- A stopped project can load and save through project-host filesystem/RPC
  services without starting the project container.

## Legacy Selection Policy

### Exact archived-syncstring exclusion

Archived syncstrings are internal historical patch bundles, not attachments.
Build an exact exclusion set from the legacy `syncstrings.archived` relation
and verify referential counts before processing candidates. Do not infer this
classification from filename, age, MIME, count, or size.

Delete the deprecated archived-syncstring creation/retrieval code only in a
separate reviewed change after production usage and source backups are
confirmed. Do not couple code deletion to data deletion.

### Approved legacy images

A candidate is eligible only after canonical decompression and byte-level
validation as a safe raster image. Initial approved formats are the same as
new uploads. Extension, old MIME metadata, and GCS object name are hints only.

Exclude from initial migration:

- archived syncstrings;
- SVG and HTML;
- PDF and office documents;
- archives and executables;
- audio and video;
- opaque binary data; and
- rows whose content UUID does not match the recovered canonical bytes.

If product evidence later establishes a needed non-image attachment class,
design that path separately instead of weakening the public raster namespace.

### Migration scope

First inventory all verified raster candidates and estimate bytes/object count.
If the corpus fits the approved storage budget, migrate every verified image;
there is no need for a last-access cutoff. If it does not, use this priority:

1. references discovered in migrated project files and records;
2. images used by recently active legacy accounts/projects;
3. recent legacy `last_active` evidence;
4. remaining verified raster images; and
5. on-demand support recovery for the tail.

Legacy `last_active` may prioritize migration but never becomes target R2
retention state.

## Legacy Migration Pipeline

1. Export a stable read-only PostgreSQL inventory including UUID, byte/GCS
   state, compression, size, timestamps, project/account hints, and exact
   archived-syncstring classification.
2. Inventory the GCS bucket and reconcile database pointers, missing objects,
   duplicate keys, and unexpected sizes.
3. Recover canonical bytes from PostgreSQL or GCS and decompress according to
   metadata.
4. Enforce maximum encoded/decoded size and safely identify raster format and
   dimensions.
5. Verify the recovered bytes reproduce the legacy UUID.
6. Compute full SHA-256 for integrity metadata.
7. Conditionally write the deterministic R2 UUID key.
8. Read the object back or verify `HEAD` metadata before marking the migration
   manifest successful.
9. Record failures and conflicts in a resumable operator manifest outside the
   serving path.
10. Repeat idempotently until selected coverage and verification gates pass.

The migration manifest is operational batch state, not a permanent public blob
catalog. It may contain source, attempt, error, validation, and verification
details needed to resume safely.

Bulk migration bypasses normal account/project throttles but has explicit
operator concurrency, daily bytes, object-count, and error-rate controls. It
must not overload the legacy VM, GCS, bay, Worker, or R2 API.

## Operations, Metrics, and Alerts

Required aggregate signals:

- R2 total object count and bytes;
- new physical bytes and objects per bay/day;
- upload attempts, accepted uploads, deduplicated uploads, and denials by
  reason/tier;
- Worker requests, cache-hit ratio, R2 misses, 404s, throttles, and 5xx errors;
- migration selected/succeeded/skipped/quarantined/missing counts and bytes;
- legacy source read/decompression/validation failures; and
- projected monthly R2 storage and operation costs.

Required alerts:

- per-bay emergency creation budget near/exhausted;
- abrupt increase in Worker misses or valid-looking random UUID scans;
- falling cache-hit ratio;
- R2 or Worker health-check failures;
- collision/integrity mismatch;
- migration source disappearance or rising error rate; and
- monthly storage/cost thresholds.

Do not emit a database/Analytics Engine event for every successful public read.
Cloudflare aggregate analytics is the source for read traffic. Sampling may be
introduced later for a concrete product question, never as a serving
dependency.

## Security Requirements

- Upload requires an authenticated account.
- Project-attributed upload requires collaborator access resolved by the
  owning bay.
- The bay recomputes identifiers; client-provided hashes are untrusted.
- Size is bounded while streaming, before the full body is retained.
- Media type comes from validated bytes and safe decoding.
- Pixel/dimension limits prevent decompression/image bombs.
- Public inline serving is raster-only and uses `nosniff`.
- R2 credentials are never sent to browsers or project containers.
- Read credentials cannot list or write; write credentials cannot administer
  buckets or Cloudflare accounts.
- Cloudflare bootstrap tokens are one-time admin inputs: they are never stored,
  logged, returned to the browser, or used after the durable automation token
  is created.
- The durable Cloudflare automation token is scoped to the selected account and
  zone and lacks API-token-management permission.
- The UI distinguishes temporary bootstrap tokens, durable Cloudflare REST
  automation tokens, and R2 S3 object credentials.
- The Worker maps one validated identifier to one fixed prefix and cannot act
  as a general R2 proxy.
- Canonical cache keys ignore attacker-controlled filenames and irrelevant
  query strings.
- Missing-object responses do not reveal uploader/account/project metadata.
- Exceptional removal creates a tombstone and purges Cloudflare cache so a
  legally removed image cannot reappear from an old edge copy.
- Support and upload UI document that public blob URLs are not appropriate for
  secrets or sensitive personal data.

## Test Plan

### Storage and identity

- New upload writes exact bytes and trusted metadata to R2.
- Existing identical upload is idempotent and cannot overwrite different
  bytes.
- UUID/SHA-256/size mismatch fails closed.
- PostgreSQL mode works with no Cloudflare configuration.
- R2 mode refuses startup/readiness with partial or inconsistent settings.

### Authorization and throttling

- Anonymous upload is rejected before reading a large request body.
- Non-collaborator project upload is rejected.
- Home/owning bay routing is authoritative in multibay tests.
- Account, project, IP, membership-tier, and per-bay limits are independently
  exercised.
- Duplicate uploads consume request/rate defense but not new-physical-byte
  budget after confirmed deduplication.
- Budget exhaustion never affects reads.

### Media security

- Valid approved formats round-trip byte-for-byte.
- Extension/MIME spoofing is rejected.
- SVG, HTML, PDF, archive, executable, audio, and video fixtures do not enter
  the public image namespace.
- Oversize encoded images and oversized decoded dimensions are rejected.
- Corrupt and truncated images are rejected.

### Public reads and caching

- Canonical anonymous GET and HEAD work.
- Legacy/current filename-plus-query URLs resolve to the same canonical object.
- Filename and irrelevant query variation cannot create independent R2
  lookups/cache entries.
- Conditional requests and immutable cache headers are correct.
- Short negative caching does not conceal a newly uploaded object beyond its
  configured duration.
- Worker exposes no listing, metadata, or write behavior.

### Cloudflare bootstrap and Worker provisioning

- Bootstrap-token submission requires site-admin fresh auth.
- Bootstrap token values are not persisted in site settings, logs, LRO records,
  browser state, telemetry, or errors.
- Durable-token creation requests only the expected account and zone resources.
- Durable-token permission groups include Worker, R2 bucket, tunnel, DNS, and
  required zone-settings access, but exclude API-token-management permissions.
- Bootstrap-token invalidation is attempted after durable-token creation.
- Invalidation failure returns a warning with the token id when available but
  never returns the bootstrap token secret.
- Durable-token creation failure saves no bootstrap token and does not enable
  R2 blob serving.
- Resource reconciliation is idempotent across existing bucket, existing
  Worker, existing route/custom domain, and repeated wizard runs.
- `blob_r2_public_url` is saved only after the Worker endpoint passes a smoke
  test.
- Partial Cloudflare configuration leaves `auto` mode on PostgreSQL rather
  than silently writing new blobs to a broken R2 path.

### Jupyter and application semantics

- A live notebook uses compact global links.
- Saved `.ipynb` contains native attachments and works in local Jupyter, GitHub,
  and Colab without network access to CoCalc.
- External native attachments factor into global links on load.
- Copying notebook Markdown between projects keeps working.
- Chat, Markdown, task, course, theme, support, export, import, and ACP paths
  continue to resolve images.
- Account/project deletion leaves ordinary public images readable.
- Stopped projects can load and save notebooks without starting a container.

### Legacy fixtures

- PostgreSQL bytea, GCS gzip, and GCS zlib sources.
- Archived-syncstring exclusion.
- Missing source objects and corrupt compression.
- UUID mismatch and object collision.
- Valid PNG/JPEG/GIF/WebP plus excluded non-image fixtures.
- Newline, unusual filename, and misleading metadata cases.

## Rollout

### Phase 0: finalize policy and inventory

- Approve permanent-public raster semantics and sensitive-upload warnings.
- Inventory current generic non-image upload callers and choose reject versus
  authenticated compatibility behavior.
- Inventory current membership quota usage and choose rolling tier limits.
- Re-run the current cocalc.ai production blob inventory: row count, total
  bytes, extension/MIME hints, and validated raster versus non-raster split.
- Inventory legacy raster candidates and projected R2 cost, but do not make
  legacy completeness a prerequisite for moving current production blobs to R2.

Gate: no unresolved path can silently publish arbitrary active content.

### Phase 1: complete storage abstraction and bay admission

- Extend the existing PostgreSQL-backed `BlobByteStore` seam to the full target
  interface needed by R2: existence/metadata checks, immutable conditional put,
  trusted content type, SHA-256, byte size, and deterministic key mapping.
- Add the R2 implementation while keeping PostgreSQL mode as the default
  fallback for self-hosted deployments and for managed rollback.
- Add media validation shared by browser, RPC, generated-image, import, and
  migration paths.
- Add rolling membership upload limits and bounded per-bay emergency counters.
- Preserve current total quotas as temporary defense during observation.

Gate: focused tests cover every producer and multibay authorization path.

### Phase 2: staging bucket and Worker

- Replace the screenshot/manual-token Cloudflare wizard with the single
  bootstrap-token flow.
- Extend durable-token creation to include the Worker and Worker-route
  permissions needed for public blob delivery.
- Add an idempotent server-side Cloudflare blob Worker reconciliation API that
  can be called from the wizard and from operator tooling.
- Provision the private staging Standard R2 bucket.
- Deploy the canonical read Worker, caching, WAF/rate rules, and health checks.
- Exercise cold/warm reads at representative sizes and malformed/miss load.
- Confirm no public bucket/list/write path exists.

Gate: the wizard creates and stores only durable automation/S3 credentials, the bootstrap token
is invalidated or explicitly flagged for manual deletion, and staging cost,
cache, and security behavior is understood under load.

### Phase 3: dual-write current staging data

- Write new verified images to R2 while preserving PostgreSQL bytes.
- Backfill all current staging image rows.
- Keep non-raster rows in PostgreSQL-only compatibility mode until a separate
  authenticated non-image attachment policy exists.
- Compare bytes, UUID, metadata, and server-side/Jupyter reads exhaustively.
- Switch staging public reads to Worker/R2.

Gate: no read depends on PostgreSQL for the migrated staging corpus.

### Phase 4: production current corpus

- Provision production bucket and Worker.
- Deploy bay writers before changing public read routing.
- Dual-write new production images.
- Backfill and verify the small current production corpus.
- Canary public reads, then switch all current images to Worker/R2.
- Keep PostgreSQL bytea intact for rollback.
- Record exact counts of migrated raster rows, PostgreSQL-only compatibility
  rows, skipped rows, and failures before starting legacy migration.

Gate: current production images have verified R2 copies and healthy cache/read
metrics.

### Phase 5: legacy pilot

- Build exact source and archived-syncstring inventories.
- Dump legacy PostgreSQL metadata to a resumable manifest that includes enough
  source information to reconstruct bytes from PostgreSQL or `smc-blobs`
  without consulting the serving path.
- Copy the manifest to production-side operator storage; do not load millions
  of legacy rows into the live `blobs` serving table as the migration catalog.
- Migrate a representative pilot across database/GCS/compression/image types.
- Verify known support-case URLs and restored notebooks.
- Compare migration output with source bytes and ordinary `.ipynb` saves.

Gate: zero unexplained byte/UUID mismatches and acceptable source load.

### Phase 6: legacy bulk migration

- Run bounded parallel migration in priority order.
- Continuously reconcile manifests and verify random samples.
- Expand to all verified raster images if inventory cost remains approved.
- Provide on-demand recovery for missing tail cases during the run.

Gate: selected coverage and support cases meet explicit success thresholds.

### Phase 7: cleanup decisions

- Remove automatic durable-image deletion and obsolete active-storage UI after
  rolling limits are proven.
- Remove archived-syncstring code in a separate reviewed change.
- Decide legacy VM/GCS retention separately; do not delete sources merely
  because selected image migration completed.
- Remove PostgreSQL image bytea only after a separate verified backup and
  rollback review.

## Rollback

- Deploy bay writers before public read changes.
- Preserve current PostgreSQL bytes during dual-write and initial production
  cutover.
- Keep old database/GCS sources read-only and unchanged.
- Public routing can return to the hub while R2/Worker issues are repaired.
- Never overwrite a valid R2 object during rollback or retry.
- Membership rolling limits can be disabled independently while current total
  quotas remain as temporary defense.
- A Worker failure must not cause writes to fall back silently to a different
  backend.

## Explicitly Rejected Complexity

Do not implement these without a new concrete product requirement:

- random attachment handles;
- UUID-to-handle alias tables;
- per-document occurrence/reference tables;
- blob read grants or project membership checks on public images;
- per-object access counters or last-access timestamps;
- Durable Objects, KV, or PostgreSQL writes on public reads;
- routine retention, garbage collection, or account/project cascade deletion;
- one R2 bucket per project, account, bay, or region;
- Cloudflare Images as the primary store or delivery path;
- arbitrary public transformation parameters; or
- direct browser-to-R2 upload in the first implementation.

## Relevant Source References

- `src/packages/hub/servers/app/blob-upload.ts`
- `src/packages/hub/servers/app/blobs.ts`
- `src/packages/server/blobs/save.ts`
- `src/packages/server/membership/blob-limits.ts`
- `src/packages/util/db-schema/blobs.ts`
- `src/packages/database/postgres/blobs/methods-impl.ts`
- `src/packages/database/postgres/blobs/archive.ts`
- `src/packages/server/conat/api/db.ts`
- `src/packages/conat/hub/api/db.ts`
- `src/packages/conat/inter-bay/api.ts`
- `src/packages/project-host/jupyter-ipynb.ts`
- `src/packages/jupyter/ipynb/blob-attachments.ts`
- `src/packages/jupyter/ipynb/filesystem.ts`
- `src/packages/frontend/blobs/upload-image.ts`
- `src/packages/frontend/editors/slate/upload.tsx`
- `src/packages/frontend/editors/markdown-input/component.tsx`
- `src/packages/export/blob-assets.ts`
- `src/packages/lite/hub/acp/blob-materialization.ts`
- `src/packages/backend/r2.ts`
- `/home/user/upstream/cocalc/src/smc-hub/postgres-blobs.coffee`

## External References

- Cloudflare R2 pricing:
  `https://developers.cloudflare.com/r2/pricing/`
- Cloudflare R2 storage classes:
  `https://developers.cloudflare.com/r2/buckets/storage-classes/`
- Cloudflare R2 data location:
  `https://developers.cloudflare.com/r2/reference/data-location/`
- Cloudflare R2 public/custom domains:
  `https://developers.cloudflare.com/r2/buckets/public-buckets/`
- Cloudflare R2 and cache interaction:
  `https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/`
- Workers Caching:
  `https://developers.cloudflare.com/workers/cache/configuration/`
- Workers pricing:
  `https://developers.cloudflare.com/workers/platform/pricing/`
- Worker Rate Limiting binding:
  `https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/`
- Cloudflare Images pricing, evaluated and rejected as the primary path:
  `https://developers.cloudflare.com/images/pricing/`
