# Bounded Attachments And External Sender Login

Updated September 15, 2026. Worktree `/home/user/scratch/agent-mentions`, branch
`feature/agent-mentions`.

## Status

**Native attachments and fail-fast admission are deployed on lite1b's three bays
and two QA hosts. Real cross-host/cross-bay 32 MiB and stopped-target tests pass.
External agent login is not usable yet.** Same-project smoke testing exposed an
optional-argument wire bug; its committed fix now passes live verification too.

There is no identified external blocker to continuing implementation. The old
browser fresh-auth renewal test does not block this work. The remaining items
below are unfinished engineering, not requests for user action.

## Implemented And Tested

- Destination admission: four concurrent operations per host, two per project,
  shared across per-call service facades. Overload rejects without waiting.
  Pending startup retains its slot after caller timeout until actual work settles.
- Structured startup/admission failure codes, including disabled automatic starts,
  sponsor slots, unavailable startup, overload, deadlines, and ambiguous execution
  acknowledgment. No capacity-wait scheduler or automatic message retry.
- Opt-in Conat raw-fragment byte/count bounds before concatenation and decoding,
  plus bounded receive queues. The agent metadata subscription uses 128 KiB per
  message, 4 MiB incomplete reassembly, 32 incomplete messages and a 32-message
  queue when binary attachments are disabled. With the separate attachment flag,
  ingress accepts 33 MiB messages, 132 MiB incomplete reassembly, four partial
  messages, four queued requests and four active handlers. These wire bounds are
  not a whole-process RSS guarantee.
- Repeatable scoped CLI `--attach` for same-project live file references, checked
  again by the receiver before chat insertion and bound into attempt conflict
  detection. Cross-project attachments use metadata preparation followed by one
  binary submission; no text-only or broad human-credential fallback.
- Snapshot validation and source reads: 32 MiB total, 16 regular files, bounded
  UTF-8 basenames, exact metadata and SHA-256 checks. Reads remain bounded if a
  file grows. Symlinks, devices, directories and base64 substitutes are rejected.
  Payloads use native `Uint8Array`/`Buffer`.

Connected through the scoped CLI, account-home/project-owner routing and shared
project-host receiver:

- `AgentAttachmentReservations`: metadata-only preparation/startup with a maximum
  30-second lifetime, binding to source/target/principal/run/link/attempt/body/
  manifest, single claim, cancellation, and authorization rechecks around staging.
  It uses a supplied shared `AgentRpcCapacity`. Expiry cannot release resources
  still doing I/O or authorize late execution. Lost acknowledgments retain files
  for possibly accepted work; nothing automatically resubmits.
- `stageAgentAttachments`: writes via a supplied sandboxed destination project FS
  into random `/tmp/cocalc-agent-attachments-<uuid>` directories. Numbered child
  directories preserve duplicate basenames. A byte-free manifest records actual
  local paths. No archive extraction. Partial writes are cleaned up; cleanup
  failures are visible. The helper itself never starts a project or agent.

The recipient validates its thread and normal startup policy before returning
readiness, then checks startup/authorization again before writing files. The bay
and host retain metadata-only, expiring reservations, not a messaging outbox.
Submission consumes the reservation; startup can finish after timeout but cannot
submit a late message. Authorization permits never contain file bytes.

Retention deliberately uses the existing finite project scratch quota and project
restart cleanup, not a separate managed budget or retention scheduler. Failed
staging is removed; files for possibly accepted work remain. A host restart is not
a project scratch reset: files may survive it, but in-memory preparations do not.
Accepted attachments are ephemeral, not a durable archive; queued work that loses
its files on project restart must not assume those files are still available.
The prompt supplies actual local paths and tells the recipient to copy files into
the project home when it needs durable retention. No 24-hour cleanup is promised.

Enable `COCALC_AGENT_MESSAGING_ATTACHMENTS_ENABLED=1` on participating hubs and
hosts only after deploying the new code. Text-only messaging retains its existing
flags. General host-control ingress permits 65 MiB messages to preserve existing
64 MiB copy archives, with bounded partial reassembly and queueing.

## Reproduction

