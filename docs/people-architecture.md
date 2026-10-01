# People: product and architecture

People provides Conversations, Collaborators, Shared projects, Invites, Scan
Files, and personal URLs. Conversations reuse the existing chat editor and
message storage; they do not introduce a separate messaging system.

## Product contract

- Supported chat creation, editing, artifact publication, and filesystem writes
  durably register indexing work. Ordinary work appears without Scan.
- Opening People, membership changes, startup, and elapsed time never submit a
  filesystem scan. Manual Scan is an explicit, cancellable import of selected
  project storage, without starting project compute.
- Discovery and personal URLs never grant access. Current project ownership and
  membership authorize opens, source operations, and invitations.
- Personal collection, Follow, mute, unread state, invitations, access grants,
  and message notifications are independent. Participation alone is not Follow.
- Real notification obligations survive inactive recipients and worker restarts.
  Historical imports update discovery without manufacturing new-message alerts.
- The agent sidebar stays beside the project list and editors and remains
  toggleable. Returning to Projects, People, or Artifacts reveals the retained
  view and route rather than reconstructing only a selected file.

## Authority and data flow

The project owning bay owns membership, the catalog, source fences, canonical
room identity, and notification recipient obligations. Its assigned project host
reads project storage and extracts bounded metadata. The account home bay owns
personal state, invitation drafts, notification effects, and browser projections.
All cross-bay work uses explicit account/project/host routing. Project content
stays in the data plane; the catalog contains metadata, not message bodies.
Standalone Lite implements the same domain rules with local SQLite adapters.

```text
supported write -> durable source intent -> host extraction -> owner catalog
                                              -> revision hint -> demanded home

explicit Scan -> fd filename snapshot -> changed sources -> same source intent

real message -> owner recipient obligations -> current account home -> notification
```

An open People view renews account-home demand. Homes share a revision
subscription per project and bay, and project only into demanded accounts.
Membership scheduling uses the same durable queue. Notification delivery is
independent of demand and reauthorizes at the current project owner. Stable
receipts make retries safe after lost acknowledgments.

Project rehome transfers owner state and obligations, resets revision hints, and
schedules a new catalog generation. Account rehome transfers personal and
notification state. Neither operation carries an old authorization grant forward.
Hard deletion and exact owner settlement provide receipt reclamation evidence;
route absence, age, or summary flush does not.

## Manual Scan

The project host uses one bounded `fd` search for `.chat` files, including hidden
and ignored files, excluding `.snapshots`, without following links or crossing
filesystems. Legacy `.sage-chat` files are excluded. The source pipeline parses
live JSONL and registered archive history, resolves stable identities, threads,
participants, references and artifacts, and publishes catalog metadata.

Two project timestamps record scan start times: `last_success` and `last_fail`.
After success, only files modified at or after that baseline, or with changed
registered archive history, are selected. Deterministic file problems are skipped
and reported. Service failure, incomplete discovery, or cancellation preserves
the successful baseline. Host metadata loss or changed volume scope causes a full
scan. Preserved or manipulated modification times can hide external changes.

Account admission, project-owner authorization, and host execution remain distinct
boundaries. Exact execution identities, reservations, cancellation tombstones,
lost-reply recovery, and idempotent handoff are required. An unavailable or unknown
reply is never proof that host work stopped. Scan progress distinguishes skipped,
cancelled, unavailable, deferred and successfully indexed work.

## Enablement and release

`collaborators_enabled` defaults off. Hosted manual Scan additionally requires
`people_scan_enabled` and the explicit `COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE=1`
rollout gate. These gates select no older implementation. Disablement retains
captured work and permits inspection/cancellation; it does not authorize a new
scan or destroy user data.

Before customer enablement, close the owner-side notification admission, weighted
fanout/fairness, tighter `@all` rate budget, and aggregate Scan campaign capacity
and recovery gates described in [the review guide](people-review-guide.md).
Functional regression tests and private development checks are evidence of
behavior, not sustained-load or release approval.

Earlier prototype indexes and schema revisions are not a supported upgrade
contract. This implementation initializes the final schema directly. Development
cutover may reset derived indexes only after workers are quiesced and actual
in-flight work is resolved. Preserve chat files, messages, authored artifacts,
canonical user data, and all supported runtime recovery semantics.
