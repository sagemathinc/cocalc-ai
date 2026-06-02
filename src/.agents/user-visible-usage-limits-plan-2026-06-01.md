# User-Visible Usage And Limits Plan

## Objective

Give users a clear, product-level view of current usage, limits, and rolling
window recovery times.

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
- When will usage start falling out of the window?
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

- keep the existing raw usage-status fields for compatibility;
- add a normalized account usage overview DTO that frontend dashboards and
  warnings can consume without each component rediscovering field names.

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
  reset_at?: string;
  reset_in?: string;
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
  reset_at?: string;
  reset_in?: string;
}
```

Implementation notes:

- `pressure_5h` is the max `ratio` among all 5h meters.
- `pressure_7d` is the max `ratio` among all 7d meters.
- `storage` is the max point-in-time storage/object ratio.
- `live_capacity` is the max point-in-time live-capacity ratio.
- The overview should preserve reset semantics as rolling-window relief, not a
  hard global reset. Copy should say "usage starts falling out of this window"
  or "next usage expires", not imply all usage resets at once.

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
- primary limiting meter and next relief time.

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
  - reset/relief time;
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

- Add an `AccountUsageOverview` builder that combines:
  - `getMembershipDetails({ refresh_usage_status: true })`;
  - `getAIUsageStatus`;
  - normalized effective membership limits.
- Add focused unit tests for:
  - ratio computation;
  - 5h/7d max-pressure selection;
  - missing/unlimited limits;
  - rolling-window reset copy fields;
  - measurement warnings.
- Keep old APIs unchanged.

### Phase 2: Dashboard Page

- Add `Usage & Limits` in account settings.
- Render composite gauges first.
- Render category cards with normalized meters.
- Link Store/membership status to the new page.
- Keep the current membership status panel as a compact summary or legacy view
  until the new page is complete.

### Phase 3: Shared Warning Components

- Extract shared warning threshold helpers.
- Migrate AI and managed-egress top-bar warnings to the normalized overview.
- Ensure polling does not close modals or reset open state.
- Preserve existing recent-events displays.

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
  - when the window starts recovering;
  - the next practical action.

### Phase 5: Fill Remaining Meters

- Add invite/collaboration usage counters where enforcement already exists but
  user-visible usage is missing.
- Add ACP queued/running/created usage counters.
- Add user-facing CPU history if cheap by refactoring the admin CPU history
  path.
- Add user-facing egress history only where privacy and cost are acceptable.

### Phase 6: Replace Legacy Membership Status Layout

- Decide whether the old Store/membership details quota panel remains as a
  compact purchase-oriented summary.
- Remove duplicated metric-specific display logic once the dashboard and shared
  warning system are stable.
- Keep admin membership detail panels separate; admins need user-debugging
  fields that normal users do not.

## Design Notes

- The summary meters should be visually dominant and simple.
- The detailed table should be explicit, accounting-style, and sortable by
  severity.
- Use "starts recovering" or "next usage expires" for rolling windows.
- Avoid saying "resets" unless the underlying implementation is a true fixed
  reset window.
- Treat "no limit reported" differently from "0 limit".
- Give every blocked state a concrete escape hatch:
  - wait;
  - delete/archive;
  - stop projects;
  - upgrade;
  - contact admin.

## Open Questions

- Should anonymous/free AI usage with only `analytics_cookie` appear in the same
  dashboard before sign-in, or only in AI-specific UI?
- Should the top nav show one combined usage warning pill or keep separate AI
  and egress pills until the overview matures?
- Do we want exact "time until below limit" rather than "oldest usage expires"?
  Exact time is better but requires bucket/event data and a threshold
  computation for each meter.
- Which ACP and invite counters currently have durable event logs that can
  support 5h/7d user display without adding new tables?

## Recommended Next Slice

Start with Phase 1 and Phase 2 for only the meters already available today:

- AI 5h/7d;
- managed CPU 5h/7d;
- managed egress 5h/7d;
- account storage;
- projects;
- RootFS;
- blobs.

This gives the user-visible page with high value and low implementation risk.
Then migrate top-bar warnings onto the normalized overview.