Latest focused results: 94 Conat tests, 34 receiver-service tests, 64 server tests
and 11 CLI tests passed. Conat/Lite/server/CLI/project-host TypeScript builds and
host/project/tools bundle builds passed. The final optional-argument correction
also passes all 19 routed server tests. Live evidence is recorded separately below.

Run from this worktree:

```sh
pnpm -C src/packages/conat exec tsc --build
pnpm -C src/packages/conat exec jest agents/attachment-reservations.test.ts agents/attachment-staging.test.ts agents/attachments.test.ts agents/attachments-integrity.test.ts agents/rpc-capacity.test.ts agents/rpc-attempts.test.ts core/receive-budget.test.ts core/receive-limits.test.ts --runInBand
pnpm -C src/packages/lite exec jest hub/acp/__tests__/agent-rpc-service.test.ts --runInBand
env NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server exec jest agents/rpc.integration.test.ts agents/personal-store.integration.test.ts agents/personal-rehome.integration.test.ts agents/retired-delivery.test.ts --runInBand
pnpm -C src/packages/cli exec tsc -p tsconfig.test.json
node --test src/packages/cli/build/test/cli/src/bin/core/agent-attachments.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat.test.js
```

Staging tests write actual temporary files using a test filesystem adapter.
Combined tests cover prepare/start, file staging, execution acknowledgment and
lost acknowledgment. A separate real Conat test routes a native 32 MiB binary
payload through home/source/target bay services, checks full SHA-256 integrity,
rejects a changed body, and rejects reuse of consumed readiness. Its host
execution adapter is mocked; it does not prove deployed routing or real agents.
Negative tests include quota failure, partial/manifest writes, duplicate names,
directory collisions, invalid digests, revocation, startup/I/O expiry, conflicting
principals/content, and concurrent claims.

No frontend changes have been made in this increment.

## September 15 Live Evidence

Source: `messaging-qa`, project `1ce4fe78-19c7-40a8-a598-947975744cd9`,
`/home/user/human-turn-qa-1789350561320.chat`, host-1/bay-0.
Receiver: `reviewer`, project `66db94af-0745-4088-b922-879c58942201`,
`/home/user/recv.chat`, QA host/bay-1. Source agents used the installed CLI and
their actual per-turn scoped identity. A first-party dev fresh-auth session at
the human's home origin approved a new one-hour QA grant, not database grant edits.

| Attempt                                | Outcome                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `29ccbd48-4c82-4495-81ff-73c182557370` | 32 MiB cross-host/cross-bay: sender accepted; recipient executed and verified 33,554,432 bytes and SHA-256 `70c4eaba55c4010d636ac5b46ee640423ddcd44736057ad95429ea4fa4440e8a`.                          |
| `e0a377d0-300d-4c00-b48b-405141c56576` | Receiver explicitly stopped first; send started it, was accepted, and recipient verified the 4,096-byte snapshot and digest.                                                                            |
| `453e0066-e361-4ee3-8f12-ea1fd34e9c21` | Receiver stopped with automatic starts disabled: rejected with `autostart_disabled`, no receiver message, project remained stopped.                                                                     |
| `f6393b38-b9a2-4314-8981-c7df45d214df` | Same-project reference returned unknown; investigation found undefined optional binary argument encoded as null. No receiver message. Fix `7bf8e885d2` omits that argument; do not replay this attempt. |
| `effabb86-1858-40a8-aa5c-534ae292b10f` | New same-project attempt after the fix: accepted; recipient read the original live path and verified 4,096 bytes and SHA-256 `4f7ddd35f27e5469457dbec653aa6fd5004a257b99f16689e5f3f8baf5aaa4d0`.        |

For the disabled-start test only, the authoritative bay-1 database's
`autostart_enabled` was temporarily changed from null to false, then restored to
null. The project was started again through the normal CLI. No account, token,
grant or execution permission was changed for this negative test.

Deployment: hubs use this worktree; both host runtimes and all four managed
components were observed aligned at `20260915T022242Z-8c6cb4ef6ebf` after the error
classification fix. Project bundle selection is `1789438248171`, tools
`1789438254143`. All three hubs were restarted for server-only fix `7bf8e885d2`;
that fix requires no further host/tools change.

Operational issues encountered and resolved:

