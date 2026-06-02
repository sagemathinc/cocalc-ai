# User-Visible Usage And Limits Plan

## Objective

Give users a clear, product-level view of current usage, limits, and fixed
window reset times.

The current implementation has useful pieces, but they are scattered:

- AI usage has a compact user-facing status and top-bar warning.
- Managed egress has top-bar warnings, recent events, project settings history,
  and membership detail rows.
- Managed CPU has backend/account usage status and admin visibility, but little
  direct user-facing presentation.
- Account storage, RootFS, blob, project count, and collaborator/invite limits
  appear in some membership/status paths but are not organized as one coherent
  usage console.

The goal is a single user-visible page plus reusable contextual warnings. Users
should be able to answer:

- What am I close to hitting?
- Which 5-hour and 7-day windows are limiting me?
- When do my current windows reset?
- What action is blocked, degraded, or still safe?
- What can I delete, wait for, or upgrade to fix this?

## Product Model

CoCalc has many limits, but the user-facing model should be simple:

1. `5-hour pressure`
   - one summary gauge for short-term limits;
   - driven by the highest normalized usage ratio among all active 5-hour
     meters.
2. `7-day pressure`
   - one summary gauge for sustained-use limits;
   - driven by the highest normalized usage ratio among all active 7-day meters.
3. `Storage / object pressure`
   - point-in-time quota pressure for project storage, blobs, RootFS images, and
     project count.
4. `Live capacity pressure`
   - point-in-time limits such as sponsored running projects and ACP running
     jobs.

The one-dimensional 5-hour and 7-day gauges are useful, but they must be
explicitly a summary:

- compute each meter ratio as `used / limit`;
- ignore missing or unlimited meters;
- use the max ratio as the summary pressure;
- display the winning meter label next to the gauge;
- drill down immediately to every contributing meter.

This avoids inventing arbitrary exchange rates between AI units, bytes, CPU
seconds, and invite counts. If later we want a weighted score for ranking or
abuse triage, that should be separate from the user-visible "closest limit"
gauge.

## Usage Window Semantics

User-facing membership quotas should use fixed per-account windows, not sliding
rolling windows.

The current backend implementation for AI, managed CPU, and managed egress uses
sliding windows:

- AI sums `ai_usage_log` rows where `time >= now() - interval '5 hours'` or
  `7 days`.
- managed egress sums `account_managed_egress_events` rows where `occurred_at`
  is inside the last 5 hours or 7 days.
- managed CPU sums `account_cpu_usage_events` rows where `sample_ended_at` is
  inside the last 5 hours or 7 days.
- current `reset_at` values are the oldest counted event plus the window length.
  That is not necessarily the time the account is unblocked, and it is not a
  reset to zero.

That model is appropriate for throttling and abuse smoothing, but it is not the
right product model for cocalc-ai membership limits. Users should see the
OpenAI-style model:

- the first metered usage after no active window starts the account's 5-hour
  window and 7-day window;
- all relevant 5h/7d usage meters accrue inside those same fixed account
  windows;
- each window has one clear `starts_at` and `resets_at`;
- when the window expires, usage for that window resets to zero;
- the next metered usage after expiration starts a new window.

There must be exactly one user-visible 5-hour window and one user-visible 7-day
window per account. AI, managed CPU, managed egress, project-host prepaid spend,
project-host postpaid/credit spend, owner-configured host spend caps, invites,
ACP, and any future membership meters should all use the account's same
`starts_at`/`resets_at` for a given window class. Humans cannot reason about a
different reset time per meter, and a single max-pressure gauge only works if
all 5h meters share one 5h clock and all 7d meters share one 7d clock.

This is psychologically simpler, makes upgrade/wait decisions clearer, and
turns "we fixed the bad configuration, but you must wait out the mess" into "we
fixed the configuration and reset affected usage".

Abuse-specific throttles may still use sliding windows if needed, but those
should be separate from user-facing membership windows and should not be
presented as normal membership quota resets.

## Global Reset Semantics

Support epoch-based global resets for user-facing membership usage windows.

