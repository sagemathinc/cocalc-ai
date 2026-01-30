# Managed Cloudflare (Spec + Plan)

Goal: provide a **zero‑config** Cloudflare option for paying customers so they
can enable public access + backups without creating any Cloudflare accounts or
keys. The hub calls a small control service that provisions tunnel + DNS + R2,
then returns scoped credentials. This is intentionally minimal and familiar.

---

## Scope (v1)

- **Single admin toggle**: "Enable Managed Cloudflare".
- **Zero user keys**: users never see Cloudflare creds.
- **One bucket per account** (R2), one tunnel per hub.
- **One DNS hostname** under `*.cocalc.ai` (generated, no custom domains) for their hub; additional DNS for each workspace host.
- **Hub‑managed health**: hub reports Ready/Degraded/Error.
- **Disable**: stop tunnel + revoke keys; optional delayed bucket deletion.

Out of scope (v1):

- Custom domains.
- Multiple regions or per‑host buckets.
- SSO/SSO‑less separation.
- Any user‑level control of Cloudflare settings.

---

## Architecture Summary

```
Hub ──(auth’d API)──> Managed‑CF Service
Hub <──(token+creds)── Managed‑CF Service
Hub ──cloudflared──> Cloudflare Tunnel
Hub ──rustic (R2 creds)──> R2 Bucket
```

---

## API (Managed‑CF Service)

All endpoints require a hub‑to‑service auth token (shared secret).

### POST /v1/managed-cloudflare/enroll

Idempotent. Creates or returns existing resources.

(NOTE: the paid software license id is relevant.)

Request:

- `account_id` (string)
- `hub_id` (string)
- `requested_subdomain` (optional; otherwise generated)

Response:

- `tunnel_id`
- `tunnel_token`
- `hostname` (e.g., `acme-123.cocalc.ai`)
- `r2_endpoint`
- `r2_bucket`
- `r2_access_key_id`
- `r2_secret_access_key`

### GET /v1/managed-cloudflare/status?hub_id=...

Response:

- `enabled` (bool)
- `hostname`
- `tunnel_id`
- `r2_bucket`
- `last_health_check`
- `errors` (array)

### POST /v1/managed-cloudflare/rotate-keys

Request: `hub_id`
Response: new `r2_access_key_id`, `r2_secret_access_key`.

### POST /v1/managed-cloudflare/disable

Request:

- `hub_id`
- `delete_bucket` (bool)
- `retention_days` (optional)
Response: `ok`

---

## Hub Integration (Spec)

### Settings

New settings (server):

- `managed_cf_enabled` (bool)
- `managed_cf_hostname` (string)
- `managed_cf_tunnel_token` (secret)
- `managed_cf_r2_bucket` (string)
- `managed_cf_r2_access_key_id` (secret)
- `managed_cf_r2_secret_access_key` (secret)

### Enable flow

1) Hub calls `enroll`.
2) Hub stores returned secrets.
3) Hub starts cloudflared with the tunnel token.
4) Hub configures rustic to use R2 creds.
5) Hub checks health (DNS resolve + R2 read/write).
6) UI shows Ready or Degraded.

### Disable flow

1) Stop cloudflared.
2) Call `disable`.
3) Clear secrets in settings (keep status note).

### Startup

If enabled:

- Verify tunnel and R2 creds.
- Show status banner in UI if degraded.

---

## Security + Billing

- Master Cloudflare token stays **only** in the managed‑CF service.
- Issue **bucket‑scoped** R2 keys per account.
- Track bucket usage + ops for billing.
- Retention policy on disable: default 30 days (configurable).

---

## Implementation Plan

### Phase 1: Managed‑CF Service

- [ ] Create a tiny service (node.js) that holds Cloudflare master creds.
  - This can run as part of the hub, to make development really easy.
- [ ] Implement the 4 endpoints above.
- [ ] Provision:
  - [ ] Cloudflare tunnel + token
  - [ ] DNS record under `*.cocalc.ai`
  - [ ] R2 bucket (1 per account)
  - [ ] Scoped R2 API keys
- [ ] Add health checks and idempotency.

### Phase 2: Hub Wiring

- [ ] Add server settings fields.
- [ ] Add “Enable Managed Cloudflare” toggle in admin UI.
- [ ] Implement enable/disable flow with status.
- [ ] Start/stop cloudflared based on settings.
- [ ] Configure rustic to use managed R2 bucket.
- [ ] Add readiness checks and UI status.

### Phase 3: UX + Safety

- [ ] Status banner: Ready / Degraded / Error.
- [ ] Add “Rotate keys” action.
- [ ] Add “Disable + retain data for N days” action.

### Phase 4: Billing Hooks (later)

This is when we also support uses spinning up resources on clouds we integrate, we pay, then they reimburse us.  This is out of scope for v1.

- [ ] Usage metrics pipeline (bucket size + ops).
- [ ] Monthly invoice line item.

---

## Notes / Open Questions

- Decide on a single default R2 region (simplify).
- Decide if `hub_id` should be stable across re‑installs.
- Choose a deletion policy for buckets on disable.

---

## Design Notes: Hub Cloudflared Automation (Launchpad)

Goal: when Launchpad runs with Cloudflare tunnel settings enabled, the hub
should automatically provision and run **one** Cloudflare tunnel that proxies
**all HTTP traffic** to the hub (admin UI + user UI + project‑host bootstrap).

### Preconditions

- Launchpad mode.
- `Project Hosts: Cloudflare Tunnel - Enable` is true.
- `Project Hosts: Cloudflare Tunnel - Account ID` and `API Token` set.
- `Project Hosts: Domain name` set (zone base, e.g. `cocalc.ai`).
- `External Domain Name` set (subdomain that will be proxied, e.g. `lp-123.cocalc.ai`).
- `cloudflared` installed on the hub host.

If any of the above are missing, we **do not** start the tunnel. We log a
clear error and surface a UI warning for admins.

### Tunnel Provisioning

- Ensure a tunnel exists (create if needed) using Cloudflare API.
- Create/update DNS for the **external domain** to point at the tunnel.
- Store tunnel metadata + credentials locally in the hub secrets directory.

### cloudflared Runtime

- Use `cloudflared tunnel run --credentials-file <path>` with a local config file.
- Config ingress proxies all HTTP traffic to the hub port.
- If only HTTPS is available locally, set `originRequest.noTLSVerify: true`.

### Admin Visibility

- Console logs clearly indicate missing config or process failures.
- Admin UI shows a banner when tunnel is enabled but not healthy.