- The receiver host upgrade CLI watcher timed out with unknown status, but typed
  deployment inspection and process paths proved successful installation and
  component alignment. No duplicate upgrade was submitted for that operation.
- I initially installed host overrides as root-only readable. This hid the new
  flag and, on runtime reload, the receiver's bay-routing override. Corrected to
  root-owned, runtime-group-readable mode 0640 and restarted via `ctl`; verified
  the flag and correct bay-1 origin in the running host environment. No credential
  copying was used. Earlier failed QA attempts were not replayed.

Ignored reproducible QA driver: `src/.local/attachment-qa.cjs`; its state file
records attempts before submission and refuses replay. Evidence logs:
`/tmp/agent-attachment-qa-{max,stopped,autostart-disabled}-inspect.jsonl`.
Load the normal dev hub environment, then use `node .local/attachment-qa.cjs
inspect LABEL` for inspection only. New sends use `send NEW_LABEL`; these require
a still-valid explicit QA grant and intentionally run real agents. The full
32 MiB case uses label `max` and has already run; do not reuse it.

## Next Concrete Steps

1. Connect external enrollment to the existing CLI-auth challenge/browser flow,
   using a distinct challenge kind that cannot redeem a human session. The client
   generates a 256-bit secret; approval binds its hash and challenge ID to the
   installation. Only fresh human approval creates account-owned agent records.
2. Add narrowly scoped external Conat authentication, account-home routing,
   discovery, and native receiver submission. Carry the external source kind and
   installation explicitly; never manufacture a project or native run identity.
3. Test external credential expiry/revocation, no native impersonation, no broad
   account fallback, and cross-bay sends with attachments. Federation remains out.

## External Login: Backend Lifecycle Only

The protocol and `server/agents/external-store.ts` now implement the internal
approved-installation lifecycle. The new canonical schema is in
`util/db-schema/agent-external.ts`. These modules are not connected to public
endpoints, socket authentication, the CLI or browser UI and have not been enabled
or live-tested as external login. This is not yet a sending implementation.

Implemented boundaries:

- A distinct stable external UUID can have independent installations. Revoking
  one installation retains the identity and history; disabling the identity
  invalidates every installation. Native/other-account UUIDs cannot be enrolled.
- Only credential hashes are stored. Normal human sessions and native agent
  credentials are not accepted as external credentials. Installation labels are
  display metadata, not native `@` addresses or receiving endpoints.
- Fresh approval binds at most 32 explicit native destinations and a finite
  lifetime of at most 30 days. This prototype permits sending, not receiving or
  guidance. Repeating approval cannot extend expiry, widen scope or revive a
  revoked installation. No file-browsing authority is granted.
- Account-home transaction fencing, account security/session revocation,
  personal pause/revoke-all and fresh-auth rechecks apply. Destination permission
  validation is injected from the owner-routing layer and must not start work.
  Admission rechecks installation authority after remote validation.
- Anonymous challenges must remain in the existing CLI-auth challenge flow.
  They do not create personal controls or persistent external installations.
  Retained approved external state blocks account rehome until portability exists.

Latest verification: 13 protocol tests, 13 external store integration tests and
60 existing personal/routed integration tests passed, along with the server
TypeScript build. Fresh-auth and account-home adapters are mocked in the new
store tests; existing home-fence tests also pass, but this is not a browser
fresh-auth or cross-bay external-login demonstration.

```sh
pnpm -C src/packages/conat exec jest agents/external.test.ts --runInBand
env NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server exec jest agents/external-store.integration.test.ts agents/personal-store.integration.test.ts agents/personal-rehome.integration.test.ts agents/rpc.integration.test.ts --runInBand
```

Use distinct stable external identities and installation credentials, not fake
project IDs or native-thread impersonation. Reuse first-party browser login and
fresh-auth approval, with account-home ownership and expiring/revocable send-only
authority. Native identity/run/endpoint and personal-name/grant checks currently
assume a project-backed source; extend those checks deliberately, not by bypass.
Remote credentials must not become ambient authority for other humans' turns.

Two independent enrollments can connect native agents on two CoCalc sites; each
destination wakes its own native recipient. No new receiver daemon or general
federation is necessary. Arbitrary-computer receiving and federation stay deferred.