This is important because cocalc-ai has many tier limits. We should expect some
early configurations to be wrong. When admins fix a bad tier configuration, the
best user experience is to reset affected usage immediately rather than ask
users to wait out stale accounting.

Design:

- maintain one global user-visible membership usage epoch per window class;
- window classes are `5h` and `7d`;
- account window rows record the membership epoch that was active when the
  window started;
- usage events should ideally record the 5h/7d window ids active when the event
  was recorded; until then, aggregate by the active account window's
  `starts_at`/`resets_at`;
- bumping the membership epoch ignores previous usage for that account/window
  class without deleting historical logs;
- if we later need hidden abuse/accounting epochs per meter family, those must
  not create separate user-visible reset clocks;
- admin global reset can be scoped by:
  - window class;
  - membership tier;
  - all accounts;
  - optionally a specific account for support.

Admin operation:

- add a fresh-auth-required admin RPC such as
  `purchases.adminResetUsageWindows`;
- require a reason string;
- write an audit record with admin account, scope, previous epoch, new epoch,
  and reason;
- never physically delete usage events as part of a reset;
- expose a small admin UI action later, but the RPC/audit path is the release
  critical part.

User-facing behavior after reset:

- affected meters immediately show zero usage or a newly started empty window;
- if there is no active usage after reset, the dashboard should say "No active
  window yet" rather than inventing a reset time;
- the next metered usage starts a fresh fixed window under the new epoch.

## Current Backend Anchors

Existing code already provides most of the raw data:

- `src/packages/server/membership/usage-status.ts`
  - account storage;
  - project count;
  - RootFS usage;
  - blob usage;
  - managed egress 5h/7d usage, remaining values, reset times, categories, and
    recent events;
  - managed CPU 5h/7d usage, remaining values, reset times, and recent events.
- `src/packages/server/ai/usage-status.ts`
  - AI usage 5h/7d, limits, remaining values, and reset times.
- `src/packages/conat/hub/api/purchases.ts`
  - `getMembershipDetails({ refresh_usage_status: true })`;
  - `getAIUsage()`;
  - managed egress/CPU admin history APIs.
- `src/packages/server/membership/effective-limits.ts`
  - normalized membership limits for CPU, egress, storage, blobs, RootFS,
    invite/collaboration, and ACP fields.

Recommended backend direction:

- replace user-facing rolling-window aggregation for AI, managed CPU, and
  managed egress with fixed account windows;
- keep historical usage events for audit/history/admin charts;
- add a normalized account usage overview DTO that frontend dashboards and
  warnings can consume without each component rediscovering field names.

Release-blocking backend database work:

- add an account usage window table, e.g. `account_usage_windows`:
  - `id UUID PRIMARY KEY`;
  - `account_id UUID NOT NULL`;
  - `family TEXT NOT NULL`;
  - first implementation stores the shared user-visible scope value
    `membership` here; the column name can be renamed later;
  - `window TEXT NOT NULL`;
  - `epoch BIGINT NOT NULL`;
  - `starts_at TIMESTAMPTZ NOT NULL`;
  - `resets_at TIMESTAMPTZ NOT NULL`;
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
  - lookup index on `(account_id, family, window, epoch, resets_at DESC)`.
- add a global epoch table, e.g. `account_usage_epochs`:
  - `family TEXT NOT NULL`;
  - first implementation stores the shared user-visible scope value
    `membership` here;
  - `window TEXT NOT NULL`;
  - `epoch BIGINT NOT NULL`;
  - `updated_at TIMESTAMPTZ NOT NULL`;
  - `updated_by UUID`;
  - `reason TEXT`;
  - primary key `(family, window)`.
- add a reset audit table, e.g. `account_usage_epoch_resets`, to preserve every
  epoch bump.
- update AI, managed CPU, managed egress, and dedicated-host spend usage queries
  to aggregate against the account's active fixed membership window.
- ensure first metered usage creates missing active windows transactionally.
- if usage events do not store window ids in the first implementation, aggregate
  using `(account_id, membership scope, window, epoch, starts_at, resets_at)`
  from the active window row.
