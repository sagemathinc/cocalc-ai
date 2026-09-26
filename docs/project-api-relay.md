# Project API Relay

Network-disabled projects must still reach CoCalc's control plane and authorized
project data services. The project-host Conat router provides a restricted
HTTP/WebSocket reverse proxy using `http-proxy-3`. It does not enable arbitrary
Internet access or implement HTTP CONNECT.

## Routes and Trust

The relay is attached only to the existing host-local router listener. Projects
already reach that listener through their container network gateway. No firewall
or public ingress exception is added.

- `/_cocalc/api-relay/hub/conat/` connects to the configured master Conat service.
- `/_cocalc/api-relay/hub/api/v2/...` supports ordinary HTTP API operations,
  including CLI login and approval polling.
- `/_cocalc/api-relay/host/<host-id>/<project-id>/conat/` connects to the target
  project host. The HTTP browser-session bootstrap endpoint is also supported.

The caller supplies identifiers, never an upstream URL. For cross-host routes,
the source host asks `hosts.resolveProjectApiRelayTarget` using its existing
host-authenticated master connection. This metadata-only method resolves the
host's authoritative bay and confirms the project is assigned there. Other
bays are queried through the inter-bay host-connection service. Steady-state
traffic then goes directly from source host to destination host. Local/on-prem
hosts retain their existing owning-hub reverse-tunnel path as the exception.

Transport admission requires the source project's current secret and a local
socket peer. Forwarded/public-ingress requests and exam projects are rejected.
The relay strips its admission headers before forwarding. The caller's original
cookie, bearer token, or Socket.IO auth payload is preserved; the relay never
substitutes a host or administrator credential for the caller. The destination
still checks all permissions, scopes, network memberships and fresh-auth rules.
Admission is periodically rechecked, including project deletion, stopping and
secret rotation. Upstream TLS certificate verification remains enabled.

## CLI Integration

Updated project environments advertise `COCALC_API_RELAY=1` and
`COCALC_API_RELAY_HUB_URL`. The CLI derives the local relay address from
`CONAT_SERVER`, preserving the existing container gateway configuration. Only
the configured site's API transport changes. Profile URLs, cookie naming and
human approval links retain the canonical site URL; unrelated explicit profiles
are not redirected.

Local artifacts, notebooks, files, terminals, document builds and backend scripts
connect to the current project's local service without signing in to the hub
first. A script that subsequently needs a hub API opens that connection lazily.
Cross-project operations still resolve ownership and acquire the caller's normal
destination credential before connecting through the relay.

This supplies connectivity, not additional authorization. Project-scoped tokens
remain project-scoped. Account management still needs an appropriately authorized
account credential and any required human approval. General web browsing, package
downloads, SSH tunneling and arbitrary project app proxying are not opened by
this feature.

## Bounds and Failure Behavior

The relay streams requests, responses and WebSocket bytes with backpressure.
Defaults are 1,024 concurrent connections per router, 64 per source project,
240 admitted attempts per project per minute, an 8 MiB HTTP request-body limit,
512 MiB per connection and a two-hour connection lifetime. Route caches are
bounded and expire after 30 seconds. Connection setup times out after 15 seconds;
destination metadata lookup has its own 10-second timeout.

Rejected routes fail explicitly. HTTP redirects are not followed, and the CLI
does not replay admission credentials across redirects. Transport failure does
not retry a mutation or fall back to a more privileged identity. Long-lived
clients must tolerate connection closure, just as for a host restart.

## Rollout and Validation

Deploy the hub/inter-bay method to all bays, then the project-host/router bundle
and CLI tools bundle. The router must be rolled explicitly when upgrading the
managed runtime stack. Newly started projects receive the environment variables;
new Codex turns also inject them into existing runtimes. Existing ordinary shell
processes retain their old environment until refreshed.

Regression coverage includes real HTTP and Conat WebSocket connections, delayed
cross-host lookup alongside local Socket.IO, caller credential preservation,
source lifecycle revocation, path and quota rejection, and authoritative
cross-bay lookup. Real CLI subprocesses exercise local data commands while the
hub is unreachable.

Before release, also exercise a network-disabled project on a real host: local
artifact and notebook operations, hub authentication/account APIs, a second
project on another host/bay, denial with insufficient destination credentials,
and failure of unrelated outbound HTTPS/DNS. Unit tests alone do not establish
container firewall behavior.
