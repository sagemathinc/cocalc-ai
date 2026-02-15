# Findings (ordered by severity)

## High

1. Unscoped `trust proxy` can make IP-based controls spoofable if forwarding headers are not strictly sanitized.
   - Code: [src/packages/hub/servers/express-app.ts](./src/packages/hub/servers/express-app.ts) (`app.enable("trust proxy")`)
   - Downstream effects:
     - Metrics allowlist decisions by `req.ip` in [src/packages/hub/servers/app/metrics.ts](./src/packages/hub/servers/app/metrics.ts)
     - Sign-in throttle by `req.ip` in [src/packages/next/pages/api/v2/auth/sign-in.ts](./src/packages/next/pages/api/v2/auth/sign-in.ts)
   - Given your deployment answer (Cloudflare in front), this is mitigated only if traffic is strictly limited to trusted proxy ingress and untrusted direct access to hub is impossible.
     - NOTE: that actually **is** the case; the hub's untrusted ingress is only on localhost.

2. Reflected error content in proxy request error path may allow reflected XSS in error responses.
   - Code: [src/packages/hub/proxy/handle-request.ts](./src/packages/hub/proxy/handle-request.ts)
   - Issue: builds HTML response including unsanitized `req.url` and error string.

## Medium-High

3. Conat auth-failure rate limiting keys off address values that trust forwarded headers.
   - Code: [src/packages/conat/core/server.ts](./src/packages/conat/core/server.ts) (`getAddress`)
   - Risk: attacker can rotate/spoof apparent source addresses if forwarded headers are not trusted/scrubbed correctly.
   - Relevance: `/conat` is exposed to untrusted internet clients in both hub and project-hosts.

4. Unauthenticated Conat sockets were previously retained after auth failure.
   - Code: [src/packages/conat/core/server.ts](./src/packages/conat/core/server.ts)
   - Impact: avoidable socket/resource retention and potential contribution to observed socket leak.
   - Status: fixed in this branch by immediately disconnecting after one explicit auth-failure `info` message.

## Medium

5. Upload endpoint has effectively unbounded lifecycle for in-memory upload state.
   - Code: [src/packages/hub/servers/app/upload.ts](./src/packages/hub/servers/app/upload.ts)
   - Details: 7-day max wait and global maps (`errors`, `finished`, `streams`) with no hard cap/TTL-based scavenging.

6. Blob upload route lacks explicit throttling/rate limits.
   - Code: [src/packages/hub/servers/app/blob-upload.ts](./src/packages/hub/servers/app/blob-upload.ts)
   - Note: source has TODO indicating missing limits.

7. Bootstrap master Conat token TTL is very long.
   - Code: [src/packages/hub/servers/app/project-host-bootstrap.ts](./src/packages/hub/servers/app/project-host-bootstrap.ts)
   - Current setting: 1 year for bootstrap-issued master token.

## Low

8. Missing baseline HTTP hardening headers at hub app layer.
   - Code: [src/packages/hub/servers/express-app.ts](./src/packages/hub/servers/express-app.ts)
   - Opportunity: add conservative `helmet` defaults tuned for existing app behavior.

9. API v2 cookie parsing is brittle for malformed cookie fragments.
   - Code: [src/packages/next/lib/api-v2-router.ts](./src/packages/next/lib/api-v2-router.ts)
   - Issue: direct `decodeURIComponent` without guard.

---

## Environment notes from review

- Hub is behind Cloudflare proxying.
- `/conat` is intentionally internet-exposed (hub and project-hosts).
- Because of that, forwarded-header trust must be explicitly fail-closed to trusted proxy sources; otherwise auth-throttle and allowlist controls are weaker than expected.