- make enforcement read the fixed-window aggregate, not the sliding aggregate.

## Proposed Normalized DTO

Add a user-facing account usage overview RPC, probably in the purchases domain:

```ts
type UsageWindow = "5h" | "7d" | "point";

type UsageMeterSeverity = "ok" | "near" | "over" | "unknown";

interface AccountUsageMeter {
  id: string;
  category:
    | "ai"
    | "compute"
    | "network"
    | "storage"
    | "projects"
    | "collaboration"
    | "codex"
    | "rootfs"
    | "blob";
  window: UsageWindow;
  label: string;
  help: string;
  unit: "units" | "bytes" | "seconds" | "count";
  used?: number;
  limit?: number;
  remaining?: number;
  ratio?: number;
  percent?: number;
  severity: UsageMeterSeverity;
  starts_at?: string;
  resets_at?: string;
  reset_at?: string; // deprecated alias during migration
  reset_in?: string;
  epoch?: number;
  action_when_over?: string;
  upgrade_relevant: boolean;
  source?: "membership_usage_status" | "ai_usage_status";
}

interface AccountUsageOverview {
  collected_at: string;
  membership_label?: string;
  membership_title?: string;
  summary: {
    pressure_5h?: AccountUsageSummaryPressure;
    pressure_7d?: AccountUsageSummaryPressure;
    storage?: AccountUsageSummaryPressure;
    live_capacity?: AccountUsageSummaryPressure;
  };
  meters: AccountUsageMeter[];
  recent_events: {
    managed_egress?: ManagedEgressEventSummary[];
    managed_cpu?: ManagedCpuEventSummary[];
  };
  measurement_warnings: string[];
}

interface AccountUsageSummaryPressure {
  percent: number;
  severity: UsageMeterSeverity;
  limiting_meter_id?: string;
  limiting_meter_label?: string;
  starts_at?: string;
  resets_at?: string;
  reset_at?: string; // deprecated alias during migration
  reset_in?: string;
  epoch?: number;
}
```

Implementation notes:

- `pressure_5h` is the max `ratio` among all 5h meters.
- `pressure_7d` is the max `ratio` among all 7d meters.
- `storage` is the max point-in-time storage/object ratio.
- `live_capacity` is the max point-in-time live-capacity ratio.
- For fixed-window meters, copy should say "resets at" and use `resets_at`.
- During migration, do not label old rolling-window `reset_at` values as hard
  resets.

## Multibay Routing

This is account-owned data.

- The account home bay is authoritative for membership resolution and account
  usage overview composition.
- Project-attributed data may live on project-owning bays or project hosts, but
  the user-facing aggregate must be requested through the account home bay.
- Account rehome must move or reconstitute account-attributed usage records, or
  the overview must explicitly tolerate cross-bay historical fragments.
- Do not compute usage by assuming the local hub database is authoritative.

## User-Facing Dashboard

Add a dedicated page under account settings, e.g. `Usage & Limits`.

The page should not be buried inside Store. Store can link to it, but the page
is operational status, not purchase flow.

Top section:

- current membership tier;
- 5-hour pressure gauge;
- 7-day pressure gauge;
- storage/object pressure gauge;
- live-capacity pressure gauge;
- primary limiting meter and next reset time.
- if no active 5h/7d window exists yet, show "No active window yet" and explain
  that the first metered usage starts the window.

Main content:

- cards grouped by category:
  - AI usage;
  - Managed CPU;
  - Network egress;
  - Account/project storage;
  - RootFS and blobs;
  - Projects and running-project slots;
  - Collaboration/course invites;
  - Codex/ACP usage.
- each card shows:
  - 5h row if applicable;
  - 7d row if applicable;
  - current/limit/remaining;
  - window start and reset time;
  - what gets blocked or slowed when over;
  - upgrade/delete/wait guidance.

Details:

- egress card should expose category breakdown and recent events.
- CPU card should expose recent events and link to a history chart once a
  user-facing CPU history endpoint exists.
