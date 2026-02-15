# Findings (ordered by severity)

Status labels:

- `done`: addressed in code.
- `pending`: not yet addressed.
- `partial`: improved but residual risk remains by design/config.
- `wontfix`: accepted risk / intentional design choice.

## High

1. (`done`) Unscoped `trust proxy` can make IP-based controls spoofable if forwarding headers are not strictly sanitized.
   - Code: [src/packages/hub/servers/express-app.ts](./src/packages/hub/servers/express-app.ts) (`app.enable("trust proxy")`)
   - Downstream effects:
     - Metrics allowlist decisions by `req.ip` in [src/packages/hub/servers/app/metrics.ts](./src/packages/hub/servers/app/metrics.ts)
     - Sign-in throttle by `req.ip` in [src/packages/next/pages/api/v2/auth/sign-in.ts](./src/packages/next/pages/api/v2/auth/sign-in.ts)
   - Status details:
     - Hub now uses strict proxy trust only when Cloudflare tunnel mode is enabled.
     - Otherwise proxy trust is disabled (uses direct socket address).
     - Residual risk is operational/config drift (e.g., exposing hub directly while assuming tunnel mode semantics).

2. (`done`) Reflected error content in proxy request error path may allow reflected XSS in error responses.
   - Code: [src/packages/hub/proxy/handle-request.ts](./src/packages/hub/proxy/handle-request.ts)
   - Status details:
     - Reflected values are now HTML-escaped.
     - Error response includes `X-Content-Type-Options: nosniff`.

## Medium-High

3. (`done`) Conat auth-failure rate limiting keys off address values that trust forwarded headers.
   - Code: [src/packages/conat/core/server.ts](./src/packages/conat/core/server.ts) (`getAddress`)
   - Status details:
     - Conat now supports strict-cloudflare address mode.
     - In strict mode, forwarded headers are only trusted from loopback proxy peers.
     - Added address-resolution tests in [src/packages/conat/core/get-address.test.ts](./src/packages/conat/core/get-address.test.ts).
   - Relevance: `/conat` is exposed to untrusted internet clients in both hub and project-hosts.

4. (`done`) Unauthenticated Conat sockets were previously retained after auth failure.
   - Code: [src/packages/conat/core/server.ts](./src/packages/conat/core/server.ts)
   - Impact: avoidable socket/resource retention and potential contribution to observed socket leak.
   - Status details:
     - Auth failures now send one explicit `info` message and force disconnect.
     - Cleanup runs on `disconnecting` so tracked sockets/stats are removed.
     - Regression test: [src/packages/backend/conat/test/core/auth-failure.test.ts](./src/packages/backend/conat/test/core/auth-failure.test.ts).

## Medium

5. (`done`) Upload endpoint has effectively unbounded lifecycle for in-memory upload state.
   - Code: [src/packages/hub/servers/app/upload.ts](./src/packages/hub/servers/app/upload.ts)
   - Status details:
     - Added bounded max wait (env-configurable, 6h default).
     - Added TTL scavenging for upload state.
     - Added hard cap with oldest-entry eviction for in-memory upload state.
     - Added explicit cleanup path for completed/error uploads.

6. (`done`) Blob upload route lacks explicit throttling/rate limits.
   - Code: [src/packages/hub/servers/app/blob-upload.ts](./src/packages/hub/servers/app/blob-upload.ts)
   - Status details:
     - Added per-account and per-IP in-memory short/long window rate limits.
     - Returns `429` on limit violations.
     - Limits are env-configurable.

7. (`wontfix`) Bootstrap master Conat token TTL is very long.
   - Code: [src/packages/hub/servers/app/project-host-bootstrap.ts](./src/packages/hub/servers/app/project-host-bootstrap.ts)
   - Current setting: 1 year for bootstrap-issued master token.
   - Decision: intentional for operational simplicity in this deployment; accepted risk.

## Low

8. (`pending`) Missing baseline HTTP hardening headers at hub app layer.
   - Code: [src/packages/hub/servers/express-app.ts](./src/packages/hub/servers/express-app.ts)
   - Opportunity: add conservative `helmet` defaults tuned for existing app behavior.

9. (`pending`) API v2 cookie parsing is brittle for malformed cookie fragments.
   - Code: [src/packages/next/lib/api-v2-router.ts](./src/packages/next/lib/api-v2-router.ts)
   - Issue: direct `decodeURIComponent` without guard.

---

## Environment notes from review

- Hub is behind Cloudflare proxying.
- `/conat` is intentionally internet-exposed (hub and project-hosts).
- Forwarded-header trust is now fail-closed by default and only enabled in strict-cloudflare mode when tunnel mode is enabled.
