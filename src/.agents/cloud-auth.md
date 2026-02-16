# Cloud Auth (GCP OAuth + SA Impersonation)

## Goal

Provide a **no‑JSON‑keys** Google Cloud auth flow that is **project‑scoped** and safe for production (10k+ users). The auth should be as easy as copy/paste `gcloud` commands plus an in‑app OAuth connect + validation.

## Why this approach

- **Plain OAuth is not project‑scoped** → requires trust in app behavior.
- **Service Account JSON is project‑scoped** but requires long‑lived keys.
- **OAuth + Service Account Impersonation** gives project scoping **without long‑lived keys**.

## High‑level flow (UX)

1. **Admin selects Project ID**
2. **Admin runs gcloud quickstart** to create a service account (SA) and grant roles
3. **Admin grants themselves Token Creator on that SA**
4. **Admin clicks “Connect Google Cloud” (OAuth)**
5. **Admin enters Project ID + SA email**
6. **App validates** (Compute API enabled, monitoring enabled, SA roles ok, impersonation works)

## Step‑by‑step plan

### Phase 1 — Schema + settings

1. Add new settings to hold OAuth + impersonation config (server‑side only):
   - `gcp_project_id`
   - `gcp_sa_email`
   - `gcp_oauth_refresh_token`
   - `gcp_oauth_connected_at`
   - `gcp_last_validated_at`
   - `gcp_last_error`
2. Mark these settings **admin‑only** and **hidden/masked** in UI.

### Phase 2 — OAuth integration

1. Add “Connect Google Cloud” button in Admin → Project Hosts → Google Cloud.
2. OAuth scopes (minimal):
   - `https://www.googleapis.com/auth/cloud-platform`
   - (Optional) `https://www.googleapis.com/auth/iam` (if needed for impersonation checks)
3. Store refresh token securely on server.

### Phase 3 — SA Impersonation

1. Use OAuth refresh token to mint short‑lived access tokens.
2. Call IAM Credentials API to **impersonate** the service account:
   - `POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{SA_EMAIL}:generateAccessToken`
3. All Compute/Monitoring API calls should use **impersonated SA token**.

### Phase 4 — Validation + UI feedback

1. “Validate” button tests:
   - Compute Engine API enabled
   - Monitoring API enabled (if required)
   - SA has required roles
   - SA impersonation succeeds
2. Show green status + timestamp when valid.
3. Show specific errors with actionable guidance.

### Phase 5 — Production safety (hardening)

1. **Daily health check** (cron): attempt `compute.zones.list` using impersonation.
2. **Alert** admin if auth fails:
   - UI banner in admin settings
   - Optional email alert
3. Expose status fields:
   - `Connected since` + `Last validated`
   - `Last error`

### Phase 6 — gcloud quickstart (wizard)

Include a collapsible “Quickstart” block with commands and comments:

```bash
# 1) Set project
PROJECT_ID="my-gcp-project"
gcloud config set project "$PROJECT_ID"

# 2) Create service account
SA_NAME="cocalc-host"
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="CoCalc Host Manager"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# 3) Grant required roles
# Compute Admin
 gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/compute.admin"

# Service Account User (attach SA to VMs)
 gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser"

# Monitoring Viewer (optional)
 gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/monitoring.viewer"

# 4) Allow YOUR USER to impersonate the SA
USER_EMAIL="you@example.com"
 gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --member="user:${USER_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

### Phase 7 — Cutover plan

1. Implement OAuth/impersonation path side‑by‑side with existing JSON method.
2. Add admin toggle: **“Use OAuth + SA impersonation (recommended)”**.
3. In future: deprecate JSON keys (optional).

## Security notes

- OAuth scopes are not project‑scoped. Hard scoping comes from SA impersonation.
- SA exists only inside one project → cannot affect other projects.
- No long‑lived JSON keys on disk.

## Operational notes

- Refresh tokens generally persist indefinitely unless revoked.
- Impersonation tokens are short‑lived, but renewable.
- Add explicit logging + admin alert for auth failures.

## Success criteria

- Admin can complete setup in <5 minutes using gcloud quickstart.
- Validation reports API/role errors clearly.
- Auth remains stable over time; failures produce alerts and UI warnings.