- storage card should explain sampled/unsampled project storage and stale
  measurement conditions.

## Contextual Warning System

Replace metric-specific one-off warning logic with a shared warning component
that consumes `AccountUsageOverview`.

Keep the existing AI and managed-egress top-bar warnings during migration, but
move their threshold logic into shared helpers.

Shared behavior:

- thresholds:
  - `near`: ratio >= 75%;
  - `severe`: ratio >= 90%;
  - `over`: ratio >= 100%;
- top-bar warning shows the highest-severity, highest-ratio meter;
- modal shows all active warnings grouped by 5h, 7d, and point-in-time limits;
- warning links to the new `Usage & Limits` page, not just Store;
- upgrade CTA remains available when the limit is membership-controlled;
- dismiss only non-blocking warnings and only until the relevant usage state
  changes.

Contextual integration points:

- AI/Codex prompts and agent start flows;
- project start and create/open flows for managed CPU and running-project
  slots;
- app proxy/download/SSH paths for managed egress;
- project creation for project count/storage pressure;
- file upload/storage-increasing operations for account storage;
- RootFS publish/save flows;
- blob upload flows;
- collaborator/course invite flows;
- ACP queue/create flows.

## Phased Implementation

### Phase 1: Inventory And DTO

Status: started.

Completed first backend slice:

- added lazy-created fixed account usage window tables and epoch/reset audit
  tables in `src/packages/server/membership/usage-windows.ts`;
- added shared fixed 5h/7d window creation on first account-attributed AI,
  managed CPU, or managed egress usage;
- changed account AI, managed CPU, and managed egress usage reads to aggregate
  against the account's active shared fixed window instead of a sliding
  `now() - interval ...` window;
- changed dedicated-host prepaid/postpaid spend windows and owner-configured
  host spend caps to aggregate against the same shared account windows;
- preserved historical event/log tables for admin history and audit;
- added backend helper support for epoch bumps/global reset semantics;
- added a fresh-auth-required admin RPC for resetting one or both shared account
  usage windows;
- added a fresh-auth admin UI control in `CPU & Abuse Signals` for resetting
  the shared 5-hour window, 7-day window, or both with a required audit reason;
- added the normalized `AccountUsageOverview` backend DTO and purchases RPC for
  AI, managed CPU, managed egress, dedicated-host prepaid/postpaid spend,
  project storage, project count, RootFS, and blob meters.

Remaining:

- continue hardening the user-facing dashboard and wire contextual warnings to
  the normalized overview.

- Replace user-facing sliding-window accounting with shared fixed account
  windows for AI, managed CPU, and managed egress. (first slice complete)
- Replace dedicated-host spend window accounting with the same shared fixed
  account windows. (complete)
- Add epoch/global reset tables, backend helpers, and fresh-auth admin RPC.
  (complete)
- Add an `AccountUsageOverview` builder that combines:
  - `getMembershipDetails({ refresh_usage_status: true })`;
  - `getAIUsageStatus`;
  - normalized effective membership limits.
    (complete for currently available meters)
- Add focused unit tests for:
  - fixed-window creation on first metered usage;
  - fixed-window aggregation;
  - fixed-window reset to zero after expiration;
  - epoch bump/global reset behavior;
  - ratio computation;
  - 5h/7d max-pressure selection;
  - missing/unlimited limits;
  - fixed-window reset copy fields;
  - measurement warnings.
- Keep old APIs unchanged.

### Phase 2: Dashboard Page

Status: started.

Completed first frontend slice:

- merged PR 47's account settings membership and `Usage & Limits` pages;
- added top-level 5-hour, 7-day, and storage pressure cards using the
  normalized `AccountUsageOverview` RPC;
- changed the account membership settings data loader to request fresh usage
  status for usage-facing pages;
- added a manual refresh button and a fresh-details browser event so the
  top-bar account storage warning updates immediately when `Usage & Limits`
  loads newer usage data;
- added a normalized usage-overview browser event so top-bar usage warnings can
  immediately consume the exact dashboard data after a manual refresh;
