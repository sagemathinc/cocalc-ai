# Admin settings refactor (schema extension proposal)

## Goals
- Keep admin settings declarative in `src/packages/util/db-schema`.
- Make the UI organized, scannable, and less overwhelming.
- Support wizards + dependent state without hardcoding UI logic.
- Preserve tags for filtering/search while adding richer layout metadata.

## Proposed schema extensions (backwards compatible)
Add optional fields to the `Config` interface:

```ts
// new optional metadata
readonly group?: string;        // top-level section
readonly subgroup?: string;     // section inside group
readonly order?: number;        // sort order inside subgroup (default 1000)
readonly advanced?: boolean;    // hidden unless "Show advanced"
readonly hidden?: boolean;      // always hidden (internal/system)
readonly depends_on?: string[]; // hide/disable unless keys present
readonly required_when?: {      // validation / warnings
  key: string;
  equals?: string;
  present?: boolean;
}[];
readonly wizard_id?: string;    // wizard/modal to launch
readonly action_label?: string; // optional button label (default "Wizard…")
readonly launchpad_only?: boolean;
readonly rocket_only?: boolean;
```

## UI behavior enabled by schema

### Navigation / structure
- Render group list from `group`.
- Render subgroup headers from `subgroup`.
- Sort by `order` within subgroup.

### Progressive disclosure
- `advanced: true` hidden by default.
- `depends_on` disables or hides fields until prerequisites are met.

### Status + validation
- Use `required_when` + existing `valid` to compute status.
- Show group status badges (✅/⚠️/❌).
- Show global “Setup Overview” panel listing incomplete groups.

### Wizards
- If any field in subgroup has `wizard_id`, show a “Configure…” button.
- Wizard can update multiple settings atomically.

## Suggested top-level groups
- Access & Identity
- Networking
- Compute / Project Hosts
- Backups & Storage
- Payments & Billing
- Support / Integrations
- System / Advanced

## Migration strategy
1. Add schema fields (no UI changes).
2. Use group/subgroup/order for a few settings (pilot).
3. Update admin UI to read groups/subgroups and show advanced toggle.
4. Add group status and wizards.

## Pilot settings (first pass)
- Cloudflare Tunnel settings → group: Networking / subgroup: Cloudflare Tunnel
- Cloudflare R2 settings → group: Backups & Storage / subgroup: Cloudflare R2

This proves grouping without breaking existing tag-based filtering.
