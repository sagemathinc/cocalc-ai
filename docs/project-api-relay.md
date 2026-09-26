# Project API Relay

Network-disabled projects must still reach CoCalc's control plane and authorized
project data services. The project-host Conat router provides a restricted
HTTP/WebSocket reverse proxy using `http-proxy-3`. It does not enable arbitrary
Internet access or implement HTTP CONNECT.

## Routes and Trust

The relay is attached only to the existing host-local router listener. Projects
already reach that listener through their container network gateway. No firewall
or public ingress exception is added.

- `/_cocalc/api-relay/hub/conat/` connects to the canonical site or the account's
  configured home-bay API endpoint, not the source host's master bay.
- `/_cocalc/api-relay/hub/api/v2/...` supports ordinary HTTP API operations,
  including CLI login and approval polling.
- `/_cocalc/api-relay/host/<host-id>/<project-id>/conat/` connects to the target
  project host. The HTTP browser-session bootstrap endpoint is also supported.

For hub routes, a requested API base URL is only an allowlist lookup key. The
source host accepts its operator-configured site URL directly; other URLs must
exactly match cluster bay configuration returned by
`hosts.resolveProjectApiRelayHub`. There is no hostname-suffix wildcard,
caller-selected port/path, or arbitrary URL forwarding.

For cross-host routes, the caller supplies identifiers, never an upstream URL;
the source host asks `hosts.resolveProjectApiRelayTarget` using its existing
host-authenticated master connection. This metadata-only method checks placement
at the project's authoritative bay, then gets the endpoint from the host's
authoritative bay. Those bays can differ. Other bays are queried through the
inter-bay host-connection service. Steady-state
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
`CONAT_SERVER`, preserving the existing container gateway configuration. Profile
URLs, cookie naming and human approval links retain the original site/home-bay
URL. The host validates API destinations even when an explicit CLI profile selects
a different URL; unregistered destinations fail closed. Setting
`COCALC_API_RELAY=0` opts out of relay transport but does not change the project's
network policy.

Daemon reuse is keyed by the local transport, relay settings, project admission
and profile-file configuration as well as the CLI build. A daemon with stale
configuration is replaced automatically; enabling the relay in a new turn does
not require users to know about `--no-daemon`.

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
and a two-hour connection lifetime. There is no per-connection byte ceiling:
a 600 MiB read can complete if the account has sufficient traffic quota. Route caches are
bounded and expire after 30 seconds. Connection setup times out after 15 seconds;
destination metadata lookup has its own 10-second timeout.

Admission also uses token buckets before parsing routes or checking project
credentials: 12,000 attempts/minute per router and 2,400 per local socket peer,
with a one-minute burst capacity. Claimed project IDs do not select these
buckets. Containers may share the loopback peer, so this is a coarse shared
safety limit, not a substitute for authenticated per-project admission.

## Traffic Quota and Accounting

Relay traffic consumes the source project's authoritative usage account's
existing membership traffic quota, across both the five-hour and seven-day
windows. Both directions on the relayed leg are counted; reconnecting, changing
destination, or using multiple projects/hosts does not create another account
allowance. Local project operations that do not use the relay are unchanged.

`hosts.updateProjectApiRelayUsage` is host-authenticated. The source project's
owning bay verifies current host placement and derives the usage account; that
account's home bay performs quota reservations. Only small usage/allowance
messages cross the control plane, never the transferred file contents.

Each connection starts with at most 64 KiB of reserved credit. Busy streams grow
their credit to at most 4 MiB per renewal. Reservations debit the ordinary usage
counters transactionally, serialized per account, before the host forwards
bytes. Metered HTTP and upgraded-socket streams consume credit chunk by chunk,
pause with backpressure to renew, and stop both peers on quota exhaustion or
renewal failure. Credit expires after at most a minute or at a usage-window
boundary. Five-second updates report usage and re-evaluate active sessions;
the separate source-authorization timer is not used to count bytes.

Normal completion returns unused credit. Cumulative usage and monotonically
sequenced updates make exact retries idempotent. An unknown renewal is not
replaced by a different update at the same sequence. If a router crashes or
settlement is unavailable, its last unreported reservation remains conservatively
charged until the original quota windows expire (at most 4 MiB per connection),
rather than refunding bytes that might already have crossed the network.

Actual forwarded bytes appear in the existing traffic history/admin rollups
under `http-proxy` or `ws-proxy`, marked `source: api-relay`. Metadata identifies
the source project, usage account, source host, destination, session, directional
totals and completion reason. Host logs also record successful completion and
periodic usage; payloads, query strings and credentials are not logged. Counter
totals temporarily include outstanding reservations; history records reported
usage. Both are quota/visibility measurements, not cloud-provider invoices.

The accounting unit is forwarded HTTP body/upgraded-stream bytes, not exact
TLS/IP billing bytes. Transport buffers can receive data ahead of backpressure.
Existing non-relay metering retains its own reporting delay; these reservations
prevent concurrent relay sessions from independently spending the same known
remaining quota. Relay quota enforcement is mandatory even if legacy Conat
traffic sampling is disabled.

Rejected routes fail explicitly. HTTP redirects are not followed, and the CLI
does not replay admission credentials across redirects. Transport failure does
not retry a mutation or fall back to a more privileged identity. Long-lived
clients must tolerate connection closure, just as for a host restart.

## Rollout and Validation

Deploy the hub/inter-bay routing and quota methods to all bays, then the project-host/router bundle
and CLI tools bundle. The router must be rolled explicitly when upgrading the
managed runtime stack. Newly started projects receive the environment variables;
new Codex turns also inject them into existing runtimes. Existing ordinary shell
processes retain their old environment until refreshed.

Regression coverage includes real HTTP and Conat WebSocket connections, delayed
cross-host lookup alongside local Socket.IO, caller credential preservation,
source lifecycle revocation, path and quota rejection, and authoritative
cross-bay lookup. Real CLI subprocesses exercise local data commands while the
hub is unreachable.

Quota regressions include a streamed 600 MiB response, fast HTTP and upgraded
socket bursts in both directions before the first timer tick, pre-authentication
rate limiting, database reservation concurrency across hosts, idempotent retries,
unused-credit refunds and usage-window rollover. The live validation below
predates the quota follow-up; repeat it with the updated hub and router before
release.

Live validation on lite1b used a disposable free account, a network-disabled
project with a CoCalc rootfs, and a second project on another host/bay:

- Live Jupyter execution returned `5050` and saved the notebook.
- A site-funded `gpt-6-luna` first turn generated `sin(x^2)` and published a PNG
  card. A separate artifact read verified persistence, without a context timeout.
- Account sign-in checks, project listing and free-membership APIs succeeded
  with the QA account's original credential.
- Cross-host file upload/download produced matching SHA-256 checksums, and
  remote Jupyter status worked. Removing collaborator access denied file access.
- Unrelated HTTPS failed both by DNS name and with a fixed destination IP;
  non-API proxy paths and invalid upstream credentials were rejected.

These tests exercise container firewall behavior, not just mocked transports.
Repeat the suite when changing routing or auth boundaries. The relay does not
remove authorization requirements or make unrelated Internet-dependent commands
work in a network-disabled project.