- kept PR 47's clean card-based detail layout for project/storage, runtime, AI,
  CPU, and network transfer drill-downs.

- Add `Usage & Limits` in account settings.
- Render composite gauges first.
- Render category cards with normalized meters.
- Link Store/membership status to the new page.
- Keep the current membership status panel as a compact summary or legacy view
  until the new page is complete.

### Phase 3: Shared Warning Components

- Extract shared warning threshold helpers.
- Migrate AI and managed-egress top-bar warnings to the normalized overview.
- Added a managed CPU top-bar warning from the normalized overview. It shows the
  highest-pressure 5h/7d CPU window, links to `Usage & Limits`, and explains
  that existing projects keep running while new project starts may be blocked.
- Ensure polling does not close modals or reset open state.
- Preserve existing recent-events displays.
- Add optional, off-by-default top-nav usage indicator. Avoid making users feel
  constantly anxious about usage.

### Phase 4: Contextual Warnings

- Add small inline warning surfaces at operation entry points:
  - project start/create/open;
  - AI/Codex submission;
  - downloads/proxy/egress;
  - storage-increasing actions;
  - invites and ACP creation.
- Each warning should say:
  - what limit is close/over;
  - what action may fail;
  - when the current fixed window resets;
  - the next practical action.

### Phase 5: Fill Remaining Meters

- Add invite/collaboration usage counters where enforcement already exists but
  user-visible usage is missing.
- Add ACP queued/running/created usage counters.
- Add user-facing CPU history if cheap by refactoring the admin CPU history
  path.
- Add user-facing egress history only where privacy and cost are acceptable.
- Delete anonymous AI usage support instead of adding it to this dashboard.

### Phase 6: Replace Legacy Membership Status Layout

- Decide whether the old Store/membership details quota panel remains as a
  compact purchase-oriented summary.
  - Decision: no. It does not belong in Store; it was there because there was no
    better usage surface yet.
- Remove duplicated metric-specific display logic once the dashboard and shared
  warning system are stable.
- Keep admin membership detail panels separate; admins need user-debugging
  fields that normal users do not.

## Design Notes

- The summary meters should be visually dominant and simple.
- The detailed table should be explicit, accounting-style, and sortable by
  severity.
- Use "resets at" only for fixed membership windows.
- For any remaining sliding abuse throttles, use explicit copy such as "starts
  freeing up" or "oldest event expires".
- Treat "no limit reported" differently from "0 limit".
- Give every blocked state a concrete escape hatch:
  - wait;
  - delete/archive;
  - stop projects;
  - upgrade;
  - contact admin.

## Open Questions

- Which ACP and invite counters currently have durable event logs that can
  support 5h/7d user display without adding new tables? (ANS: I don't know.)

## Decisions

- Anonymous AI usage is not part of cocalc-ai. Any `analytics_cookie` AI usage
  paths are legacy and should be removed instead of surfaced.
- Free tier will likely have zero bundled AI usage; use a short trial of a
  higher tier if free users should experience AI.
- The top nav does not need usage information by default. Add only an optional,
  small usage indicator, off by default.
- User-facing windows should be fixed windows with exact reset times, not
  sliding windows.
- Use `TimeAgo` or equivalent UI that can show both absolute and relative reset
  times.

## Recommended Next Slice

Start with backend fixed-window semantics before building the user dashboard:

1. Add fixed membership usage windows and epoch/global reset support.
2. Convert AI, managed CPU, and managed egress enforcement to fixed windows.
3. Convert project-host prepaid/postpaid spend caps and owner-configured host
   spend caps to those same fixed windows.
4. Add the normalized overview DTO for the meters already available today:
   - AI 5h/7d;
   - managed CPU 5h/7d;
   - managed egress 5h/7d;
   - dedicated-host prepaid/postpaid spend 5h/7d;
   - account storage;
   - projects;
   - RootFS;
   - blobs.
     (complete)
5. Build the `Usage & Limits` page from that DTO.

This gives the user-visible page with high value and low implementation risk.
Then migrate top-bar warnings onto the normalized overview.
